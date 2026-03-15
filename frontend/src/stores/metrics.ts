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
  GraphInfo,
  ResourceMetrics,
  WorkerPoolConfig,
  Priority,
} from '@/types/metrics';
import {
  DEFAULT_VISUAL_MAPPING,
  getDefaultWorkerPoolConfig,
  calculateStats,
} from '@/types/metrics';
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

  // ============================================================================
  // Visual Mapping Configuration
  // ============================================================================

  const visualMapping = ref<VisualMapping>({
    nodeSize: { ...DEFAULT_VISUAL_MAPPING.nodeSize },
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

  /** Currently selected node size metric (checks built-in + user-computed) */
  const nodeSizeMetric = computed(() => {
    const id = visualMapping.value.nodeSize.metricId;
    if (!id) return null;
    return builtInMetrics.value.get(id) || computedMetrics.value.get(id) || null;
  });

  /** Currently selected edge weight metric (checks built-in + user-computed) */
  const edgeWeightMetric = computed(() => {
    const id = visualMapping.value.edgeWeight.metricId;
    if (!id) return null;
    return builtInMetrics.value.get(id) || computedMetrics.value.get(id) || null;
  });

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
      edgeWeight: { ...DEFAULT_VISUAL_MAPPING.edgeWeight },
      enableRealTimeUpdates: DEFAULT_VISUAL_MAPPING.enableRealTimeUpdates,
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
   * Delete a computed metric (built-in metrics cannot be deleted)
   */
  function deleteMetric(metricId: string): void {
    if (metricId.startsWith('__builtin_')) return;

    // Clear visual mapping if this metric was selected
    if (visualMapping.value.nodeSize.metricId === metricId) {
      visualMapping.value.nodeSize.metricId = null;
    }
    if (visualMapping.value.edgeWeight.metricId === metricId) {
      visualMapping.value.edgeWeight.metricId = null;
    }

    computedMetrics.value.delete(metricId);
  }

  /**
   * Clear all computed metrics
   */
  function clearAllMetrics(): void {
    computedMetrics.value.clear();
    visualMapping.value.nodeSize.metricId = null;
    visualMapping.value.edgeWeight.metricId = null;
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
    visualMapping,
    workerPoolConfig,
    resourceMetrics,

    // Computed
    graphInfo,
    builtInMetrics,
    nodeMetrics,
    edgeMetrics,
    nodeSizeMetric,
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
    setEdgeWeightMetric,
    updateEdgeWeightMapping,
    toggleRealTimeUpdates,
    resetVisualMapping,

    // Worker pool
    updateWorkerPoolConfig,
    setResourceMetrics,

    // Metric management
    deleteMetric,
    clearAllMetrics,
    clearHistory,
  };
});
