import { defineStore } from 'pinia';
import { ref, computed, nextTick, toRaw, watch } from 'vue';
import { buildSearchText } from '@/utils/searchText';
import type {
  Node,
  Edge,
  GraphContext,
  Exploration,
  FilterState,
  ViewportState,
  LayoutAlgorithm,
  LayoutModeConfig,
  PropertyColumn,
  SubgraphRequest,
  ExpandRequest,
  ExplorationState,
  PropertyFilter,
  TextFormatRule,
  TextFormatState,
  TextFormatDefaults,
  ProceduralBFSOptions,
} from '@/types/graph';
import { DEFAULT_PROCEDURAL_BFS_OPTIONS } from '@/types/graph';
import { api } from '@/services/api';
import { useClusterStore } from '@/stores/cluster';
import { useCommunityStore } from '@/stores/community';
import { useSimilarityStore } from '@/stores/similarity';
import { useMetricsStore } from '@/stores/metrics';
import { recordPerf } from '@/utils/perfMetrics';
import {
  useCancellableQuery,
  type StepResult,
} from '@/composables/useCancellableQuery';
import type { QueryMetadata, GraphJobStatusResponse } from '@/types/graph';

/**
 * Built-in defaults for the Behaviors panel.
 *
 * This literal is also the type source for `behaviors` (`typeof DEFAULT_BEHAVIORS`),
 * so the `as` narrowings below are load-bearing — without them the unions collapse to
 * `string` and BehaviorPanel's radio bindings stop type-checking.
 */
const DEFAULT_BEHAVIORS = {
  edgeLensMode: 'dim' as 'off' | 'hide' | 'dim',  // off = no focus, hide = hide non-focused, dim = dim non-focused edges
  edgeLensDimOpacity: 0.08,  // Opacity for dimmed edges in 'dim' mode (0.01-0.3)
  focusDepth: 1,            // How many hops to include (1 = direct neighbors)
  degreeDimEnabled: true,  // When true, dim edges connected to high-degree nodes
  degreeDimThreshold: 30,   // Degree threshold above which edges are dimmed
  degreeDimOpacity: 0.2,   // Opacity for degree-dimmed edges (0.01-0.3)
  degreeDimPreserveBridges: true,  // When true, don't dim nodes that connect to non-hub neighborhoods
  searchMode: 'highlight' as 'hide' | 'highlight',  // hide = filter out non-matching, highlight = show all but highlight matches
  centerOnSearch: true,     // When true (and highlight mode), center camera on best match while typing
  inMessiWeTrust: true,    // When true, auto-execute transpiled SQL without review
  viewMode: '2d-proj' as '3d' | '2d-proj',  // default 2D for performance (lighter force sim + less overdraw); '3d' = Three.js 3D, '2d-proj' = Three.js 2D projection
  hideLabelsOnCameraMove: false, // When true, hide 3D labels during camera movement for performance
  useOrthographicCamera: true, // When true, use orthographic projection instead of perspective
  useInstancedRendering: true, // When true, use InstancedMesh for nodes/links (fast, ~3 draw calls). When false, use individual Mesh per node/link (slower, correct transparency).
  labelDensityCulling: true, // When true, use screen-space grid to limit label density (Sigma.js-style)
  labelDensity: 0.5,         // Base labels per grid cell at default zoom (0.1-4)
  labelGridCellSize: 150,    // Grid cell size in screen pixels (50-500)
  labelSizeThreshold: 6,     // Min node screen-radius (px) to show its label (like Sigma.js)
  labelOverlapThreshold: 0.4, // Max overlap ratio (0..1) before hiding a label (0=no overlap, 1=allow full overlap)
  showSelfEdges: true,       // When true, display self-edges (loops where src === dst)
  hideSelfEdgesOnCameraMove: true, // When true, hide self-edges during camera movement for performance
  enableNodeDrag: false,           // When true, allow dragging nodes by click-drag (pins node after release)
  mapStylePan: true,               // When true (default), right-drag pans Google-Maps-style: the point grabbed stays locked under the cursor. When false, TrackballControls' pan (panSpeed 0.3, so the world lags the mouse; its ortho branch also mis-scales the vertical axis by the aspect ratio).
  autoLoadOnOpen: false,           // When true, opening a context immediately fetches an initial subgraph (all nodes, edge_limit 1000). Default false: open empty and let the user run a query — the implicit fetch is expensive on large graphs. Opening a saved exploration is unaffected; it always loads its own data.
};

export type GraphBehaviors = typeof DEFAULT_BEHAVIORS;

/** Fresh defaults per call — nested objects must never be shared by reference. */
export function defaultLayoutModeConfig(): LayoutModeConfig {
  return {
    ego: {
      focusNodeId: null,
      direction: 'both',
      edgeTypes: null,
      maxHops: null,
      ringSpacing: 60,
    },
    hive: {
      axisKey: 'node_type',
      maxAxes: 6,
      positionKey: 'degree',
      scale: 'rank',
      innerRadius: 40,
      outerRadius: 300,
    },
    hierarchical: {
      direction: 'td',
      traversal: 'out',
      edgeTypes: null,
      levelSpacing: 120,
      nodeSpacing: 40,
    },
  };
}

/**
 * Merge an untrusted `default_behaviors` dict into `target`, in place.
 *
 * Both the server config and the graph context carry this dict opaquely — neither knows
 * the frontend's schema — so validation has to happen here: unknown keys are dropped and
 * type mismatches are rejected per-key rather than trusted. A typo (`constantZoom`) or an
 * env-var footgun (the *string* `"false"`, which is truthy) must not reach the store, or
 * it would ride along into every saved exploration.
 *
 * `source` only names where the dict came from, for the warning message.
 */
function applyBehaviorOverrides(
  target: GraphBehaviors,
  overrides: Record<string, unknown> | undefined | null,
  source: string,
): GraphBehaviors {
  if (!overrides) return target;

  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in target)) {
      console.warn(`[graph] Ignoring unknown ${source} default_behaviors key: "${key}"`);
      continue;
    }
    const k = key as keyof GraphBehaviors;
    if (typeof value !== typeof target[k]) {
      console.warn(
        `[graph] Ignoring ${source} default_behaviors."${key}": expected ${typeof target[k]}, got ${typeof value}`
      );
      continue;
    }
    (target[k] as unknown) = value;
  }

  return target;
}

/**
 * Resolve the behaviors a graph should start from.
 *
 * Precedence, lowest to highest:
 *   built-in defaults < server config < graph context < user's panel changes < exploration
 *
 * The last two aren't handled here: the panel mutates the store directly, and
 * `loadExploration` merges the saved behaviors over whatever is current — and since
 * `loadContext` runs before it, an exploration still correctly wins over its context.
 *
 * @param contextBehaviors the current graph context's `default_behaviors`, if any.
 */
export function resolveInitialBehaviors(
  contextBehaviors?: Record<string, unknown> | null,
): GraphBehaviors {
  const resolved = { ...DEFAULT_BEHAVIORS };
  applyBehaviorOverrides(resolved, window.__GRAPH_LAGOON_CONFIG__?.default_behaviors, 'server');
  applyBehaviorOverrides(resolved, contextBehaviors, 'context');
  return resolved;
}

/**
 * Record load-path timings for a graph fetch (dev-only; no-op in prod).
 *
 * Splits the cost into three buckets so a baseline can attribute where the
 * time goes: network+parse (`fetch`), reactive assignment (`assign`), and the
 * backend's own stage timings surfaced from `response.metadata` (`backend`).
 */
function recordGraphLoad(
  label: string,
  response: { nodes: unknown[]; edges: unknown[]; metadata?: QueryMetadata },
  fetchMs: number,
  assignMs: number,
) {
  recordPerf(`load:${label}:fetch`, fetchMs, {
    nodeCount: response.nodes.length,
    edgeCount: response.edges.length,
  });
  recordPerf(`load:${label}:assign`, assignMs);
  const m = response.metadata;
  if (m) {
    const extra: Record<string, number> = {};
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === 'number') extra[k] = v;
    }
    recordPerf(`load:${label}:backend`, m.total_ms ?? 0, extra);
  }
}

export const useGraphStore = defineStore('graph', () => {
  // Current graph data
  const nodes = ref<Node[]>([]);
  const edges = ref<Edge[]>([]);

  // Current context and exploration
  const currentContext = ref<GraphContext | null>(null);
  const currentExploration = ref<Exploration | null>(null);

  // Selection state
  const selectedNodeIds = ref<Set<string>>(new Set());
  const selectedEdgeIds = ref<Set<string>>(new Set());

  // Hover state (for graph lens dim mode)
  const hoveredNodeId = ref<string | null>(null);

  // Lens pause: when true, graph lens effect is suppressed (selection/details stay open)
  const lensPaused = ref(false);

  // UI state
  const loading = ref(false);
  // Human-readable description of the in-flight operation, shown in the loading
  // overlay (e.g. "Running query…", "Loading graph…", "Expanding node…").
  const loadingMessage = ref('');
  // Set by REPLACE operations (query/subgraph/cypher) to tell the canvas the
  // next data update is a fresh layout (re-settle from scratch), regardless of
  // how many node ids overlap the previous graph. Expand does NOT set it, so it
  // stays an incremental update. Consumed (reset) by the canvas on update.
  const freshLayoutRequested = ref(false);
  const error = ref<string | null>(null);

  // Query error state (for non-blocking alert modal)
  const queryError = ref<{
    message: string;
    query?: string;
    code?: string;
    exceptionType?: string;
    traceback?: string[];
  } | null>(null);

  // Helper: extract error details from API errors
  interface ApiErrorDetail {
    error?: {
      code?: string;
      message?: string;
      details?: {
        query?: string;
        exception_type?: string;
        traceback?: string[];
      };
    };
  }

  function extractErrorDetails(e: unknown, fallbackMessage: string): {
    message: string;
    query?: string;
    code?: string;
    exceptionType?: string;
    traceback?: string[];
  } {
    if (e && typeof e === 'object' && 'response' in e) {
      const axiosError = e as { response?: { data?: { detail?: ApiErrorDetail | string } } };
      const detail = axiosError.response?.data?.detail;

      if (typeof detail === 'string') {
        return { message: detail };
      }

      if (detail && typeof detail === 'object' && 'error' in detail) {
        const error = detail.error;
        return {
          message: error?.message || fallbackMessage,
          code: error?.code,
          query: error?.details?.query,
          exceptionType: error?.details?.exception_type,
          traceback: error?.details?.traceback,
        };
      }
    }

    if (e instanceof Error) {
      return { message: e.message };
    }

    return { message: fallbackMessage };
  }

  function clearQueryError() {
    queryError.value = null;
  }

  // Visualization state
  const filters = ref<FilterState>({
    node_types: [],
    edge_types: [],
    search_query: undefined,
    nodePropertyFilters: [],
    edgePropertyFilters: [],
  });
  const viewport = ref<ViewportState>({
    zoom: 1.0,
    center_x: 0,
    center_y: 0,
  });
  const layoutAlgorithm = ref<LayoutAlgorithm>('force');

  // Per-layout-mode parameters (persisted with the exploration)
  const layoutModeConfig = ref<LayoutModeConfig>(defaultLayoutModeConfig());


  // 3D Force-Directed layout settings (D3-Force only)
  const force3DSettings = ref({
    // D3-Force simulation settings
    d3AlphaDecay: 0.0228,      // Cooling rate (lower = slower stabilization)
    d3VelocityDecay: 0.4,      // Friction factor (higher = more damping)
    d3AlphaMin: 0.001,         // Threshold to stop simulation (lower = run longer)
    d3AlphaTarget: 0,          // Target alpha for heating/cooling (0 = cool down, higher = keep running)
    // Charge force (manyBody) settings
    d3ChargeStrength: -80,    // Node repulsion (negative = repel, more negative = stronger)
    d3Theta: 0.9,              // Barnes-Hut approximation (lower = more accurate but slower)
    d3DistanceMin: 1,          // Minimum distance for repulsion (avoids extreme forces)
    d3DistanceMax: Infinity,   // Maximum distance for repulsion (Infinity = no limit)
    // Link force settings
    d3LinkDistance: 30,        // Target link distance
    // Center force settings
    d3CenterStrength: 1,       // Centering force strength
    // Gravity — pulls each node toward origin (keeps disconnected components together)
    d3GravityStrength: 0.03,   // Per-node force toward origin (0 = disabled, ~0.01-0.1 typical)
    // Collide force settings (prevents node overlap)
    d3CollideEnabled: true,   // Whether to enable collision detection
    d3CollideRadius: 10,       // Minimum collision radius (actual radius = max(this, node visual radius))
    d3CollideStrength: 0.7,    // Collision strength (0-1)
    d3CollideIterations: 1,    // Iterations per tick (higher = more accurate but slower)
    // Pointer repulsion (cylindrical blower) / attraction (vacuum) settings
    pointerRepulsionEnabled: true,  // Whether the blower tool is available (Shift+mouse)
    pointerVacuumEnabled: false,    // Whether the vacuum tool is available (Ctrl+mouse)
    pointerRepulsionStrength: 150,  // Repulsion/attraction intensity
    pointerRepulsionRange: 200,     // Maximum radius of effect (screen pixels)
    pointerSizeInertia: true,       // Larger nodes resist blower/vacuum more
    // Clipping plane settings
    clippingPlaneEnabled: false,    // Whether clipping plane is active
    clippingPlaneDistance: 0,       // Offset from graph center (controlled by scroll or slider)
  });

  // Layout execution settings (simulation lifecycle — not d3 force params)
  const layoutExecution = ref({
    cooldownTicks: 100,    // Max simulation ticks before auto-stop (higher = longer run)
    ticksPerFrame: 1,      // Simulation ticks per render frame (batch ticking for faster convergence)
    warmupTicks: 0,        // Pre-render ticks (computed without rendering, blocks main thread)
  });

  // Behavior settings — seeded from the server's default_behaviors, if any.
  const behaviors = ref(resolveInitialBehaviors());

  // Aesthetic settings (visual appearance)
  const aesthetics = ref({
    // Common settings
    showArrows: true,         // Show directional arrows on edges
    arrowSize: 1.0,           // Arrow size multiplier (0.5 to 3.0)
    nodeOpacity: 1.0,         // Node transparency (0.1 to 1.0)
    edgeOpacity: 0.6,         // Edge transparency (0.1 to 1.0)
    nodeSize: 8,              // Base node size
    edgeWidth: 1,             // Base edge width
    enableMultiEdgeCurvature: true, // Enable curved edges for multi-edges (2D & 3D)
    // 3D specific
    showNodeLabels3D: true,   // Show node labels in 3D
    showEdgeLabels3D: true,   // Show edge labels in 3D
    nodeLabelSize3D: 10,       // Node label text height in 3D
    edgeLabelSize3D: 5,       // Edge label text height in 3D (same as node for visibility)
    edgeIconSize3D: 8,        // Edge icon size in 3D (diameter in world units)
    nodeLabelOffsetY3D: 2,    // Offset for node labels (distance from node surface)
    nodeLabelPosition3D: 'right' as 'top' | 'right' | 'left', // Label placement relative to node
  });

  // Color scheme for node/edge types (custom colors override default palette)
  const nodeTypeColors = ref<Map<string, string>>(new Map());
  const edgeTypeColors = ref<Map<string, string>>(new Map());
  const nodeTypeIcons = ref<Map<string, string>>(new Map());
  const edgeTypeIcons = ref<Map<string, string>>(new Map());

  // Property-based icon mapping: nodeType → { property, valueIcons, fallbackIcon }
  const nodePropertyIconConfigs = ref<Map<string, import('@/types/graph').PropertyIconConfig>>(new Map());

  // Default color palette (used when no custom color is set)
  const defaultColorPalette = [
    '#42b883', '#35495e', '#ff6b6b', '#4ecdc4', '#45b7d1',
    '#96ceb4', '#ffeaa7', '#a29bfe', '#fd79a8', '#00b894',
    '#e17055', '#74b9ff', '#fdcb6e', '#6c5ce7', '#00cec9',
  ];

  // Graph query state (persisted with exploration)
  const graphQuery = ref('');
  const ctePrefilter = ref('');

  // Cypher transpilation options
  const vlpRenderingMode = ref<'cte' | 'procedural'>('procedural');
  const materializationStrategy = ref<'temp_tables' | 'numbered_views'>(
    window.__GRAPH_LAGOON_CONFIG__?.databricks_mode ? 'temp_tables' : 'numbered_views'
  );
  // Fine-grained procedural BFS optimization flags (only applied when
  // vlpRenderingMode === 'procedural'). Defaults mirror the transpiler.
  const proceduralOptimizations = ref<ProceduralBFSOptions>({
    ...DEFAULT_PROCEDURAL_BFS_OPTIONS,
  });

  // External links mode (for large Databricks results)
  const useExternalLinks = ref(true);

  // Text format rules (label formatting)
  const textFormatRules = ref<TextFormatRule[]>([]);
  const textFormatDefaults = ref<TextFormatDefaults>({
    nodeTemplate: '{node_id|truncate:10:...}',
    edgeTemplate: '{relationship_type}',
  });

  // Node positions (pinned nodes)
  const nodePositions = ref<Map<string, { x: number; y: number; pinned: boolean }>>(new Map());

  // Computed
  const selectedNode = computed(() => {
    if (selectedNodeIds.value.size === 1) {
      const id = Array.from(selectedNodeIds.value)[0];
      return nodes.value.find((n) => n.node_id === id) || null;
    }
    return null;
  });

  const selectedEdge = computed(() => {
    if (selectedEdgeIds.value.size === 1) {
      const id = Array.from(selectedEdgeIds.value)[0];
      return edges.value.find((e) => e.edge_id === id) || null;
    }
    return null;
  });

  const nodeTypes = computed(() => {
    const types = new Set<string>();
    nodes.value.forEach((n) => types.add(n.node_type));
    return Array.from(types).sort();
  });

  const edgeTypes = computed(() => {
    const types = new Set<string>();
    edges.value.forEach((e) => types.add(e.relationship_type));
    return Array.from(types).sort();
  });

  const NUMERIC_DATA_TYPES = ['int', 'integer', 'bigint', 'smallint', 'tinyint', 'float', 'double', 'decimal', 'numeric', 'real', 'long', 'number'];

  function isNumericDataType(dataType: string): boolean {
    const dt = dataType.toLowerCase();
    return NUMERIC_DATA_TYPES.some((t) => dt.startsWith(t));
  }

  // Node property columns split by data type (drives hive plot axis/position selectors)
  const numericNodeProperties = computed<PropertyColumn[]>(() =>
    (currentContext.value?.node_properties ?? []).filter((p) => isNumericDataType(p.data_type))
  );

  const categoricalNodeProperties = computed<PropertyColumn[]>(() =>
    (currentContext.value?.node_properties ?? []).filter((p) => !isNumericDataType(p.data_type))
  );

  // Multi-edge detection: edges with same src/dst pair but different edge_id
  const multiEdgeStats = computed(() => {
    const pairCount = new Map<string, number>();
    const pairEdges = new Map<string, Edge[]>();

    for (const edge of edges.value) {
      // Normalize key so A->B and B->A are different (directed graph)
      const key = `${edge.src}|${edge.dst}`;
      pairCount.set(key, (pairCount.get(key) || 0) + 1);

      if (!pairEdges.has(key)) {
        pairEdges.set(key, []);
      }
      pairEdges.get(key)!.push(edge);
    }

    // Count pairs with multiple edges
    let multiEdgePairCount = 0;
    let totalMultiEdges = 0;

    for (const [, count] of pairCount) {
      if (count > 1) {
        multiEdgePairCount++;
        totalMultiEdges += count;
      }
    }

    return {
      hasMultiEdges: multiEdgePairCount > 0,
      multiEdgePairCount,  // Number of node pairs with multiple edges
      totalMultiEdges,     // Total edges in multi-edge pairs
      pairEdges,           // Map of pair -> edges (for rendering)
    };
  });

  const hasMultiEdges = computed(() => multiEdgeStats.value.hasMultiEdges);

  // Adjacency list built once per edge change — O(E) build, then O(1) neighbor lookup
  const adjacencyList = computed(() => {
    const adj = new Map<string, string[]>();
    edges.value.forEach((edge) => {
      let srcNeighbors = adj.get(edge.src);
      if (!srcNeighbors) { srcNeighbors = []; adj.set(edge.src, srcNeighbors); }
      srcNeighbors.push(edge.dst);

      let dstNeighbors = adj.get(edge.dst);
      if (!dstNeighbors) { dstNeighbors = []; adj.set(edge.dst, dstNeighbors); }
      dstNeighbors.push(edge.src);
    });
    return adj;
  });

  // Helper: get nodes connected to selection/hover (for graph lens mode)
  const focusedNodeIds = computed(() => {
    if (behaviors.value.edgeLensMode === 'off' || lensPaused.value) return null;

    // Collect seed nodes: selected + hovered
    const seeds = new Set<string>(selectedNodeIds.value);
    if (hoveredNodeId.value) {
      seeds.add(hoveredNodeId.value);
    }

    if (seeds.size === 0) return null;

    const focused = new Set<string>(seeds);
    const depth = behaviors.value.focusDepth;
    const adj = adjacencyList.value;

    // BFS using adjacency list: O(|visited| * avg_degree) instead of O(depth * E)
    let frontier = new Set<string>(seeds);
    for (let d = 0; d < depth; d++) {
      const nextFrontier = new Set<string>();
      for (const nodeId of frontier) {
        const neighbors = adj.get(nodeId);
        if (!neighbors) continue;
        for (const neighbor of neighbors) {
          if (!focused.has(neighbor)) {
            nextFrontier.add(neighbor);
            focused.add(neighbor);
          }
        }
      }
      frontier = nextFrontier;
    }

    return focused;
  });

  // Helper: evaluate a property filter against a value
  function evaluatePropertyFilter(
    filter: PropertyFilter,
    metadata: Record<string, string>,
    getMetricValue?: (metricId: string) => number | undefined
  ): boolean {
    if (!filter.enabled) return true;

    // Get the value to compare
    let rawValue: string | number | undefined;

    if (filter.property.startsWith('metric:')) {
      const metricId = filter.property.slice(7);
      rawValue = getMetricValue?.(metricId);
    } else {
      rawValue = metadata[filter.property];
    }

    if (rawValue === undefined || rawValue === null) return false;

    // Parse numeric value if needed
    const numericValue = typeof rawValue === 'number' ? rawValue : parseFloat(rawValue);
    const isNumeric = !isNaN(numericValue);
    const stringValue = String(rawValue).toLowerCase();

    switch (filter.operator) {
      case 'equals':
        if (isNumeric && typeof filter.value === 'number') {
          return numericValue === filter.value;
        }
        return stringValue === String(filter.value).toLowerCase();

      case 'not_equals':
        if (isNumeric && typeof filter.value === 'number') {
          return numericValue !== filter.value;
        }
        return stringValue !== String(filter.value).toLowerCase();

      case 'one_of':
        if (!filter.values || filter.values.length === 0) return true;
        return filter.values.some(v =>
          stringValue === String(v).toLowerCase()
        );

      case 'contains':
        return stringValue.includes(String(filter.value).toLowerCase());

      case 'less_than':
        return isNumeric && typeof filter.value === 'number' && numericValue < filter.value;

      case 'less_than_or_equal':
        return isNumeric && typeof filter.value === 'number' && numericValue <= filter.value;

      case 'greater_than':
        return isNumeric && typeof filter.value === 'number' && numericValue > filter.value;

      case 'greater_than_or_equal':
        return isNumeric && typeof filter.value === 'number' && numericValue >= filter.value;

      case 'between':
        if (!isNumeric || filter.minValue === undefined || filter.maxValue === undefined) return false;
        return numericValue >= filter.minValue && numericValue <= filter.maxValue;

      default:
        return true;
    }
  }

  // Pre-computed lowercased search text per node (id + type), rebuilt only when
  // `nodes` changes — not on every keystroke. This moves the per-node
  // `toLowerCase()` and the reactive-Proxy property reads off the search hot
  // path: searching then scans a plain string per node via one `includes()`.
  const nodeSearchIndex = computed(() => {
    const raw = toRaw(nodes.value);
    const index = new Array<{ id: string; text: string }>(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const n = raw[i];
      index[i] = { id: n.node_id, text: buildSearchText([n.node_id, n.node_type]) };
    }
    return index;
  });

  // Node IDs that match the current search query
  const searchMatchedNodeIds = computed(() => {
    if (!filters.value.search_query) return null;
    const query = filters.value.search_query.toLowerCase();
    const matched = new Set<string>();
    for (const entry of nodeSearchIndex.value) {
      if (entry.text.includes(query)) matched.add(entry.id);
    }
    return matched;
  });

  // Node IDs that should be hidden in 'hide' search mode (for visual hiding, not data filtering)
  const searchHiddenNodeIds = computed(() => {
    if (!filters.value.search_query || behaviors.value.searchMode !== 'hide') return null;
    const matched = searchMatchedNodeIds.value;
    if (!matched || matched.size === 0) return null;
    // Return all node IDs that are NOT matched
    const hidden = new Set<string>();
    for (const entry of nodeSearchIndex.value) {
      if (!matched.has(entry.id)) hidden.add(entry.id);
    }
    return hidden;
  });

  // Node IDs hidden by property filters (for 3D visual hiding to preserve positions)
  const propertyFilterHiddenNodeIds = computed(() => {
    const activeNodeFilters = filters.value.nodePropertyFilters.filter(f => f.enabled);
    if (activeNodeFilters.length === 0) return null;

    const metricsStore = useMetricsStore();
    const hidden = new Set<string>();

    // Cache metric lookup: Map<metricId, MetricResult> for O(1) access inside loop
    const metricCache = new Map<string, { values: Map<string, number> } | undefined>();
    for (const filter of activeNodeFilters) {
      if (filter.property.startsWith('metric:')) {
        const metricId = filter.property.slice(7);
        if (!metricCache.has(metricId)) {
          metricCache.set(metricId, metricsStore.nodeMetrics.find(m => m.id === metricId));
        }
      }
    }

    nodes.value.forEach((n) => {
      const getMetricValue = (metricId: string) => {
        return metricCache.get(metricId)?.values.get(n.node_id);
      };

      const passes = activeNodeFilters.every(filter =>
        evaluatePropertyFilter(filter, {}, getMetricValue)
      );

      if (!passes) {
        hidden.add(n.node_id);
      }
    });

    return hidden.size > 0 ? hidden : null;
  });

  // Edge IDs hidden by property filters (for 3D visual hiding to preserve positions)
  const propertyFilterHiddenEdgeIds = computed(() => {
    const activeEdgeFilters = filters.value.edgePropertyFilters.filter(f => f.enabled);
    if (activeEdgeFilters.length === 0) return null;

    const metricsStore = useMetricsStore();
    const hidden = new Set<string>();

    // Cache metric lookup for O(1) access inside loop
    const metricCache = new Map<string, { values: Map<string, number> } | undefined>();
    for (const filter of activeEdgeFilters) {
      if (filter.property.startsWith('metric:')) {
        const metricId = filter.property.slice(7);
        if (!metricCache.has(metricId)) {
          metricCache.set(metricId, metricsStore.edgeMetrics.find(m => m.id === metricId));
        }
      }
    }

    edges.value.forEach((e) => {
      const getMetricValue = (metricId: string) => {
        return metricCache.get(metricId)?.values.get(e.edge_id);
      };

      const passes = activeEdgeFilters.every(filter =>
        evaluatePropertyFilter(filter, {}, getMetricValue)
      );

      if (!passes) {
        hidden.add(e.edge_id);
      }
    });

    return hidden.size > 0 ? hidden : null;
  });

  const filteredNodes = computed(() => {
    let result = nodes.value;

    if (filters.value.node_types.length > 0) {
      const typeSet = new Set(filters.value.node_types);
      result = result.filter((n) => typeSet.has(n.node_type));
    }

    // Only hide non-matching nodes if searchMode is 'hide' AND there are matches
    // Note: 3D handles this visually to avoid layout recomputation
    // searchMode is checked FIRST on purpose: in 'highlight' mode the
    // short-circuit means search_query is never read, so this computed does not
    // depend on it — a search keystroke leaves filteredNodes (and everything
    // downstream) cached instead of recomputing the whole chain.
    if (behaviors.value.searchMode === 'hide' && filters.value.search_query) {
      // Reuse the already-computed match Set instead of re-running the
      // toLowerCase scan a third time.
      const matched = searchMatchedNodeIds.value;
      if (matched && matched.size > 0) {
        result = result.filter((n) => matched.has(n.node_id));
      }
    }

    // Apply property filters (metrics only, no metadata)
    const activeNodeFilters = filters.value.nodePropertyFilters.filter(f => f.enabled);
    if (activeNodeFilters.length > 0) {
      const metricsStore = useMetricsStore();
      // Cache metric lookup for O(1) access inside loop
      const metricCache = new Map<string, { values: Map<string, number> } | undefined>();
      for (const filter of activeNodeFilters) {
        if (filter.property.startsWith('metric:')) {
          const metricId = filter.property.slice(7);
          if (!metricCache.has(metricId)) {
            metricCache.set(metricId, metricsStore.nodeMetrics.find(m => m.id === metricId));
          }
        }
      }
      result = result.filter((n) => {
        const getMetricValue = (metricId: string) => {
          return metricCache.get(metricId)?.values.get(n.node_id);
        };

        return activeNodeFilters.every(filter =>
          evaluatePropertyFilter(filter, {}, getMetricValue)
        );
      });
    }

    // Note: graph lens focus (both 'hide' and 'dim') is handled visually in GraphCanvas3D
    // via hidden flag / alpha encoding. Not filtered here to preserve 3D positions.

    return result;
  });

  const filteredEdges = computed(() => {
    const nodeIdSet = new Set(filteredNodes.value.map((n) => n.node_id));
    let result = edges.value.filter(
      (e) => nodeIdSet.has(e.src) && nodeIdSet.has(e.dst)
    );

    // Filter out self-edges when toggle is off
    if (!behaviors.value.showSelfEdges) {
      result = result.filter((e) => e.src !== e.dst);
    }

    if (filters.value.edge_types.length > 0) {
      const typeSet = new Set(filters.value.edge_types);
      result = result.filter((e) => typeSet.has(e.relationship_type));
    }

    // Apply property filters to edges (metrics only, no metadata)
    const activeEdgeFilters = filters.value.edgePropertyFilters.filter(f => f.enabled);
    if (activeEdgeFilters.length > 0) {
      const metricsStore = useMetricsStore();
      // Cache metric lookup for O(1) access inside loop
      const metricCache = new Map<string, { values: Map<string, number> } | undefined>();
      for (const filter of activeEdgeFilters) {
        if (filter.property.startsWith('metric:')) {
          const metricId = filter.property.slice(7);
          if (!metricCache.has(metricId)) {
            metricCache.set(metricId, metricsStore.edgeMetrics.find(m => m.id === metricId));
          }
        }
      }
      result = result.filter((e) => {
        const getMetricValue = (metricId: string) => {
          return metricCache.get(metricId)?.values.get(e.edge_id);
        };

        return activeEdgeFilters.every(filter =>
          evaluatePropertyFilter(filter, {}, getMetricValue)
        );
      });
    }

    // Similarity display mode filtering
    const similarityStore = useSimilarityStore();
    if (similarityStore.hasResults) {
      const mode = similarityStore.displayMode;
      if (mode === 'hidden') {
        result = result.filter(e => e.relationship_type !== '__similarity__');
      } else if (mode === 'exclusive') {
        result = result.filter(e => e.relationship_type === '__similarity__');
      }
      // 'overlay': no filtering — show all edges including similarity
    }

    return result;
  });

  // ============================================================================
  // Table Filter Integration
  // ============================================================================

  const tableFilteredNodeIds = ref<Set<string> | null>(null);
  const tableFilteredEdgeIds = ref<Set<string> | null>(null);

  function setTableFilteredIds(nodeIds: Set<string> | null, edgeIds: Set<string> | null) {
    tableFilteredNodeIds.value = nodeIds;
    tableFilteredEdgeIds.value = edgeIds;
  }

  // ── Canvas data chain contract ──
  // displayNodes/displayEdges (and enhancedNodes/enhancedEdges built on them)
  // feed ONLY the 3D canvas. They are based on the FULL dataset, NOT on
  // filteredNodes/filteredEdges: node-type, edge-type, search-hide, property
  // and table filters are applied VISUALLY in the canvas via graphAppearance
  // (hidden flag), which preserves node positions and avoids a full Three.js
  // rebuild + force-layout reheat on every filter change (froze the UI even
  // at ~20k). Only filters with no visual equivalent stay data-level here:
  // the self-edge toggle and similarity display mode (their toggles are rare,
  // so the rebuild they trigger is acceptable).
  // All other consumers (status bar, tables, metrics, community, similarity)
  // keep using filteredNodes/filteredEdges and retain filtered semantics.
  const displayNodes = computed(() => nodes.value);

  const displayEdges = computed(() => {
    let result = edges.value;

    // Filter out self-edges when toggle is off (no visual equivalent)
    if (!behaviors.value.showSelfEdges) {
      result = result.filter((e) => e.src !== e.dst);
    }

    // Similarity display mode filtering (no visual equivalent)
    const similarityStore = useSimilarityStore();
    if (similarityStore.hasResults) {
      const mode = similarityStore.displayMode;
      if (mode === 'hidden') {
        result = result.filter(e => e.relationship_type !== '__similarity__');
      } else if (mode === 'exclusive') {
        result = result.filter(e => e.relationship_type === '__similarity__');
      }
    }

    return result;
  });

  // ============================================================================
  // Cluster Integration
  // ============================================================================

  /**
   * Enhanced nodes that include cluster nodes and hide nodes in closed clusters
   *
   * This computed property:
   * 1. Adds virtual cluster nodes for closed clusters
   * 2. Removes nodes that are in closed clusters (unless also in open clusters)
   * 3. Preserves all original node properties and filtering
   */
  const enhancedNodes = computed(() => {
    const clusterStore = useClusterStore();

    const result: Node[] = [];

    // Add display nodes (excluding those in closed-only clusters)
    displayNodes.value.forEach((node) => {
      if (clusterStore.visibleNodeIds.has(node.node_id)) {
        result.push(node);
      }
    });

    // Add cluster nodes for closed clusters
    clusterStore.closedClusters.forEach((cluster: any) => {
      result.push({
        node_id: cluster.cluster_id,
        node_type: '__cluster__',
        properties: {
          cluster_name: cluster.cluster_name,
          cluster_class: cluster.cluster_class,
          figure: cluster.figure,
          node_count: cluster.node_ids.length,
          color: cluster.color,
          description: cluster.description,
          // Store original cluster data for rendering and interaction
          _cluster_data: cluster,
        },
      });
    });

    return result;
  });

  /**
   * Enhanced edges that aggregate edges to/from closed clusters
   *
   * This computed property:
   * 1. Remaps edges where src or dst is in a closed cluster to point to the cluster node
   * 2. Hides internal edges (both src and dst in same closed cluster)
   * 3. Preserves all original edge properties
   * 4. Updates multi-edge detection to account for cluster aggregation
   */
  const enhancedEdges = computed(() => {
    const clusterStore = useClusterStore();

    const result: Edge[] = [];

    // Build map of node -> cluster for closed clusters
    const nodeToCluster = clusterStore.nodeToClosedClusters;

    displayEdges.value.forEach((edge) => {
      const srcClusters = nodeToCluster.get(edge.src) || [];
      const dstClusters = nodeToCluster.get(edge.dst) || [];

      // Case 1: Neither endpoint in any closed cluster - keep as is
      if (srcClusters.length === 0 && dstClusters.length === 0) {
        result.push(edge);
        return;
      }

      // Case 2: Both in same closed cluster - hide internal edge
      const sharedCluster = srcClusters.find((c: string) => dstClusters.includes(c));
      if (sharedCluster) {
        return; // Skip internal edge
      }

      // Case 3: At least one endpoint in a closed cluster - remap to cluster
      // If node is in multiple closed clusters, use the first one (arbitrary but consistent)
      const srcCluster = srcClusters[0];
      const dstCluster = dstClusters[0];

      result.push({
        ...edge,
        src: srcCluster || edge.src,
        dst: dstCluster || edge.dst,
        // Generate unique edge ID that includes cluster mapping
        // This ensures proper multi-edge detection
        edge_id: srcCluster || dstCluster
          ? `cluster_${srcCluster || edge.src}_${dstCluster || edge.dst}_${edge.edge_id}`
          : edge.edge_id,
      });
    });

    return result;
  });

  // Multi-edge detection for enhanced edges (includes cluster-created multi-edges)
  const enhancedMultiEdgeStats = computed(() => {
    const pairCount = new Map<string, number>();
    const pairEdges = new Map<string, Edge[]>();

    for (const edge of enhancedEdges.value) {
      // Normalize key so A->B and B->A are in the same group (bidirectional edges curve apart)
      const key = edge.src < edge.dst ? `${edge.src}|${edge.dst}` : `${edge.dst}|${edge.src}`;
      pairCount.set(key, (pairCount.get(key) || 0) + 1);

      if (!pairEdges.has(key)) {
        pairEdges.set(key, []);
      }
      pairEdges.get(key)!.push(edge);
    }

    // Count pairs with multiple edges
    let multiEdgePairCount = 0;
    let totalMultiEdges = 0;

    for (const [, count] of pairCount) {
      if (count > 1) {
        multiEdgePairCount++;
        totalMultiEdges += count;
      }
    }

    return {
      hasMultiEdges: multiEdgePairCount > 0,
      multiEdgePairCount,  // Number of node pairs with multiple edges
      totalMultiEdges,     // Total edges in multi-edge pairs
      pairEdges,           // Map of pair -> edges (for rendering)
    };
  });

  const enhancedHasMultiEdges = computed(() => enhancedMultiEdgeStats.value.hasMultiEdges);

  // Use raw edges (not filteredEdges) so the toggle remains visible even when self-edges are hidden
  const hasSelfEdges = computed(() => edges.value.some(e => e.src === e.dst));

  // Node degrees for degree-based edge dimming (O(E), recomputes when edges change)
  const nodeDegrees = computed(() => {
    const degrees = new Map<string, number>();
    edges.value.forEach(e => {
      degrees.set(e.src, (degrees.get(e.src) || 0) + 1);
      degrees.set(e.dst, (degrees.get(e.dst) || 0) + 1);
    });
    return degrees;
  });

  const maxDegree = computed(() => {
    if (nodeDegrees.value.size === 0) return 0;
    let max = 0;
    for (const deg of nodeDegrees.value.values()) {
      if (deg > max) max = deg;
    }
    return max;
  });

  // Hub nodes: nodes with degree > threshold (for degree dimming)
  const hubNodeIds = computed(() => {
    if (!behaviors.value.degreeDimEnabled) return null;
    const threshold = behaviors.value.degreeDimThreshold;
    const hubs = new Set<string>();
    for (const [nodeId, deg] of nodeDegrees.value) {
      if (deg > threshold) {
        hubs.add(nodeId);
      }
    }
    return hubs.size > 0 ? hubs : null;
  });

  // Actions
  async function loadContext(contextId: string) {
    loading.value = true;
    loadingMessage.value = 'Loading context…';
    error.value = null;

    try {
      currentContext.value = await api.getGraphContext(contextId);
      // Re-resolve from scratch rather than merging over the current value: on a context
      // switch the previous context's behaviors would otherwise linger (clear() doesn't
      // reset them). A subsequent loadExploration() still wins — it runs after this and
      // merges the saved behaviors on top.
      behaviors.value = resolveInitialBehaviors(currentContext.value.default_behaviors);
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to load context';
      error.value = errorMessage;
    } finally {
      loading.value = false;
    }
  }

  async function loadSubgraph(request: SubgraphRequest = {}) {
    if (!currentContext.value) return;

    loading.value = true;
    loadingMessage.value = 'Loading graph…';
    queryError.value = null;

    try {
      const t0 = performance.now();
      const response = await api.getSubgraph(currentContext.value.id, {
        edge_limit: request.edge_limit || 1000,
        node_types: request.node_types || [],
        edge_types: request.edge_types || [],
      });
      const tFetched = performance.now();

      // Success: request a fresh layout only now (not before the await), so a
      // failed request never leaves the flag set to contaminate a later update.
      freshLayoutRequested.value = true;
      nodes.value = response.nodes;
      edges.value = response.edges;
      recordGraphLoad('subgraph', response, tFetched - t0, performance.now() - tFetched);
      adjustGravityForConnectivity();

      // Clear selections
      selectedNodeIds.value.clear();
      selectedEdgeIds.value.clear();
    } catch (e: unknown) {
      queryError.value = extractErrorDetails(e, 'Failed to load subgraph');
    } finally {
      loading.value = false;
    }
  }

  async function expandFromNode(
    nodeId: string,
    depth: number = 2,
    edgeTypes: string[] = [],
    edgeLimit: number = 100,
    directed: boolean = false
  ) {
    if (!currentContext.value) return;

    loading.value = true;
    loadingMessage.value = 'Expanding node…';
    queryError.value = null;

    try {
      const request: ExpandRequest = {
        node_id: nodeId,
        depth: Math.min(depth, 2),  // Max depth is 2
        edge_types: edgeTypes,
        edge_limit: Math.max(4, Math.min(edgeLimit, 1000)),  // 4-1000
        directed,
      };

      const response = await api.expandFromNode(currentContext.value.id, request);

      // Merge new nodes and edges
      const existingNodeIds = new Set(nodes.value.map((n) => n.node_id));
      const existingEdgeIds = new Set(edges.value.map((e) => e.edge_id));

      const newNodes = response.nodes.filter((n) => !existingNodeIds.has(n.node_id));
      const newEdges = response.edges.filter((e) => !existingEdgeIds.has(e.edge_id));

      nodes.value = [...nodes.value, ...newNodes];
      edges.value = [...edges.value, ...newEdges];
    } catch (e: unknown) {
      queryError.value = extractErrorDetails(e, 'Failed to expand node');
    } finally {
      loading.value = false;
    }
  }

  // Last transpiled SQL from cypher query
  const lastTranspiledSql = ref<string | null>(null);

  // ── Cancellable graph query (shared submit → poll → cancel machine) ──
  // executeGraphQuery / executeCypherQuery set these before invoking the run;
  // the graph overlay reads queryChunkProgress / queryCanCancel and calls
  // cancelGraphQuery. `loading` stays the general graph-loading flag (also used
  // by context loads), so we wrap the run in it.
  let pendingGraphSubmit: (() => Promise<StepResult>) | null = null;
  let pendingGraphApply: ((status: GraphJobStatusResponse) => void) | null = null;
  let pendingQueryText = '';

  const graphJob = useCancellableQuery({
    submit: () => pendingGraphSubmit!(),
    poll: async (jobId: string): Promise<StepResult> => {
      const s = await api.getGraphQueryJob(currentContext.value!.id, jobId);
      return {
        status: s.status,
        statementId: jobId,
        chunkProgress: s.progress
          ? { done: s.progress.chunks_done, total: s.progress.chunks_total }
          : null,
        result: s,
      };
    },
    cancel: (jobId: string) =>
      api.cancelGraphQueryJob(currentContext.value!.id, jobId),
    applyResult: (r) => pendingGraphApply?.(r as GraphJobStatusResponse),
    onError: (e) => {
      const details = extractErrorDetails(e, 'Failed to execute graph query');
      queryError.value = { ...details, query: details.query || pendingQueryText };
    },
    // On cancel we keep the current graph (like a failed query) — just stop.
  });

  const queryChunkProgress = graphJob.chunkProgress;
  const queryCanCancel = graphJob.canCancel;

  async function cancelGraphQuery(): Promise<void> {
    await graphJob.cancelQuery();
    loading.value = false;
  }

  async function executeGraphQuery(query: string, options?: { preserveGraphQuery?: boolean; preserveSelections?: boolean }) {
    if (!currentContext.value) return;

    loading.value = true;
    loadingMessage.value = 'Running query…';
    queryError.value = null;
    pendingQueryText = query;

    // Save query to state (unless preserving existing)
    if (!options?.preserveGraphQuery) {
      graphQuery.value = query;
    }

    const t0 = performance.now();
    pendingGraphSubmit = async () => {
      const resp = await api.submitGraphQueryJob(currentContext.value!.id, {
        query,
        ...(useExternalLinks.value ? { use_external_links: true } : {}),
      });
      return { status: resp.status, statementId: resp.job_id };
    };
    pendingGraphApply = (status) => {
      const response = status.result!;
      // Replace current graph with query result. Set the fresh-layout flag only
      // on success so a failed query keeps the current graph.
      freshLayoutRequested.value = true;
      nodes.value = response.nodes;
      edges.value = response.edges;
      recordGraphLoad('query', response, performance.now() - t0, 0);
      adjustGravityForConnectivity();
      // Clear selections (unless preserving for exploration restore)
      if (!options?.preserveSelections) {
        selectedNodeIds.value.clear();
        selectedEdgeIds.value.clear();
      }
    };

    try {
      await graphJob.run();
    } finally {
      loading.value = false;
    }
  }

  async function executeCypherQuery(query: string): Promise<string | null> {
    if (!currentContext.value) return null;

    loading.value = true;
    loadingMessage.value = 'Running Cypher query…';
    queryError.value = null;
    lastTranspiledSql.value = null;
    pendingQueryText = query;

    // Save query to state
    graphQuery.value = query;

    const t0 = performance.now();
    pendingGraphSubmit = async () => {
      const resp = await api.submitCypherQueryJob(currentContext.value!.id, {
        query,
        ...(ctePrefilter.value ? { cte_prefilter: ctePrefilter.value } : {}),
        vlp_rendering_mode: vlpRenderingMode.value,
        materialization_strategy: materializationStrategy.value,
        ...(vlpRenderingMode.value === 'procedural'
          ? { procedural_optimizations: { ...proceduralOptimizations.value } }
          : {}),
        ...(useExternalLinks.value ? { use_external_links: true } : {}),
      });
      // Transpiled SQL is known at submit time — surface it immediately.
      if (resp.transpiled_sql) lastTranspiledSql.value = resp.transpiled_sql;
      return { status: resp.status, statementId: resp.job_id };
    };
    pendingGraphApply = (status) => {
      const response = status.result!;
      freshLayoutRequested.value = true;
      nodes.value = response.nodes;
      edges.value = response.edges;
      recordGraphLoad('cypher', response, performance.now() - t0, 0);
      adjustGravityForConnectivity();
      if (status.transpiled_sql) lastTranspiledSql.value = status.transpiled_sql;
      selectedNodeIds.value.clear();
      selectedEdgeIds.value.clear();
    };

    try {
      await graphJob.run();
      return lastTranspiledSql.value;
    } finally {
      loading.value = false;
    }
  }

  async function transpileCypher(query: string): Promise<string | null> {
    if (!currentContext.value) return null;

    loading.value = true;
    queryError.value = null;

    try {
      const response = await api.transpileCypher(currentContext.value.id, {
        query,
        ...(ctePrefilter.value ? { cte_prefilter: ctePrefilter.value } : {}),
        vlp_rendering_mode: vlpRenderingMode.value,
        materialization_strategy: materializationStrategy.value,
        ...(vlpRenderingMode.value === 'procedural'
          ? { procedural_optimizations: { ...proceduralOptimizations.value } }
          : {}),
      });
      lastTranspiledSql.value = response.transpiled_sql;
      return response.transpiled_sql;
    } catch (e: unknown) {
      const details = extractErrorDetails(e, 'Failed to transpile cypher query');
      queryError.value = { ...details, query: details.query || query };
      return null;
    } finally {
      loading.value = false;
    }
  }

  function setGraphQuery(query: string) {
    graphQuery.value = query;
  }

  function selectNode(nodeId: string, multi: boolean = false) {
    if (!multi) {
      selectedNodeIds.value.clear();
      selectedEdgeIds.value.clear();
    }

    if (selectedNodeIds.value.has(nodeId)) {
      selectedNodeIds.value.delete(nodeId);
    } else {
      selectedNodeIds.value.add(nodeId);
    }
    // Re-enable lens when selecting a different node
    lensPaused.value = false;
  }

  function selectEdge(edgeId: string, multi: boolean = false) {
    if (!multi) {
      selectedNodeIds.value.clear();
      selectedEdgeIds.value.clear();
    }

    if (selectedEdgeIds.value.has(edgeId)) {
      selectedEdgeIds.value.delete(edgeId);
    } else {
      selectedEdgeIds.value.add(edgeId);
    }
  }

  function clearSelection() {
    selectedNodeIds.value.clear();
    selectedEdgeIds.value.clear();
  }

  function applyFilters(newFilters: Partial<FilterState>) {
    // Mutate in place instead of replacing the object: replacing `filters.value`
    // invalidates EVERY computed that reads any filter field, so a search
    // keystroke would needlessly recompute the whole filteredNodes →
    // filteredEdges → enhanced* chain (O(n+m) over reactive proxies at 200k+).
    // Vue's per-property tracking keeps unrelated readers cached.
    Object.assign(filters.value, newFilters);
  }

  function resetFilters() {
    filters.value = {
      node_types: [],
      edge_types: [],
      search_query: undefined,
      nodePropertyFilters: [],
      edgePropertyFilters: [],
    };
  }

  /**
   * Reset the Cypher transpilation options to their defaults. Procedural BFS is
   * the default rendering mode, so a fresh context always starts with the
   * "Procedural BFS" toggle enabled — the store is a singleton, so without this
   * a previously-opened exploration saved with `'cte'` would leak into the next
   * context opened in the same session (clear() is what runs between them).
   */
  function resetTranspileOptions() {
    vlpRenderingMode.value = 'procedural';
    materializationStrategy.value =
      window.__GRAPH_LAGOON_CONFIG__?.databricks_mode ? 'temp_tables' : 'numbered_views';
    proceduralOptimizations.value = { ...DEFAULT_PROCEDURAL_BFS_OPTIONS };
  }

  function addNodePropertyFilter(filter: Omit<PropertyFilter, 'id'>) {
    const newFilter: PropertyFilter = {
      ...filter,
      id: `node-filter-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    };
    filters.value.nodePropertyFilters = [...filters.value.nodePropertyFilters, newFilter];
  }

  function updateNodePropertyFilter(filterId: string, updates: Partial<PropertyFilter>) {
    filters.value.nodePropertyFilters = filters.value.nodePropertyFilters.map(f =>
      f.id === filterId ? { ...f, ...updates } : f
    );
  }

  function removeNodePropertyFilter(filterId: string) {
    filters.value.nodePropertyFilters = filters.value.nodePropertyFilters.filter(f => f.id !== filterId);
  }

  function addEdgePropertyFilter(filter: Omit<PropertyFilter, 'id'>) {
    const newFilter: PropertyFilter = {
      ...filter,
      id: `edge-filter-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    };
    filters.value.edgePropertyFilters = [...filters.value.edgePropertyFilters, newFilter];
  }

  function updateEdgePropertyFilter(filterId: string, updates: Partial<PropertyFilter>) {
    filters.value.edgePropertyFilters = filters.value.edgePropertyFilters.map(f =>
      f.id === filterId ? { ...f, ...updates } : f
    );
  }

  function removeEdgePropertyFilter(filterId: string) {
    filters.value.edgePropertyFilters = filters.value.edgePropertyFilters.filter(f => f.id !== filterId);
  }

  function setLayoutAlgorithm(algorithm: LayoutAlgorithm) {
    layoutAlgorithm.value = algorithm;
    // Community radial layout and non-force layout modes are both global positional
    // constraints — they must not stack (see the reverse-direction watch below).
    if (algorithm !== 'force') {
      const communityStore = useCommunityStore();
      communityStore.radialLayoutEnabled = false;
    }
  }

  /** Merge partial per-mode config (e.g. { ego: { maxHops: 2 } }) into layoutModeConfig. */
  function updateLayoutModeConfig(partial: {
    ego?: Partial<LayoutModeConfig['ego']>;
    hive?: Partial<LayoutModeConfig['hive']>;
    hierarchical?: Partial<LayoutModeConfig['hierarchical']>;
  }) {
    layoutModeConfig.value = {
      ego: { ...layoutModeConfig.value.ego, ...(partial.ego ?? {}) },
      hive: { ...layoutModeConfig.value.hive, ...(partial.hive ?? {}) },
      hierarchical: { ...layoutModeConfig.value.hierarchical, ...(partial.hierarchical ?? {}) },
    };
  }

  function updateForce3DSettings(settings: Partial<typeof force3DSettings.value>) {
    force3DSettings.value = { ...force3DSettings.value, ...settings };
  }

  /** Auto-adjust gravity based on graph connectivity after a query. */
  function adjustGravityForConnectivity() {
    const n = nodes.value;
    const e = edges.value;
    if (n.length <= 1) {
      updateForce3DSettings({ d3GravityStrength: 0 });
      return;
    }
    // Quick Union-Find to count weakly connected components
    const parent = new Map<string, string>();
    function find(x: string): string {
      if (!parent.has(x)) parent.set(x, x);
      if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
      return parent.get(x)!;
    }
    for (const node of n) find(node.node_id);
    for (const edge of e) {
      const pa = find(edge.src), pb = find(edge.dst);
      if (pa !== pb) parent.set(pa, pb);
    }
    const roots = new Set<string>();
    for (const node of n) roots.add(find(node.node_id));
    const isConnected = roots.size <= 1;
    updateForce3DSettings({ d3GravityStrength: isConnected ? 0 : 0.03 });
  }

  function updateLayoutExecution(settings: Partial<typeof layoutExecution.value>) {
    layoutExecution.value = { ...layoutExecution.value, ...settings };
  }

  function updateBehaviors(newBehaviors: Partial<typeof behaviors.value>) {
    behaviors.value = { ...behaviors.value, ...newBehaviors };
  }

  function updateAesthetics(newAesthetics: Partial<typeof aesthetics.value>) {
    aesthetics.value = { ...aesthetics.value, ...newAesthetics };
  }

  // Color management functions
  function getNodeTypeColor(type: string): string {
    if (nodeTypeColors.value.has(type)) {
      return nodeTypeColors.value.get(type)!;
    }
    // Auto-assign from default palette based on type index (uses cached computed)
    const index = nodeTypes.value.indexOf(type);
    return defaultColorPalette[index >= 0 ? index % defaultColorPalette.length : 0];
  }

  function getEdgeTypeColor(type: string): string {
    if (edgeTypeColors.value.has(type)) {
      return edgeTypeColors.value.get(type)!;
    }
    // Auto-assign from default palette (offset by 5, uses cached computed)
    const index = edgeTypes.value.indexOf(type);
    return defaultColorPalette[(index >= 0 ? index + 5 : 5) % defaultColorPalette.length];
  }

  function setNodeTypeColor(type: string, color: string) {
    nodeTypeColors.value.set(type, color);
    // Trigger reactivity
    nodeTypeColors.value = new Map(nodeTypeColors.value);
  }

  function setEdgeTypeColor(type: string, color: string) {
    edgeTypeColors.value.set(type, color);
    // Trigger reactivity
    edgeTypeColors.value = new Map(edgeTypeColors.value);
  }

  function resetTypeColors() {
    nodeTypeColors.value = new Map();
    edgeTypeColors.value = new Map();
  }

  function getNodeTypeIcon(type: string): string | null {
    return nodeTypeIcons.value.get(type) ?? null;
  }

  function setNodeTypeIcon(type: string, iconName: string | null) {
    if (iconName === null) {
      nodeTypeIcons.value.delete(type);
    } else {
      nodeTypeIcons.value.set(type, iconName);
    }
    nodeTypeIcons.value = new Map(nodeTypeIcons.value);
  }

  function resetNodeTypeIcons() {
    nodeTypeIcons.value = new Map();
  }

  function getEdgeTypeIcon(type: string): string | null {
    return edgeTypeIcons.value.get(type) ?? null;
  }

  function setEdgeTypeIcon(type: string, iconName: string | null) {
    if (iconName === null) {
      edgeTypeIcons.value.delete(type);
    } else {
      edgeTypeIcons.value.set(type, iconName);
    }
    edgeTypeIcons.value = new Map(edgeTypeIcons.value);
  }

  function resetEdgeTypeIcons() {
    edgeTypeIcons.value = new Map();
  }

  // Property-based icon config methods
  function getNodePropertyIconConfig(nodeType: string): import('@/types/graph').PropertyIconConfig | null {
    return nodePropertyIconConfigs.value.get(nodeType) ?? null;
  }

  function setNodePropertyIconConfig(nodeType: string, config: import('@/types/graph').PropertyIconConfig | null) {
    if (config === null) {
      nodePropertyIconConfigs.value.delete(nodeType);
    } else {
      nodePropertyIconConfigs.value.set(nodeType, config);
    }
    nodePropertyIconConfigs.value = new Map(nodePropertyIconConfigs.value);
  }

  function resetNodePropertyIconConfigs() {
    nodePropertyIconConfigs.value = new Map();
  }

  /** Get distinct values of a property for nodes of a given type in the current graph */
  function getDistinctPropertyValues(nodeType: string, propertyName: string): string[] {
    const values = new Set<string>();
    nodes.value.forEach((n) => {
      if (n.node_type !== nodeType) return;
      const val = n.properties?.[propertyName];
      if (val != null && val !== '') {
        values.add(String(val));
      }
    });
    return Array.from(values).sort();
  }

  function updateNodePosition(nodeId: string, x: number, y: number, pinned: boolean = false) {
    nodePositions.value.set(nodeId, { x, y, pinned });
  }

  function toggleNodePinned(nodeId: string) {
    const pos = nodePositions.value.get(nodeId);
    if (pos) {
      pos.pinned = !pos.pinned;
    }
  }

  // Text format rule actions
  function addTextFormatRule(rule: Omit<TextFormatRule, 'id'>): TextFormatRule {
    const newRule: TextFormatRule = {
      ...rule,
      id: `format-rule-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    };
    textFormatRules.value = [...textFormatRules.value, newRule];
    return newRule;
  }

  function updateTextFormatRule(ruleId: string, updates: Partial<TextFormatRule>) {
    textFormatRules.value = textFormatRules.value.map(r =>
      r.id === ruleId ? { ...r, ...updates } : r
    );
  }

  function removeTextFormatRule(ruleId: string) {
    textFormatRules.value = textFormatRules.value.filter(r => r.id !== ruleId);
  }

  function setTextFormatRuleEnabled(ruleId: string, enabled: boolean) {
    updateTextFormatRule(ruleId, { enabled });
  }

  function updateTextFormatDefaults(defaults: Partial<TextFormatDefaults>) {
    textFormatDefaults.value = { ...textFormatDefaults.value, ...defaults };
  }

  function reorderTextFormatRules(ruleIds: string[]) {
    // Reorder rules based on the provided ID array, updating priorities
    const ruleMap = new Map(textFormatRules.value.map(r => [r.id, r]));
    textFormatRules.value = ruleIds
      .map((id, index) => {
        const rule = ruleMap.get(id);
        if (rule) {
          return { ...rule, priority: ruleIds.length - index };
        }
        return null;
      })
      .filter((r): r is TextFormatRule => r !== null);
  }

  function getTextFormatState(): TextFormatState {
    return {
      rules: [...textFormatRules.value],
      defaults: { ...textFormatDefaults.value },
    };
  }

  function loadTextFormatState(state: TextFormatState | undefined) {
    if (state) {
      textFormatRules.value = state.rules || [];
      textFormatDefaults.value = state.defaults || {
        nodeTemplate: '{node_id|truncate:10}',
        edgeTemplate: '{relationship_type}',
      };
    } else {
      // Reset to defaults if no state provided
      textFormatRules.value = [];
      textFormatDefaults.value = {
        nodeTemplate: '{node_id|truncate:10}',
        edgeTemplate: '{relationship_type}',
      };
    }
  }

  function buildGraphSnapshot() {
    return {
      nodes: nodes.value.map((n) => ({
        id: n.node_id,
        type: n.node_type,
        properties: (n.properties ?? {}) as Record<string, unknown>,
        x: n.x,
        y: n.y,
      })),
      edges: edges.value.map((e) => ({
        id: e.edge_id,
        source: e.src,
        target: e.dst,
        type: e.relationship_type,
        properties: (e.properties ?? {}) as Record<string, unknown>,
      })),
    };
  }

  function getExplorationState(): ExplorationState {
    const clusterStore = useClusterStore();
    const communityStore = useCommunityStore();
    const similarityStore = useSimilarityStore();

    // Don't save nodes/edges - they are regenerated from graph_query
    return {
      nodes: [],
      edges: [],
      filters: { ...filters.value },
      viewport: { ...viewport.value },
      layout_algorithm: layoutAlgorithm.value,
      layout_mode_config: {
        ego: { ...layoutModeConfig.value.ego },
        hive: { ...layoutModeConfig.value.hive },
        hierarchical: { ...layoutModeConfig.value.hierarchical },
      },
      graph_query: graphQuery.value || undefined,
      cte_prefilter: ctePrefilter.value || undefined,
      vlp_rendering_mode: vlpRenderingMode.value,
      materialization_strategy: materializationStrategy.value,
      procedural_optimizations: { ...proceduralOptimizations.value },
      textFormat: getTextFormatState(),
      clusters: clusterStore.getState() as any, // Cluster state (programs, clusters, executions)
      nodeTypeIcons: nodeTypeIcons.value.size > 0
        ? Object.fromEntries(nodeTypeIcons.value)
        : undefined,
      nodePropertyIconConfigs: nodePropertyIconConfigs.value.size > 0
        ? Object.fromEntries(nodePropertyIconConfigs.value)
        : undefined,
      nodeTypeColors: nodeTypeColors.value.size > 0
        ? Object.fromEntries(nodeTypeColors.value)
        : undefined,
      edgeTypeColors: edgeTypeColors.value.size > 0
        ? Object.fromEntries(edgeTypeColors.value)
        : undefined,
      edgeTypeIcons: edgeTypeIcons.value.size > 0
        ? Object.fromEntries(edgeTypeIcons.value)
        : undefined,
      behaviors: { ...behaviors.value },
      aesthetics: { ...aesthetics.value },
      community: communityStore.getState(),
      similarity: similarityStore.getState(),
    };
  }

  async function saveExploration(title: string): Promise<{ success: boolean; error?: string }> {
    if (!currentContext.value) return { success: false, error: 'No context selected' };

    // Require at least nodes OR a query to save
    const hasNodes = nodes.value.length > 0;
    const hasQuery = !!(graphQuery.value && graphQuery.value.trim());
    if (!hasNodes && !hasQuery) {
      return {
        success: false,
        error: 'Cannot save an empty exploration. Execute a query or expand nodes first.',
      };
    }

    loading.value = true;
    error.value = null;

    try {
      const state = getExplorationState();
      const snapshot = buildGraphSnapshot();

      // Update existing only if title matches, otherwise create new
      const shouldUpdate = currentExploration.value && currentExploration.value.title === title;

      if (shouldUpdate) {
        currentExploration.value = await api.updateExploration(
          currentExploration.value!.id,
          { title, state, snapshot }
        );
      } else {
        currentExploration.value = await api.createExploration(
          currentContext.value.id,
          { title, state, snapshot }
        );
      }
      return { success: true };
    } catch (e: unknown) {
      // Extract error message from Axios error or generic error
      let errorMessage = 'Failed to save exploration';
      if (e && typeof e === 'object' && 'response' in e) {
        const axiosError = e as { response?: { data?: { detail?: string }; status?: number } };
        if (axiosError.response?.data?.detail) {
          errorMessage = axiosError.response.data.detail;
        }
      } else if (e instanceof Error) {
        errorMessage = e.message;
      }
      error.value = errorMessage;
      return { success: false, error: errorMessage };
    } finally {
      loading.value = false;
    }
  }

  async function _executeQueryFallback(
    exploration: Awaited<ReturnType<typeof api.getExploration>>,
    communityStore: ReturnType<typeof useCommunityStore>
  ) {
    if (exploration.state.graph_query) {
      const query = exploration.state.graph_query.trim();
      if (query.toUpperCase().startsWith('MATCH')) {
        const sql = await transpileCypher(query);
        if (sql) {
          await executeGraphQuery(sql, { preserveGraphQuery: true, preserveSelections: true });
        }
      } else {
        await executeGraphQuery(query, { preserveGraphQuery: true, preserveSelections: true });
      }
    } else {
      await loadSubgraph({});
    }
    // Community state must be restored AFTER query execution because the
    // nodes watcher in community store clears communities when nodes change.
    communityStore.loadState(exploration.state.community);
    // Similarity state also restored after query execution (same reason).
    const similarityStore = useSimilarityStore();
    similarityStore.loadState(exploration.state.similarity);
  }

  /**
   * Auto-save a snapshot for the current exploration after a query-based load.
   * Used as a migration path: after the first load of an old exploration (or
   * when the snapshot file was lost), this transparently upgrades it so future
   * loads use the fast file-based path instead of re-executing the query.
   * Fire-and-forget — failures are logged but never surface to the user.
   */
  async function _autoSaveSnapshotIfWritable(): Promise<void> {
    const exp = currentExploration.value;
    if (!exp?.has_write_access) return;
    if (nodes.value.length === 0) return;
    try {
      const snapshot = buildGraphSnapshot();
      const updated = await api.updateExploration(exp.id, { snapshot });
      // Reflect has_snapshot=true locally without a full reload
      currentExploration.value = updated;
    } catch (err) {
      console.warn('[loadExploration] Auto-snapshot save failed:', err);
    }
  }

  async function loadExploration(explorationId: string) {
    loading.value = true;
    error.value = null;

    try {
      const exploration = await api.getExploration(explorationId);
      currentExploration.value = exploration;

      // Restore state (ensure backwards compatibility with old explorations)
      const loadedFilters = exploration.state.filters;
      filters.value = {
        node_types: loadedFilters.node_types ?? [],
        edge_types: loadedFilters.edge_types ?? [],
        search_query: loadedFilters.search_query,
        nodePropertyFilters: loadedFilters.nodePropertyFilters ?? [],
        edgePropertyFilters: loadedFilters.edgePropertyFilters ?? [],
      };
      viewport.value = exploration.state.viewport;
      // Backwards compat: old explorations saved legacy values ('force-atlas-2',
      // 'forceAtlas2', ...) the renderer never read — any unknown value maps to 'force'
      const savedAlgorithm = exploration.state.layout_algorithm as string | undefined;
      const KNOWN_LAYOUTS: LayoutAlgorithm[] = ['force', 'ego', 'hive', 'hierarchical', 'circular', 'grid'];
      layoutAlgorithm.value = KNOWN_LAYOUTS.includes(savedAlgorithm as LayoutAlgorithm)
        ? (savedAlgorithm as LayoutAlgorithm)
        : 'force';
      const savedLayoutConfig = exploration.state.layout_mode_config;
      const layoutDefaults = defaultLayoutModeConfig();
      layoutModeConfig.value = {
        ego: { ...layoutDefaults.ego, ...(savedLayoutConfig?.ego ?? {}) },
        hive: { ...layoutDefaults.hive, ...(savedLayoutConfig?.hive ?? {}) },
        hierarchical: { ...layoutDefaults.hierarchical, ...(savedLayoutConfig?.hierarchical ?? {}) },
      };
      graphQuery.value = exploration.state.graph_query || '';
      ctePrefilter.value = exploration.state.cte_prefilter || '';
      vlpRenderingMode.value = exploration.state.vlp_rendering_mode || 'procedural';
      materializationStrategy.value = exploration.state.materialization_strategy
        || (window.__GRAPH_LAGOON_CONFIG__?.databricks_mode ? 'temp_tables' : 'numbered_views');
      proceduralOptimizations.value = {
        ...DEFAULT_PROCEDURAL_BFS_OPTIONS,
        ...(exploration.state.procedural_optimizations || {}),
      };

      // Load text format state (with backwards compatibility)
      loadTextFormatState(exploration.state.textFormat);

      // Load cluster state (always, even if undefined to clear current state)
      const clusterStore = useClusterStore();
      clusterStore.loadState(exploration.state.clusters);

      // Load node type icons (backwards compatible)
      nodeTypeIcons.value = exploration.state.nodeTypeIcons
        ? new Map(Object.entries(exploration.state.nodeTypeIcons))
        : new Map();

      // Load property icon configs (backwards compatible)
      nodePropertyIconConfigs.value = exploration.state.nodePropertyIconConfigs
        ? new Map(Object.entries(exploration.state.nodePropertyIconConfigs))
        : new Map();

      // Load type colors (backwards compatible)
      nodeTypeColors.value = exploration.state.nodeTypeColors
        ? new Map(Object.entries(exploration.state.nodeTypeColors))
        : new Map();
      edgeTypeColors.value = exploration.state.edgeTypeColors
        ? new Map(Object.entries(exploration.state.edgeTypeColors))
        : new Map();

      // Load edge type icons (backwards compatible)
      edgeTypeIcons.value = exploration.state.edgeTypeIcons
        ? new Map(Object.entries(exploration.state.edgeTypeIcons))
        : new Map();

      // Load behaviors and aesthetics (backwards compatible — merge with defaults)
      if (exploration.state.behaviors) {
        behaviors.value = { ...behaviors.value, ...exploration.state.behaviors } as typeof behaviors.value;
      }
      if (exploration.state.aesthetics) {
        aesthetics.value = { ...aesthetics.value, ...exploration.state.aesthetics } as typeof aesthetics.value;
      }

      // Load graph data: snapshot first (fast, includes expanded nodes),
      // fall back to query re-execution if snapshot is unavailable.
      const communityStore = useCommunityStore();
      const similarityStore = useSimilarityStore();

      if (exploration.state.has_snapshot) {
        try {
          const snapshot = await api.getExplorationSnapshot(explorationId);
          nodes.value = snapshot.nodes.map((n) => ({
            node_id: n.id,
            node_type: n.type,
            properties: n.properties,
            x: n.x,
            y: n.y,
          }));
          edges.value = snapshot.edges.map((e) => ({
            edge_id: e.id,
            src: e.source,
            dst: e.target,
            relationship_type: e.type,
            properties: e.properties,
          }));
          // Wait for the community store's nodes watcher to fire and clear
          // communities before restoring — same timing requirement as the
          // query-execution path (the watcher is async/next-tick).
          await nextTick();
          communityStore.loadState(exploration.state.community);
          similarityStore.loadState(exploration.state.similarity);
        } catch (snapshotErr) {
          console.warn(
            '[loadExploration] Snapshot unavailable, falling back to query re-execution:',
            snapshotErr
          );
          await _executeQueryFallback(exploration, communityStore);
          // File was missing — re-save snapshot to recover (fire-and-forget)
          _autoSaveSnapshotIfWritable();
        }
      } else {
        await _executeQueryFallback(exploration, communityStore);
        // Old exploration without snapshot — auto-upgrade after first load (fire-and-forget)
        _autoSaveSnapshotIfWritable();
      }

      // Clear selections after loading
      selectedNodeIds.value.clear();
      selectedEdgeIds.value.clear();
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to load exploration';
      error.value = errorMessage;
    } finally {
      loading.value = false;
    }
  }

  function clear() {
    nodes.value = [];
    edges.value = [];
    currentContext.value = null;
    currentExploration.value = null;
    selectedNodeIds.value.clear();
    selectedEdgeIds.value.clear();
    nodePositions.value.clear();
    nodePropertyIconConfigs.value = new Map();
    graphQuery.value = '';  // Reset query so user must execute one to save exploration
    ctePrefilter.value = '';
    layoutAlgorithm.value = 'force';
    layoutModeConfig.value = defaultLayoutModeConfig();
    resetFilters();
    resetTranspileOptions();
  }

  // Reverse-direction mutual exclusion: enabling community radial layout (a plain ref
  // toggled by v-model) reverts any non-force layout mode. setLayoutAlgorithm('force')
  // does not touch the radial toggle, so this cannot loop.
  const communityStoreForLayout = useCommunityStore();
  watch(
    () => communityStoreForLayout.radialLayoutEnabled,
    (enabled) => {
      if (enabled && layoutAlgorithm.value !== 'force') {
        layoutAlgorithm.value = 'force';
      }
    }
  );

  return {
    // State
    nodes,
    edges,
    currentContext,
    currentExploration,
    selectedNodeIds,
    selectedEdgeIds,
    loading,
    loadingMessage,
    freshLayoutRequested,
    error,
    queryError,
    clearQueryError,
    filters,
    viewport,
    layoutAlgorithm,
    layoutModeConfig,
    force3DSettings,
    layoutExecution,
    behaviors,
    aesthetics,
    graphQuery,
    ctePrefilter,
    vlpRenderingMode,
    materializationStrategy,
    proceduralOptimizations,
    useExternalLinks,
    nodePositions,
    textFormatRules,
    textFormatDefaults,

    // Hover state
    hoveredNodeId,
    lensPaused,

    // Computed
    selectedNode,
    selectedEdge,
    nodeTypes,
    edgeTypes,
    hasMultiEdges,
    multiEdgeStats,
    enhancedHasMultiEdges,
    enhancedMultiEdgeStats,
    hasSelfEdges,
    nodeDegrees,
    maxDegree,
    hubNodeIds,
    numericNodeProperties,
    categoricalNodeProperties,
    filteredNodes,
    filteredEdges,
    displayNodes,
    displayEdges,
    tableFilteredNodeIds,
    tableFilteredEdgeIds,
    setTableFilteredIds,
    enhancedNodes,
    enhancedEdges,
    searchMatchedNodeIds,
    searchHiddenNodeIds,
    propertyFilterHiddenNodeIds,
    propertyFilterHiddenEdgeIds,
    focusedNodeIds,

    // Actions
    loadContext,
    loadSubgraph,
    expandFromNode,
    executeGraphQuery,
    executeCypherQuery,
    transpileCypher,
    lastTranspiledSql,
    // Cancellable graph-query progress/cancel (consumed by the graph overlay)
    queryChunkProgress,
    queryCanCancel,
    cancelGraphQuery,
    setGraphQuery,
    selectNode,
    selectEdge,
    clearSelection,
    applyFilters,
    resetFilters,
    resetTranspileOptions,
    addNodePropertyFilter,
    updateNodePropertyFilter,
    removeNodePropertyFilter,
    addEdgePropertyFilter,
    updateEdgePropertyFilter,
    removeEdgePropertyFilter,
    setLayoutAlgorithm,
    updateLayoutModeConfig,
    updateForce3DSettings,
    updateLayoutExecution,
    updateBehaviors,
    updateAesthetics,
    nodeTypeColors,
    edgeTypeColors,
    defaultColorPalette,
    getNodeTypeColor,
    getEdgeTypeColor,
    setNodeTypeColor,
    setEdgeTypeColor,
    resetTypeColors,
    nodeTypeIcons,
    getNodeTypeIcon,
    setNodeTypeIcon,
    resetNodeTypeIcons,
    nodePropertyIconConfigs,
    getNodePropertyIconConfig,
    setNodePropertyIconConfig,
    resetNodePropertyIconConfigs,
    getDistinctPropertyValues,
    edgeTypeIcons,
    getEdgeTypeIcon,
    setEdgeTypeIcon,
    resetEdgeTypeIcons,
    updateNodePosition,
    toggleNodePinned,
    getExplorationState,
    saveExploration,
    loadExploration,
    clear,

    // Text format rules
    addTextFormatRule,
    updateTextFormatRule,
    removeTextFormatRule,
    setTextFormatRuleEnabled,
    updateTextFormatDefaults,
    reorderTextFormatRules,
    getTextFormatState,
    loadTextFormatState,
  };
});
