/**
 * Metrics Store
 *
 * Manages computed graph metrics, visual mappings, and computation state.
 * Coordinates with the worker pool for background metric calculations.
 */

import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type {
  ComputedMetric,
  ComputationMetrics,
  ComputationHistoryEntry,
  VisualMapping,
  SizeMapping,
  WeightMapping,
  ColorMapping,
  ScaleType,
  GraphInfo,
  ResourceMetrics,
  WorkerPoolConfig,
  Priority,
} from '@/types/metrics';
import {
  DEFAULT_VISUAL_MAPPING,
  getDefaultWorkerPoolConfig,
  calculateStats,
  isNumericMetric,
} from '@/types/metrics';
import type { MetricValue } from '@/types/metrics';
import type { MetricResolver } from '@/utils/labelFormatter';
import { useGraphStore } from './graph';

export const useMetricsStore = defineStore('metrics', () => {
  const graphStore = useGraphStore();

  // ============================================================================
  // Computed Metrics Storage
  // ============================================================================

  /** All computed metrics, keyed by metric ID */
  const computedMetrics = ref<Map<string, ComputedMetric>>(new Map());

  /** Active computations (running, queued, paused) */
  const activeComputations = ref<Map<string, ComputationMetrics>>(new Map());

  /** History of completed/cancelled/errored computations */
  const computationHistory = ref<ComputationHistoryEntry[]>([]);

  /** Metric ids exposed as virtual columns in the Data Table (session-only) */
  const tableMetricIds = ref<Set<string>>(new Set());

  /**
   * Bumped whenever a metric's VALUES change (complete / upsert / delete /
   * clear). Consumers that key their watchers on `computedMetrics.size` miss a
   * recompute that replaces a same-size Map — watch this instead.
   */
  const metricsVersion = ref(0);

  // ============================================================================
  // Visual Mapping Configuration
  // ============================================================================

  const visualMapping = ref<VisualMapping>({
    nodeSize: { ...DEFAULT_VISUAL_MAPPING.nodeSize },
    nodeColor: { ...DEFAULT_VISUAL_MAPPING.nodeColor },
    edgeWeight: { ...DEFAULT_VISUAL_MAPPING.edgeWeight },
    enableRealTimeUpdates: DEFAULT_VISUAL_MAPPING.enableRealTimeUpdates,
  });

  // ============================================================================
  // Resource Configuration & Monitoring
  // ============================================================================

  const workerPoolConfig = ref<WorkerPoolConfig>(getDefaultWorkerPoolConfig());

  const resourceMetrics = ref<ResourceMetrics>({
    activeWorkers: 0,
    maxWorkers: workerPoolConfig.value.maxWorkers,
    queuedTasks: 0,
    memory: {
      usedHeapMB: null,
      totalHeapMB: null,
      heapLimitMB: null,
    },
    computations: [],
  });

  // ============================================================================
  // Graph Info (computed from current graph)
  // ============================================================================

  const graphInfo = computed<GraphInfo>(() => {
    const nodes = graphStore.filteredNodes;
    const edges = graphStore.filteredEdges;

    // Count edge types
    const edgeTypeCounts = new Map<string, number>();
    for (const edge of edges) {
      const type = edge.relationship_type;
      edgeTypeCounts.set(type, (edgeTypeCounts.get(type) || 0) + 1);
    }

    // Calculate density: E / (N * (N-1)) for directed graphs
    const n = nodes.length;
    const maxEdges = n * (n - 1);
    const density = maxEdges > 0 ? edges.length / maxEdges : 0;

    // Calculate connected components using Union-Find
    const componentCount = calculateComponentCount(nodes, edges);

    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      componentCount,
      density,
      isConnected: componentCount <= 1,
      edgeTypeCounts,
    };
  });

  // ============================================================================
  // Built-in Metrics (auto-computed from graph structure)
  // ============================================================================

  /** Built-in degree metric — always available when graph has edges */
  const builtInDegreeMetric = computed<ComputedMetric | null>(() => {
    const degrees = graphStore.nodeDegrees;
    if (degrees.size === 0) return null;

    const valuesArray = Array.from(degrees.values());
    const stats = calculateStats(valuesArray);

    return {
      id: '__builtin_degree',
      name: 'Degree',
      algorithmId: '__builtin',
      target: 'node',
      valueType: 'number',
      values: new Map(degrees),
      min: stats.min,
      max: stats.max,
      mean: stats.mean,
      stdDev: stats.stdDev,
      computedAt: 0,
      params: {},
      edgeTypeFilter: [],
      elapsedMs: 0,
    };
  });

  /** Map of all built-in metrics by ID */
  const builtInMetrics = computed(() => {
    const map = new Map<string, ComputedMetric>();
    const degree = builtInDegreeMetric.value;
    if (degree) map.set(degree.id, degree);
    return map;
  });

  // ============================================================================
  // Computed Properties
  // ============================================================================

  /** Metrics available for node size mapping (built-in + user-computed) */
  const nodeMetrics = computed(() => {
    const builtIn = Array.from(builtInMetrics.value.values()).filter(
      (m) => m.target === 'node'
    );
    const userComputed = Array.from(computedMetrics.value.values()).filter(
      (m) => m.target === 'node'
    );
    return [...builtIn, ...userComputed];
  });

  /** Metrics available for edge weight mapping */
  const edgeMetrics = computed(() => {
    const builtIn = Array.from(builtInMetrics.value.values()).filter(
      (m) => m.target === 'edge'
    );
    const userComputed = Array.from(computedMetrics.value.values()).filter(
      (m) => m.target === 'edge'
    );
    return [...builtIn, ...userComputed];
  });

  /** Node metrics whose values are numbers — the only ones that can drive size */
  const numericNodeMetrics = computed(() => nodeMetrics.value.filter(isNumericMetric));

  /** Edge metrics whose values are numbers — the only ones that can drive width */
  const numericEdgeMetrics = computed(() => edgeMetrics.value.filter(isNumericMetric));

  /** Node metrics flagged to appear as Data Table columns */
  const tableNodeMetrics = computed(() =>
    nodeMetrics.value.filter((m) => tableMetricIds.value.has(m.id))
  );

  /** Edge metrics flagged to appear as Data Table columns */
  const tableEdgeMetrics = computed(() =>
    edgeMetrics.value.filter((m) => tableMetricIds.value.has(m.id))
  );

  /** Currently selected node size metric (checks built-in + user-computed).
   * Null when the selected metric is not numeric — the renderer's contract is
   * Map<string, number>, and a string metric cannot size anything. */
  const nodeSizeMetric = computed(() => {
    const id = visualMapping.value.nodeSize.metricId;
    if (!id) return null;
    const m = builtInMetrics.value.get(id) || computedMetrics.value.get(id) || null;
    return m && isNumericMetric(m) ? m : null;
  });

  /** Currently selected node color metric — same numeric-only contract as
   * nodeSizeMetric: a string/boolean metric cannot drive the gradient. */
  const nodeColorMetric = computed(() => {
    const id = visualMapping.value.nodeColor.metricId;
    if (!id) return null;
    const m = builtInMetrics.value.get(id) || computedMetrics.value.get(id) || null;
    return m && isNumericMetric(m) ? m : null;
  });

  /** Currently selected edge weight metric (checks built-in + user-computed) */
  const edgeWeightMetric = computed(() => {
    const id = visualMapping.value.edgeWeight.metricId;
    if (!id) return null;
    const m = builtInMetrics.value.get(id) || computedMetrics.value.get(id) || null;
    return m && isNumericMetric(m) ? m : null;
  });

  /** Look a metric up by id (built-in first, then computed). */
  function getMetric(metricId: string): ComputedMetric | null {
    return builtInMetrics.value.get(metricId) || computedMetrics.value.get(metricId) || null;
  }

  /**
   * Look a metric up by display name within a target. First match wins in
   * list order (built-ins, then computed in insertion order): custom metric
   * names are unique per context, and algorithm runs carry a timestamp.
   */
  function findMetricByName(target: 'node' | 'edge', name: string): ComputedMetric | null {
    const list = target === 'node' ? nodeMetrics.value : edgeMetrics.value;
    return list.find((m) => m.name === name) ?? null;
  }

  /**
   * Resolver handed to the label formatter for `{metric:<ref>}` placeholders.
   * `ref` may be a metric id or a metric name. Reads `.value` at call time, so
   * a render pass triggered by `metricsVersion` sees fresh values.
   */
  const metricResolver: MetricResolver = (target, itemId, ref) => {
    const metric = getMetric(ref) ?? findMetricByName(target, ref);
    if (!metric || metric.target !== target) return undefined;
    return metric.values.get(itemId) as MetricValue | undefined;
  };

  /** Whether any computation is currently running */
  const hasActiveComputations = computed(() => {
    return Array.from(activeComputations.value.values()).some(
      (c) => c.status === 'running' || c.status === 'queued'
    );
  });

  /** Queue position for pending computations */
  const queuedCount = computed(() => {
    return Array.from(activeComputations.value.values()).filter(
      (c) => c.status === 'queued'
    ).length;
  });

  // ============================================================================
  // Actions - Computation Management
  // ============================================================================

  /**
   * Register a new computation (called when starting a metric calculation)
   */
  function registerComputation(metrics: ComputationMetrics): void {
    activeComputations.value.set(metrics.id, metrics);
    updateResourceMetrics();
  }

  /**
   * Update computation progress
   */
  function updateComputationProgress(
    id: string,
    update: Partial<ComputationMetrics>
  ): void {
    const computation = activeComputations.value.get(id);
    if (computation) {
      Object.assign(computation, update);
      activeComputations.value.set(id, computation);
      updateResourceMetrics();
    }
  }

  /**
   * Mark computation as completed and store the result
   */
  function completeComputation(metric: ComputedMetric): void {
    const computation = activeComputations.value.get(metric.id);

    // Store the computed metric
    computedMetrics.value.set(metric.id, metric);
    metricsVersion.value++;

    // Move to history
    if (computation) {
      computationHistory.value.unshift({
        id: computation.id,
        name: computation.name,
        algorithmId: computation.algorithmId,
        status: 'completed',
        elapsedMs: metric.elapsedMs,
        completedAt: Date.now(),
      });

      // Keep history limited to last 50 entries
      if (computationHistory.value.length > 50) {
        computationHistory.value.pop();
      }

      activeComputations.value.delete(metric.id);
    }

    updateResourceMetrics();
  }

  /**
   * Mark computation as failed
   */
  function failComputation(id: string, errorMessage: string): void {
    const computation = activeComputations.value.get(id);

    if (computation) {
      computationHistory.value.unshift({
        id: computation.id,
        name: computation.name,
        algorithmId: computation.algorithmId,
        status: 'error',
        elapsedMs: Date.now() - computation.startedAt,
        completedAt: Date.now(),
        errorMessage,
      });

      if (computationHistory.value.length > 50) {
        computationHistory.value.pop();
      }

      activeComputations.value.delete(id);
    }

    updateResourceMetrics();
  }

  /**
   * Cancel a computation
   */
  function cancelComputation(id: string): void {
    const computation = activeComputations.value.get(id);

    if (computation) {
      computationHistory.value.unshift({
        id: computation.id,
        name: computation.name,
        algorithmId: computation.algorithmId,
        status: 'cancelled',
        elapsedMs: Date.now() - computation.startedAt,
        completedAt: Date.now(),
      });

      if (computationHistory.value.length > 50) {
        computationHistory.value.pop();
      }

      activeComputations.value.delete(id);
    }

    updateResourceMetrics();
  }

  /**
   * Pause a running computation
   */
  function pauseComputation(id: string): void {
    updateComputationProgress(id, { status: 'paused' });
  }

  /**
   * Resume a paused computation
   */
  function resumeComputation(id: string): void {
    updateComputationProgress(id, { status: 'running' });
  }

  /**
   * Update computation priority
   */
  function setComputationPriority(id: string, priority: Priority): void {
    updateComputationProgress(id, { priority });
  }

  // ============================================================================
  // Actions - Visual Mapping
  // ============================================================================

  /**
   * Set the metric to use for node sizing
   */
  function setNodeSizeMetric(metricId: string | null): void {
    visualMapping.value.nodeSize.metricId = metricId;
  }

  /**
   * Update node size mapping parameters
   */
  function updateNodeSizeMapping(
    update: Partial<typeof visualMapping.value.nodeSize>
  ): void {
    visualMapping.value.nodeSize = {
      ...visualMapping.value.nodeSize,
      ...update,
    };
  }

  /**
   * Set the metric to use for node coloring (null turns metric color off)
   */
  function setNodeColorMetric(metricId: string | null): void {
    visualMapping.value.nodeColor.metricId = metricId;
  }

  /**
   * Update node color mapping parameters
   */
  function updateNodeColorMapping(
    update: Partial<typeof visualMapping.value.nodeColor>
  ): void {
    visualMapping.value.nodeColor = {
      ...visualMapping.value.nodeColor,
      ...update,
    };
  }

  /**
   * Set the metric to use for edge weight
   */
  function setEdgeWeightMetric(metricId: string | null): void {
    visualMapping.value.edgeWeight.metricId = metricId;
  }

  /**
   * Update edge weight mapping parameters
   */
  function updateEdgeWeightMapping(
    update: Partial<typeof visualMapping.value.edgeWeight>
  ): void {
    visualMapping.value.edgeWeight = {
      ...visualMapping.value.edgeWeight,
      ...update,
    };
  }

  /**
   * Toggle real-time updates during computation
   */
  function toggleRealTimeUpdates(enabled: boolean): void {
    visualMapping.value.enableRealTimeUpdates = enabled;
  }

  /**
   * Reset visual mapping to defaults
   */
  function resetVisualMapping(): void {
    visualMapping.value = {
      nodeSize: { ...DEFAULT_VISUAL_MAPPING.nodeSize },
      nodeColor: { ...DEFAULT_VISUAL_MAPPING.nodeColor },
      edgeWeight: { ...DEFAULT_VISUAL_MAPPING.edgeWeight },
      enableRealTimeUpdates: DEFAULT_VISUAL_MAPPING.enableRealTimeUpdates,
    };
  }

  /** Snapshot the visual mapping for a style preset / exploration. */
  function getVisualMappingState(): VisualMapping {
    return {
      nodeSize: { ...visualMapping.value.nodeSize },
      nodeColor: { ...visualMapping.value.nodeColor },
      edgeWeight: { ...visualMapping.value.edgeWeight },
      enableRealTimeUpdates: visualMapping.value.enableRealTimeUpdates,
    };
  }

  /**
   * Restore a saved visual mapping — untrusted, so per-key validated merge
   * over the defaults. Anything absent or mistyped falls back to its default;
   * undefined resets outright (a preset saved before the field existed).
   * A metricId naming a metric not computed on this graph is fine: the
   * nodeSizeMetric/edgeWeightMetric lookups return null and sizing falls back
   * to the base size until that metric is (re)computed.
   */
  function loadVisualMappingState(raw: unknown): void {
    const source = (raw ?? {}) as Record<string, unknown>;
    const SCALES: ScaleType[] = ['linear', 'log', 'sqrt'];

    function mergeMapping<T extends SizeMapping | WeightMapping | ColorMapping>(
      defaults: T,
      value: unknown,
    ): T {
      const merged = { ...defaults };
      if (!value || typeof value !== 'object') return merged;
      const v = value as Record<string, unknown>;
      for (const key of Object.keys(defaults) as (keyof T)[]) {
        const candidate = v[key as string];
        if (key === 'metricId') {
          if (candidate === null || typeof candidate === 'string') {
            (merged[key] as unknown) = candidate;
          }
        } else if (key === 'scale') {
          if (SCALES.includes(candidate as ScaleType)) {
            (merged[key] as unknown) = candidate;
          }
        } else if (key === 'minColor' || key === 'maxColor') {
          // Untrusted preset input that ends up in the renderer — only a
          // full 6-digit hex color is accepted.
          if (typeof candidate === 'string' && /^#[0-9a-fA-F]{6}$/.test(candidate)) {
            (merged[key] as unknown) = candidate;
          }
        } else if (typeof candidate === typeof defaults[key]) {
          (merged[key] as unknown) = candidate;
        }
      }
      return merged;
    }

    visualMapping.value = {
      nodeSize: mergeMapping({ ...DEFAULT_VISUAL_MAPPING.nodeSize }, source.nodeSize),
      nodeColor: mergeMapping({ ...DEFAULT_VISUAL_MAPPING.nodeColor }, source.nodeColor),
      edgeWeight: mergeMapping({ ...DEFAULT_VISUAL_MAPPING.edgeWeight }, source.edgeWeight),
      enableRealTimeUpdates:
        typeof source.enableRealTimeUpdates === 'boolean'
          ? source.enableRealTimeUpdates
          : DEFAULT_VISUAL_MAPPING.enableRealTimeUpdates,
    };
  }

  // ============================================================================
  // Actions - Worker Pool Configuration
  // ============================================================================

  /**
   * Update worker pool configuration
   */
  function updateWorkerPoolConfig(config: Partial<WorkerPoolConfig>): void {
    workerPoolConfig.value = {
      ...workerPoolConfig.value,
      ...config,
    };
    resourceMetrics.value.maxWorkers = workerPoolConfig.value.maxWorkers;
  }

  /**
   * Update resource metrics (called by worker pool)
   */
  function setResourceMetrics(metrics: Partial<ResourceMetrics>): void {
    resourceMetrics.value = {
      ...resourceMetrics.value,
      ...metrics,
    };
  }

  // ============================================================================
  // Actions - Metric Management
  // ============================================================================

  /**
   * Insert or replace a metric that did not go through the computation queue
   * (custom metrics evaluated by their own runner). No history entry.
   */
  function upsertMetric(metric: ComputedMetric): void {
    computedMetrics.value.set(metric.id, metric);
    metricsVersion.value++;
  }

  /**
   * Delete a computed metric (built-in metrics cannot be deleted)
   */
  function deleteMetric(metricId: string): void {
    if (metricId.startsWith('__builtin_')) return;

    // Clear visual mapping if this metric was selected
    if (visualMapping.value.nodeSize.metricId === metricId) {
      visualMapping.value.nodeSize.metricId = null;
    }
    if (visualMapping.value.nodeColor.metricId === metricId) {
      visualMapping.value.nodeColor.metricId = null;
    }
    if (visualMapping.value.edgeWeight.metricId === metricId) {
      visualMapping.value.edgeWeight.metricId = null;
    }

    if (computedMetrics.value.delete(metricId)) metricsVersion.value++;
    tableMetricIds.value.delete(metricId);
  }

  /**
   * Clear all computed metrics
   */
  function clearAllMetrics(): void {
    computedMetrics.value.clear();
    metricsVersion.value++;
    visualMapping.value.nodeSize.metricId = null;
    visualMapping.value.nodeColor.metricId = null;
    visualMapping.value.edgeWeight.metricId = null;
    for (const id of Array.from(tableMetricIds.value)) {
      if (!id.startsWith('__builtin_')) tableMetricIds.value.delete(id);
    }
  }

  /**
   * Toggle whether a metric appears as a virtual column in the Data Table
   */
  function toggleMetricInTable(metricId: string): void {
    if (tableMetricIds.value.has(metricId)) {
      tableMetricIds.value.delete(metricId);
    } else {
      tableMetricIds.value.add(metricId);
    }
  }

  /**
   * Clear computation history
   */
  function clearHistory(): void {
    computationHistory.value = [];
  }

  // ============================================================================
  // Internal Helpers
  // ============================================================================

  function updateResourceMetrics(): void {
    const computations = Array.from(activeComputations.value.values());
    resourceMetrics.value.computations = computations;
    resourceMetrics.value.queuedTasks = computations.filter(
      (c) => c.status === 'queued'
    ).length;
    resourceMetrics.value.activeWorkers = computations.filter(
      (c) => c.status === 'running'
    ).length;
  }

  /**
   * Calculate the number of connected components using Union-Find
   */
  function calculateComponentCount(
    nodes: { node_id: string }[],
    edges: { src: string; dst: string }[]
  ): number {
    if (nodes.length === 0) return 0;

    // Union-Find implementation
    const parent = new Map<string, string>();
    const rank = new Map<string, number>();

    function find(x: string): string {
      if (!parent.has(x)) {
        parent.set(x, x);
        rank.set(x, 0);
      }
      if (parent.get(x) !== x) {
        parent.set(x, find(parent.get(x)!));
      }
      return parent.get(x)!;
    }

    function union(x: string, y: string): void {
      const px = find(x);
      const py = find(y);
      if (px === py) return;

      const rx = rank.get(px) || 0;
      const ry = rank.get(py) || 0;

      if (rx < ry) {
        parent.set(px, py);
      } else if (rx > ry) {
        parent.set(py, px);
      } else {
        parent.set(py, px);
        rank.set(px, rx + 1);
      }
    }

    // Initialize all nodes
    for (const node of nodes) {
      find(node.node_id);
    }

    // Union nodes connected by edges
    for (const edge of edges) {
      union(edge.src, edge.dst);
    }

    // Count unique roots
    const roots = new Set<string>();
    for (const node of nodes) {
      roots.add(find(node.node_id));
    }

    return roots.size;
  }

  // ============================================================================
  // Watch for graph changes - invalidate metrics
  // ============================================================================

  watch(
    () => [graphStore.filteredNodes.length, graphStore.filteredEdges.length],
    () => {
      // When graph changes significantly, metrics become invalid
      // We keep the metrics but they may be stale
      // The UI should indicate when metrics need recalculation
    }
  );

  // ============================================================================
  // Expose
  // ============================================================================

  return {
    // State
    computedMetrics,
    activeComputations,
    computationHistory,
    tableMetricIds,
    metricsVersion,
    visualMapping,
    workerPoolConfig,
    resourceMetrics,

    // Computed
    graphInfo,
    builtInMetrics,
    nodeMetrics,
    edgeMetrics,
    numericNodeMetrics,
    numericEdgeMetrics,
    getMetric,
    findMetricByName,
    metricResolver,
    tableNodeMetrics,
    tableEdgeMetrics,
    nodeSizeMetric,
    nodeColorMetric,
    edgeWeightMetric,
    hasActiveComputations,
    queuedCount,

    // Computation management
    registerComputation,
    updateComputationProgress,
    completeComputation,
    failComputation,
    cancelComputation,
    pauseComputation,
    resumeComputation,
    setComputationPriority,

    // Visual mapping
    setNodeSizeMetric,
    updateNodeSizeMapping,
    setNodeColorMetric,
    updateNodeColorMapping,
    setEdgeWeightMetric,
    updateEdgeWeightMapping,
    toggleRealTimeUpdates,
    resetVisualMapping,
    getVisualMappingState,
    loadVisualMappingState,

    // Worker pool
    updateWorkerPoolConfig,
    setResourceMetrics,

    // Metric management
    upsertMetric,
    deleteMetric,
    clearAllMetrics,
    clearHistory,
    toggleMetricInTable,
  };
});
