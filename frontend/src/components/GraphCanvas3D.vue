<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue';
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { useGraphStore } from '@/stores/graph';
import { useMetricsStore } from '@/stores/metrics';
import { useCommunityStore } from '@/stores/community';
import { useSimilarityStore } from '@/stores/similarity';
import type { Node, Edge } from '@/types/graph';
import type { GraphNode, GraphLink, GraphData } from '@/types/graph3d';
import { formatNodeLabel, formatEdgeLabel } from '@/utils/labelFormatter';
import {
  getMultiEdgeCurvature3D,
  computeNodeAppearance,
  computeLinkAppearance,
  type AppearanceContext,
} from '@/utils/graphAppearance';
import { applyForceConfig, applyCommunityRadialForce, applyEdgeTypeLayoutForce, computeAdaptiveLayoutParams } from '@/utils/forceConfig3D';
import { computeTreeLayout, computeHivePositions, computeRingGuideSpec, computeHiveAxesSpec, computeHiveLinkCurvatures, computeEgoLinkCurvatures } from '@/utils/layoutModes';
import { useLayoutGuides } from '@/composables/useLayoutGuides';
import { useToast } from '@/composables/useToast';
import { forcePointerRepulsion, type PointerRepulsionForce } from '@/utils/forcePointerRepulsion';
import { useGraphLabels } from '@/composables/useGraphLabels';
import { useGraphIcons } from '@/composables/useGraphIcons';
import { useGraphEdgeIcons } from '@/composables/useGraphEdgeIcons';
import { useGraphLayout } from '@/composables/useGraphLayout';
import { useGraphCamera } from '@/composables/useGraphCamera';
import { useAxisConstrainedRotation } from '@/composables/useAxisConstrainedRotation';
import { useContextMenu, type ContextMenuTarget } from '@/composables/useContextMenu';
import GraphContextMenu from '@/components/GraphContextMenu.vue';
import { Network } from 'lucide-vue-next';
import { recordPerf } from '@/utils/perfMetrics';
import { isStationaryRightClick, resolveContextMenuTarget } from '@/utils/contextMenuTrigger';
import { settleLayoutAuto } from '@/utils/settleLayoutClient';
import { seedNewNodePositions } from '@/utils/seedNewNodePositions';
import { useDevPerf } from '@/composables/useDevPerf';

const emit = defineEmits<{
  'cluster-node-click': [clusterId: string]
}>();

const graphStore = useGraphStore();
const metricsStore = useMetricsStore();
const communityStore = useCommunityStore();
const similarityStore = useSimilarityStore();

const backgroundColor = '#fafafa';
const wrapperRef = ref<HTMLDivElement | null>(null);
const containerRef = ref<HTMLDivElement | null>(null);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let graph3d: any = null;
const getGraph3d = () => graph3d;

// E.2 — headless settle: for graphs above this edge count, compute the force
// layout off the render loop (see settleLayoutHeadless) instead of animating it.
const HEADLESS_SETTLE_EDGE_THRESHOLD = 2000;
// Monotonic token to guard against overlapping async initGraph() runs.
let initToken = 0;

// Shared layout state (component owns, composables operate on)
const isLayoutRunning = ref(true);
const layoutStabilized = ref(false);
const initialLayoutDone = ref(false);
const isWarmingUp = ref(false);
// Headless-settle overlay state
const isHeadlessSettling = ref(false);
const settleProgress = ref(0);
// Post-settle synchronous scene build ("Rendering graph…") — keeps the overlay
// up through graph3d.graphData() (instanced-mesh build + shader compile + force
// re-init), which is the one main-thread block we cannot chunk (vendored lib).
const isRenderingScene = ref(false);

/** Resolve after the browser has painted the current state (one full frame). */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

// Last-computed adaptive force overrides (not user-facing — only theta/alphaDecay/velocityDecay)
let lastForceOverrides: Partial<import('@/utils/forceConfig3D').Force3DSettings> = {};

// Store settings + adaptive overrides — single source for every applyForceConfig
// call site (including the settings watcher, which used to clobber the overrides)
function effectiveForceSettings() {
  return { ...graphStore.force3DSettings, ...lastForceOverrides };
}

// Min arc length between ring neighbors in the ego layout (ring radii adapt to this)
const EGO_MIN_NODE_ARC = 26;

// Hover debounce state
let hoverRAF: number | null = null;
let lensHoverTimeout: ReturnType<typeof setTimeout> | null = null;
const LENS_HOVER_DEBOUNCE_MS = 120;

// Mouse position tracking for tooltip placement
const mouseX = ref(0);
const mouseY = ref(0);

// Dev perf overlay (no-op in production)
const devPerf = useDevPerf();

// Context menu
const contextMenu = useContextMenu();
let rightClickMouseDownPos: { x: number; y: number } | null = null;
// Menu target captured at right-button PRESS time. Resolving it at mouseup is unreliable:
// any pointer jitter while the button is held makes the library flag a drag, and its next
// render tick then force-fires a hover-out that wipes the hover state before mouseup runs
// (a tick lands mid-click whenever frames are slower than the click itself).
let rightClickDownTarget: ContextMenuTarget | null = null;
// Hovered node/link tracked synchronously (no RAF debounce) so the right-click mousedown
// handler can resolve its target — the library's onNodeRightClick is unreliable because
// any 1px pointer jitter while the button is held makes it treat the click as a drag
// and skip the callback entirely (see maybeOpenContextMenu).
let hoveredNodeSync: GraphNode | null = null;
let hoveredLinkSync: GraphLink | null = null;

// Map-style pan (right-drag) state
let isMapPanning = false;
let lastPanPos: { x: number; y: number } | null = null;

// Tooltip state
const tooltipVisible = ref(false);
const tooltipX = ref(0);
const tooltipY = ref(0);
const tooltipContent = ref<{ title: string; type: string } | null>(null);

// Soprador/Aspirador (pointer repulsion/attraction) state — d3-force with node pinning
let pointerRepulsionForce: PointerRepulsionForce | null = null;
const isBlowerActive = ref(false); // true when either blower or vacuum is active
let pointerToolSign = 1;           // +1 = blower (repel), -1 = vacuum (attract)
const blowerRaycaster = new THREE.Raycaster();
const blowerPointer = new THREE.Vector2();
let savedCooldownTicks: number | null = null;
let blowerStartTime = 0;
let blowerRAF: number | null = null;
const BLOWER_RAMP_DURATION = 1500; // ms to reach full strength/range

// Track whether pointer is over the 3D canvas (shortcuts only active when true)
let isPointerOverCanvas = false;
let isSpaceHeld = false;

// Clipping plane state
const clippingPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
const isClippingActive = ref(false);

// Event handler refs for cleanup
let _onKeyDown: ((e: KeyboardEvent) => void) | null = null;
let _onKeyUp: ((e: KeyboardEvent) => void) | null = null;
let _onWheel: ((e: WheelEvent) => void) | null = null;
let _onMouseDown: ((e: MouseEvent) => void) | null = null;
let _onMouseMove: ((e: MouseEvent) => void) | null = null;
let _onMouseUp: ((e: MouseEvent) => void) | null = null;

// Pre-computed set of non-hub nodes connected to hubs (for node dimming)
const degreeDimmedNodeIds = computed(() => {
  const hubs = graphStore.hubNodeIds;
  if (hubs === null) return null;

  const dimmed = new Set<string>();
  for (const edge of graphStore.edges) {
    const srcIsHub = hubs.has(edge.src);
    const dstIsHub = hubs.has(edge.dst);
    if (srcIsHub && !dstIsHub) dimmed.add(edge.dst);
    if (!srcIsHub && dstIsHub) dimmed.add(edge.src);
  }

  if (graphStore.behaviors.degreeDimPreserveBridges && dimmed.size > 0) {
    const hubConnected = new Set(hubs);
    for (const id of dimmed) hubConnected.add(id);

    const adj = new Map<string, string[]>();
    for (const edge of graphStore.edges) {
      if (dimmed.has(edge.src)) {
        if (!adj.has(edge.src)) adj.set(edge.src, []);
        adj.get(edge.src)!.push(edge.dst);
      }
      if (dimmed.has(edge.dst)) {
        if (!adj.has(edge.dst)) adj.set(edge.dst, []);
        adj.get(edge.dst)!.push(edge.src);
      }
    }

    for (const nodeId of [...dimmed]) {
      const neighbors = adj.get(nodeId);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!hubConnected.has(neighbor)) {
            dimmed.delete(nodeId);
            break;
          }
        }
      }
    }
  }

  return dimmed.size > 0 ? dimmed : null;
});

// Use all nodes/edges to preserve positions when filters change
const allNodes = computed(() => graphStore.nodes);
const allEdges = computed(() => graphStore.edges);

// Nodes hidden by the active layout mode (ego maxHops cutoff); additive with filters
const layoutHiddenNodeIds = ref<Set<string> | null>(null);

// Hidden sets for visual hiding (preserves positions unlike filtering)
const searchHiddenNodeIds = computed(() => graphStore.searchHiddenNodeIds);
const propertyFilterHiddenNodeIds = computed(() => graphStore.propertyFilterHiddenNodeIds);
const propertyFilterHiddenEdgeIds = computed(() => graphStore.propertyFilterHiddenEdgeIds);
const focusedNodeIds = computed(() => graphStore.focusedNodeIds);

// Use enhanced nodes/edges to include clusters
const filteredNodes = computed(() => graphStore.enhancedNodes);
const filteredEdges = computed(() => graphStore.enhancedEdges);

// Store original node/edge data for tooltips
const nodeDataMap = ref<Map<string, Node>>(new Map());
const edgeDataMap = ref<Map<string, Edge>>(new Map());

// ---------------------------------------------------------------------------
// Composables
// ---------------------------------------------------------------------------

const labels = useGraphLabels(getGraph3d, initialLayoutDone, degreeDimmedNodeIds, focusedNodeIds);
const icons = useGraphIcons(getGraph3d, initialLayoutDone);
const edgeIcons = useGraphEdgeIcons(getGraph3d, initialLayoutDone);

const layout = useGraphLayout(
  getGraph3d,
  { isLayoutRunning, layoutStabilized, initialLayoutDone },
  { setLabelsVisible: labels.setLabelsVisible, updateLabels: () => updateOverlays() },
  () => graphStore.layoutExecution,
  () => graphStore.behaviors.viewMode === '2d-proj',
  // Static modes own the node pins — start/reheat/scramble must not release them
  () => ['hive', 'ego', 'hierarchical'].includes(graphStore.layoutAlgorithm),
);

const guides = useLayoutGuides(getGraph3d);
const toast = useToast();

const camera = useGraphCamera(getGraph3d, containerRef, initialLayoutDone, {
  setLabelsVisible: labels.setLabelsVisible,
  setIconsVisible: (visible: boolean) => { icons.setIconsVisible(visible); edgeIcons.setIconsVisible(visible); },
  setSelfEdgesVisible,
  updateVisuals,
  updateLabels: () => updateOverlays(),
});

const axisRotation = useAxisConstrainedRotation(
  getGraph3d,
  containerRef,
  () => isPointerOverCanvas,
  computed(() => graphStore.behaviors.viewMode === '2d-proj'),
);

// ---------------------------------------------------------------------------
// Appearance context — collected once per update pass
// ---------------------------------------------------------------------------

function collectAppearanceContext(): AppearanceContext {
  const searchMatched = graphStore.searchMatchedNodeIds;
  const nodeSizeMetric = metricsStore.nodeSizeMetric;

  // Pre-compute color maps: avoids O(n) store lookups per node/link inside hot loop
  const nodeColorMap = new Map<string, string>();
  for (const type of graphStore.nodeTypes) {
    nodeColorMap.set(type, graphStore.getNodeTypeColor(type));
  }
  const edgeColorMap = new Map<string, string>();
  for (const type of graphStore.edgeTypes) {
    edgeColorMap.set(type, graphStore.getEdgeTypeColor(type));
  }

  // Convert nodeTypeFilter to Set for O(1) lookups instead of Array.includes O(n)
  const nodeTypeFilterSet = new Set(graphStore.filters.node_types);
  const edgeTypeFilterSet = new Set(graphStore.filters.edge_types);

  return {
    baseNodeSize: graphStore.aesthetics.nodeSize,
    nodeOpacity: graphStore.aesthetics.nodeOpacity,
    edgeOpacity: graphStore.aesthetics.edgeOpacity,

    nodeTypeFilter: graphStore.filters.node_types,
    hasNodeTypeFilter: graphStore.filters.node_types.length > 0,
    nodeTypeFilterSet,
    edgeTypeFilter: graphStore.filters.edge_types,
    hasEdgeTypeFilter: graphStore.filters.edge_types.length > 0,
    edgeTypeFilterSet,

    searchMode: graphStore.behaviors.searchMode,
    searchMatchedIds: searchMatched,
    searchHiddenIds: searchHiddenNodeIds.value,
    isHighlightMode: graphStore.behaviors.searchMode === 'highlight' && searchMatched !== null,

    propFilterHiddenNodeIds: propertyFilterHiddenNodeIds.value,
    propFilterHiddenEdgeIds: propertyFilterHiddenEdgeIds.value,

    layoutHiddenNodeIds: layoutHiddenNodeIds.value,

    tableVisibleNodeIds: graphStore.tableFilteredNodeIds,
    tableVisibleEdgeIds: graphStore.tableFilteredEdgeIds,

    focusedNodeIds: focusedNodeIds.value,
    edgeLensMode: graphStore.behaviors.edgeLensMode,
    edgeLensDimOpacity: graphStore.behaviors.edgeLensDimOpacity,

    dimmedByDegreeIds: degreeDimmedNodeIds.value,
    degreeDimOpacity: graphStore.behaviors.degreeDimOpacity,

    hubNodeIds: graphStore.hubNodeIds,

    selectedNodeIds: graphStore.selectedNodeIds,

    nodeSizeMetric: nodeSizeMetric
      ? { values: nodeSizeMetric.values, min: nodeSizeMetric.min, max: nodeSizeMetric.max }
      : null,
    nodeSizeMapping: metricsStore.visualMapping.nodeSize,

    getNodeTypeColor: (type: string) => nodeColorMap.get(type) || '#888888',
    getEdgeTypeColor: (type: string) => edgeColorMap.get(type) || '#888888',

    communityColorMap: communityStore.communityColorMap,
  };
}

// ---------------------------------------------------------------------------
// Graph data building
// ---------------------------------------------------------------------------

/** Yield the main thread (macrotask) so input/paint can run between chunks. */
function yieldMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Max synchronous work per chunk before yielding the main thread. */
const BUILD_CHUNK_BUDGET_MS = 12;

/**
 * Build the node/link arrays for the 3D engine.
 *
 * Chunked: on large graphs the per-node/per-edge work (appearance + label
 * formatting) used to block the main thread for seconds in one synchronous
 * pass. The loops now yield every ~12ms so the UI stays responsive; the
 * settle/render overlay communicates progress. Returns null when superseded
 * (a newer init/update bumped the token) — callers must bail out.
 */
async function buildGraphData(shouldAbort?: () => boolean): Promise<GraphData | null> {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];

  // Snapshot the source arrays once: the loops below yield to the main thread,
  // and reactive recomputes mid-build must not swap arrays under the iteration.
  const srcNodes = filteredNodes.value;
  const srcEdges = filteredEdges.value;

  // Build data maps for tooltips (use all nodes/edges)
  nodeDataMap.value.clear();
  edgeDataMap.value.clear();

  allNodes.value.forEach((node) => {
    nodeDataMap.value.set(node.node_id, node);
  });
  srcNodes.forEach((node) => {
    if (!nodeDataMap.value.has(node.node_id)) {
      nodeDataMap.value.set(node.node_id, node);
    }
  });
  allEdges.value.forEach((edge) => {
    edgeDataMap.value.set(edge.edge_id, edge);
  });

  const ctx = collectAppearanceContext();

  let chunkStart = performance.now();
  for (const node of srcNodes) {
    if (performance.now() - chunkStart > BUILD_CHUNK_BUDGET_MS) {
      await yieldMain();
      if (shouldAbort?.()) return null;
      chunkStart = performance.now();
    }
    const isCluster = node.node_type === '__cluster__';
    const clusterNodeCount = isCluster ? ((node.properties?.node_count as number) || 1) : 0;
    const clusterBaseSize = isCluster ? Math.min(Math.sqrt(clusterNodeCount) * 5 + 10, 50) : 0;
    const clusterColor = isCluster ? (node.properties?.color as string || null) : null;

    const appearance = computeNodeAppearance(
      node.node_id, node.node_type, isCluster, clusterBaseSize, clusterColor, ctx,
    );

    const nodeLabel = isCluster
      ? (node.properties?.cluster_name as string || 'Cluster')
      : formatNodeLabel(node, graphStore.textFormatRules, graphStore.textFormatDefaults.nodeTemplate);

    // Compute property-based icon override (if configured for this node type)
    let iconOverride: string | undefined;
    if (!isCluster) {
      const propConfig = graphStore.getNodePropertyIconConfig(node.node_type);
      if (propConfig) {
        const propVal = node.properties?.[propConfig.property];
        if (propVal != null && propVal !== '') {
          iconOverride = propConfig.valueIcons[String(propVal)];
        }
        // Fall back to fallbackIcon for null/unspecified
        if (!iconOverride && propConfig.fallbackIcon) {
          iconOverride = propConfig.fallbackIcon;
        }
      }
    }

    nodes.push({
      id: node.node_id,
      label: nodeLabel,
      nodeType: node.node_type,
      color: appearance.color,
      size: appearance.size,
      hidden: appearance.hidden,
      isCluster,
      iconOverride,
    });
  }

  const nodeIds = new Set(nodes.map(n => n.id));
  const hiddenNodeIds = new Set(nodes.filter(n => n.hidden).map(n => n.id));

  const useMultiEdgeCurvature = graphStore.enhancedHasMultiEdges && graphStore.aesthetics.enableMultiEdgeCurvature;
  const pairEdges = useMultiEdgeCurvature ? graphStore.enhancedMultiEdgeStats.pairEdges : null;

  const edgeCurvatureInfo = new Map<string, { indexInSub: number; subCount: number; reversed: boolean; hasOpposite: boolean }>();
  if (useMultiEdgeCurvature && pairEdges) {
    for (const [, edges] of pairEdges) {
      if (edges.length > 1) {
        // Split into forward (src < dst) and reverse (src > dst) sub-groups
        const forward: Edge[] = [];
        const reverse: Edge[] = [];
        for (const e of edges) {
          if (e.src > e.dst) reverse.push(e);
          else forward.push(e);
        }
        // Stable sort within each sub-group by edge_id
        forward.sort((a, b) => a.edge_id.localeCompare(b.edge_id));
        reverse.sort((a, b) => a.edge_id.localeCompare(b.edge_id));
        const hasOpposite = forward.length > 0 && reverse.length > 0;
        for (let i = 0; i < forward.length; i++) {
          edgeCurvatureInfo.set(forward[i].edge_id, { indexInSub: i, subCount: forward.length, reversed: false, hasOpposite });
        }
        for (let i = 0; i < reverse.length; i++) {
          edgeCurvatureInfo.set(reverse[i].edge_id, { indexInSub: i, subCount: reverse.length, reversed: true, hasOpposite });
        }
      }
    }
  }

  chunkStart = performance.now();
  for (const edge of srcEdges) {
    if (performance.now() - chunkStart > BUILD_CHUNK_BUDGET_MS) {
      await yieldMain();
      if (shouldAbort?.()) return null;
      chunkStart = performance.now();
    }
    if (!nodeIds.has(edge.src) || !nodeIds.has(edge.dst)) continue;

    const edgeLabel = formatEdgeLabel(
      edge, graphStore.textFormatRules, graphStore.textFormatDefaults.edgeTemplate,
    );

    const isSimilarity = edge.relationship_type === '__similarity__';
    const edgeScore = isSimilarity ? (edge.properties?.score as number | undefined) : undefined;
    const appearance = computeLinkAppearance(
      edge.edge_id, edge.relationship_type, edge.src, edge.dst, hiddenNodeIds, ctx, edgeScore,
    );

    const curveInfo = edgeCurvatureInfo.get(edge.edge_id);
    const isSelfEdge = edge.src === edge.dst;
    let curvature = 0;
    if (isSelfEdge) {
      curvature = curveInfo ? 0.3 + curveInfo.indexInSub * 0.15 : 0.3;
    } else if (curveInfo) {
      // All edges in the same direction sub-group get the same sign of curvature.
      // calcLinkCurve computes the perpendicular relative to source→target direction,
      // so A→B with +c and B→A with +c naturally bend to OPPOSITE visual sides
      // (because B→A's direction vector is reversed, flipping the perpendicular).
      curvature = getMultiEdgeCurvature3D(curveInfo.indexInSub, curveInfo.subCount, curveInfo.hasOpposite);
    }

    links.push({
      id: edge.edge_id,
      source: edge.src,
      target: edge.dst,
      relationshipType: edge.relationship_type,
      label: edgeLabel,
      color: appearance.color,
      hidden: appearance.hidden,
      curvature,
      isSimilarity,
      score: edgeScore,
    });
  }

  return { nodes, links };
}

// ---------------------------------------------------------------------------
// Visual updates (no simulation restart)
// ---------------------------------------------------------------------------

/** Update labels + icons together. Use this instead of calling labels.updateLabels() alone. */
function updateOverlays() {
  labels.updateLabels();
  icons.updateIcons();
  edgeIcons.updateIcons();
}

function updateVisuals() {
  if (!graph3d) return;

  const t0 = performance.now();
  const currentData = graph3d.graphData();
  const ctx = collectAppearanceContext();
  const hiddenNodeIds = new Set<string>();

  currentData.nodes.forEach((node: GraphNode) => {
    const isCluster = node.isCluster || false;
    const clusterBaseSize = isCluster ? node.size : 0;

    const appearance = computeNodeAppearance(
      node.id, node.nodeType, isCluster, clusterBaseSize, null, ctx,
    );

    node.size = appearance.size;
    node.hidden = appearance.hidden;

    // Recompute property-based icon override
    if (!isCluster) {
      const propConfig = graphStore.getNodePropertyIconConfig(node.nodeType);
      if (propConfig) {
        const origNode = nodeDataMap.value.get(node.id);
        const propVal = origNode?.properties?.[propConfig.property];
        let override: string | undefined;
        if (propVal != null && propVal !== '') {
          override = propConfig.valueIcons[String(propVal)];
        }
        if (!override && propConfig.fallbackIcon) {
          override = propConfig.fallbackIcon;
        }
        node.iconOverride = override;
      } else {
        node.iconOverride = undefined;
      }
    }

    // Icon replacement: hide sphere (transparent) but preserve color for icon composable
    const hasIcon = !isCluster && (graphStore.nodeTypeIcons.has(node.nodeType) || !!node.iconOverride);
    if (hasIcon) {
      node.__iconColor = appearance.color;
      node.color = 'rgba(0,0,0,0)';
    } else {
      node.__iconColor = undefined;
      node.color = appearance.color;
    }

    if (appearance.hidden) hiddenNodeIds.add(node.id);
  });

  const t1 = performance.now();

  currentData.links.forEach((link: GraphLink) => {
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;

    const appearance = computeLinkAppearance(
      link.id, link.relationshipType, sourceId, targetId, hiddenNodeIds, ctx, link.score,
    );

    link.color = appearance.color;
    link.hidden = appearance.hidden;
  });

  const t2 = performance.now();

  graph3d.nodeColor((node: GraphNode) => node.color);
  graph3d.nodeVal((node: GraphNode) => node.hidden ? 0 : node.size);
  graph3d.nodeVisibility((node: GraphNode) => !node.hidden);
  graph3d.linkColor((link: GraphLink) => link.color);
  graph3d.linkVisibility((link: GraphLink) => !link.hidden);

  // Update icon billboards (must be after node appearance is computed)
  icons.updateIcons();

  const t3 = performance.now();
  recordPerf('updateVisuals', t3 - t0, {
    nodes: t1 - t0,
    links: t2 - t1,
    kapsule: t3 - t2,
    nodeCount: currentData.nodes.length,
    linkCount: currentData.links.length,
  });
}

/**
 * Refresh what node properties feed into, after a progressive-load patch.
 *
 * Labels are baked once in buildGraphData, so they must be recomputed here;
 * icon overrides and appearance are handled by updateVisuals, which reads the
 * (patched) originals out of nodeDataMap. Crucially this does NOT call
 * graph3d.graphData() — no Three.js rebuild, no layout reheat, positions
 * untouched.
 */
function refreshNodeContent() {
  if (!graph3d) return;

  const t0 = performance.now();
  const currentData = graph3d.graphData();

  for (const node of currentData.nodes as GraphNode[]) {
    if (node.isCluster) continue;
    const original = nodeDataMap.value.get(node.id);
    if (!original) continue;
    node.label = formatNodeLabel(
      original,
      graphStore.textFormatRules,
      graphStore.textFormatDefaults.nodeTemplate,
    );
  }

  updateVisuals();
  updateOverlays();
  recordPerf('refreshNodeContent', performance.now() - t0, {
    nodeCount: currentData.nodes.length,
  });
}

// Progressive load: properties arriving in background batches change labels and
// icons but never node/edge counts, so the data watcher above stays silent by
// design. This explicit signal is the only refresh path.
watch(() => graphStore.nodePatchVersion, (version) => {
  if (version > 0) refreshNodeContent();
});

// ---------------------------------------------------------------------------
// Self-edge visibility toggle (O(n) scan, O(1) Three.js toggle per self-edge)
// ---------------------------------------------------------------------------

function setSelfEdgesVisible(visible: boolean) {
  if (!graph3d) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graph3d.graphData().links.forEach((link: any) => {
    if (!link.__isSelfLoop) return;
    if (link.__lineObj) link.__lineObj.visible = visible;
    if (link.__arrowObj) link.__arrowObj.visible = visible;
  });
}

// ---------------------------------------------------------------------------
// Full graph data update (restarts simulation) - use sparingly
// ---------------------------------------------------------------------------

async function updateGraph() {
  if (!graph3d) return;
  const myToken = ++initToken;

  // Large graphs: show the build overlay through the (chunked) data build —
  // the query-loading overlay has already dropped by the time we run.
  if (filteredEdges.value.length > HEADLESS_SETTLE_EDGE_THRESHOLD) {
    isRenderingScene.value = true;
    await nextPaint();
    if (!graph3d || initToken !== myToken) return;
  }

  const tBuild = performance.now();
  const graphData = await buildGraphData(() => initToken !== myToken);
  if (!graphData || !graph3d || initToken !== myToken) return; // superseded while chunking
  recordPerf('buildGraphData', performance.now() - tBuild, {
    nodeCount: graphData.nodes.length,
    linkCount: graphData.links.length,
  });

  const currentData = graph3d.graphData();
  const positionMap = new Map<string, { x: number; y: number; z: number }>();
  currentData.nodes.forEach((node: GraphNode) => {
    if (node.x !== undefined && node.y !== undefined && node.z !== undefined) {
      positionMap.set(node.id, { x: node.x, y: node.y, z: node.z });
    }
  });

  let hasNewNodes = false;
  let newNodeCount = 0;
  graphData.nodes.forEach((node) => {
    const pos = positionMap.get(node.id);
    if (pos) {
      node.x = pos.x;
      node.y = pos.y;
      node.z = pos.z;
      if (!isLayoutRunning.value) {
        node.fx = pos.x;
        node.fy = pos.y;
        node.fz = pos.z;
      }
    } else {
      hasNewNodes = true;
      newNodeCount++;
    }
  });

  // Recompute adaptive params for the new data size
  const adaptiveUpdate = computeAdaptiveLayoutParams(graphData.nodes.length, graphData.links.length);
  lastForceOverrides = adaptiveUpdate.forceOverrides;

  // A REPLACE op (query/subgraph/cypher) always wants a fresh layout, even when
  // some node ids overlap the previous graph; expand/filter stay incremental.
  const freshRequested = graphStore.freshLayoutRequested;
  if (freshRequested) graphStore.freshLayoutRequested = false;

  // E.2 — headless settle for a FRESH large layout (initial load / new query
  // result). Incremental updates (expand adds a few nodes, filter toggles) keep
  // their preserved positions and animate as before. Fully fallback-safe.
  let preSettled = false;
  const isFreshLargeLayout =
    graphData.links.length > HEADLESS_SETTLE_EDGE_THRESHOLD &&
    (freshRequested || newNodeCount > graphData.nodes.length * 0.9);

  // Incremental addition on a LARGE graph (expand-from-node etc.): place the
  // few new nodes next to a positioned neighbor and pin them — no global
  // reheat (which would unpin + perturb every node and re-run the whole
  // simulation just to fit a handful of nodes). Existing positions stay
  // exactly as they are. Small graphs (≤ threshold) keep the organic global
  // re-layout below — exact, no approximation, and cheap at that size.
  let incrementallyPlaced = false;
  if (
    hasNewNodes &&
    !isFreshLargeLayout &&
    !freshRequested &&
    graphData.links.length > HEADLESS_SETTLE_EDGE_THRESHOLD
  ) {
    seedNewNodePositions(
      graphData.nodes,
      graphData.links as { source: string; target: string }[],
      positionMap,
      { is2D: graphStore.behaviors.viewMode === '2d-proj' },
    );
    incrementallyPlaced = true;
  }

  if (isFreshLargeLayout) {
    try {
      isHeadlessSettling.value = true;
      isRenderingScene.value = false; // switch overlay to the settle-progress text
      settleProgress.value = 0;
      // Destroy the old rendered graph BEFORE computing the new layout: the
      // render loop stops drawing the (large) old scene during the settle and
      // its GPU objects are freed early. The settle works on `graphData` (a
      // plain JS object), independent of what the engine currently renders.
      graph3d.graphData({ nodes: [], links: [] });
      const is2D = graphStore.behaviors.viewMode === '2d-proj';
      const tSettle = performance.now();
      await settleLayoutAuto(
        graphData.nodes,
        graphData.links,
        effectiveForceSettings(),
        {
          numDimensions: is2D ? 2 : 3,
          nodeRelSize: graphStore.aesthetics.nodeSize / 2,
          onProgress: (f) => { settleProgress.value = f; },
          shouldAbort: () => initToken !== myToken,
        },
      );
      recordPerf('headlessSettle', performance.now() - tSettle, {
        nodeCount: graphData.nodes.length,
        linkCount: graphData.links.length,
      });
      // Pin the settled positions so the engine renders them exactly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const n of graphData.nodes as any[]) {
        n.fx = n.x;
        n.fy = n.y;
        n.fz = is2D ? 0 : n.z;
      }
      preSettled = true;
    } catch (e) {
      console.warn('[GraphCanvas3D] headless settle (update) failed; animated', e);
      isHeadlessSettling.value = false;
    }
    // A newer update/init superseded this one while we awaited — bail out.
    if (!graph3d || initToken !== myToken) {
      isHeadlessSettling.value = false;
      return;
    }
    if (preSettled) {
      // Switch the overlay to the render stage and let it PAINT before the
      // synchronous graph3d.graphData() below (instanced-mesh build + shader
      // compile + force re-init — the one block we can't chunk). Previously
      // the overlay dropped here and that block ran over a blank canvas.
      isRenderingScene.value = true;
      isHeadlessSettling.value = false;
      await nextPaint();
      if (!graph3d || initToken !== myToken) {
        isRenderingScene.value = false;
        return;
      }
    }
  }

  graphStore.updateLayoutExecution(
    preSettled
      ? { cooldownTicks: 0, ticksPerFrame: 1, warmupTicks: 0 }
      : {
          cooldownTicks: adaptiveUpdate.cooldownTicks,
          ticksPerFrame: adaptiveUpdate.ticksPerFrame,
          warmupTicks: adaptiveUpdate.warmupTicks,
        },
  );

  graph3d
    .warmupTicks(graphStore.layoutExecution.warmupTicks)
    .cooldownTicks(graphStore.layoutExecution.cooldownTicks)
    .ticksPerFrame(graphStore.layoutExecution.ticksPerFrame);

  // Measures only the synchronous part of the data swap (d3-force re-init +
  // the kapsule's state set). The kapsule defers its mesh build to a digest
  // tick, so the bulk of the cost lands in 'forcegraphUpdate' instead — read
  // the two together when attributing time to the swap.
  const tGraphData = performance.now();
  graph3d.graphData(graphData);
  recordPerf('graphDataApply', performance.now() - tGraphData, {
    nodes: graphData.nodes.length,
    links: graphData.links.length,
    preSettled: preSettled ? 1 : 0,
  });

  applyForceConfig(graph3d, effectiveForceSettings(), graphStore.aesthetics.nodeSize / 2, graphStore.behaviors.viewMode === '2d-proj');

  // Re-apply community radial forces after graph data update
  applyCommunityRadialForce(
    graph3d,
    communityStore.communityMap,
    communityStore.communityRadialConfig,
    graphStore.behaviors.viewMode === '2d-proj',
  );

  // Re-apply the active layout mode's constraints — hop counts and hive ranks
  // are data-dependent and go stale on every data swap
  applyLayoutModeForces();

  if (preSettled || (incrementallyPlaced && !isLayoutRunning.value)) {
    // Positions are already final: either the headless settle produced (and
    // pinned) the layout, or the incremental additions were seeded next to
    // their anchors. Reheating would unpin + perturb every node AND re-digest
    // the whole scene a second time (reheatLayout calls graph3d.graphData()
    // again). Stop instead: pins positions, flips initialLayoutDone and shows
    // labels immediately.
    layout.stopLayout();
  } else if (!isLayoutRunning.value && hasNewNodes) {
    layout.reheatLayout();
  } else if (!isLayoutRunning.value) {
    layout.stopLayout();
  }

  // A REPLACE op (fresh query) lands a brand-new layout the camera has never
  // framed — updateGraph historically never re-framed, so large results could
  // sit entirely off-screen ("blank" view until the user orbits). Frame it on
  // the first painted frame of the new scene.
  const shouldRefit = freshRequested || preSettled;

  // Drop the build overlay only after the new scene has actually painted.
  if (isRenderingScene.value || shouldRefit) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (initToken !== myToken) { isRenderingScene.value = false; return; }
      if (shouldRefit && graph3d) camera.zoomToFit();
      isRenderingScene.value = false;
    }));
  }
}

// ---------------------------------------------------------------------------
// Graph initialization
// ---------------------------------------------------------------------------

async function initGraph() {
  if (!containerRef.value) return;
  const myToken = ++initToken;

  if (graph3d) {
    // Free the old scene's guide geometry before the renderer goes away
    guides.dispose();
    // Dispose WebGL renderer to free the context (browsers limit to ~8-16 contexts)
    const renderer = graph3d.renderer?.() as THREE.WebGLRenderer | null;
    if (renderer) {
      renderer.forceContextLoss();
      renderer.dispose();
    }
    graph3d._destructor?.();
    graph3d = null;
  }

  containerRef.value.innerHTML = '';
  hoveredNodeSync = null;
  hoveredLinkSync = null;

  // Large graphs: show the build overlay through the (chunked) data build.
  if (filteredEdges.value.length > HEADLESS_SETTLE_EDGE_THRESHOLD) {
    isRenderingScene.value = true;
    await nextPaint();
    if (initToken !== myToken) return;
  }

  const tBuild = performance.now();
  const graphData = await buildGraphData(() => initToken !== myToken);
  if (!graphData || initToken !== myToken) return; // superseded while chunking
  recordPerf('buildGraphData', performance.now() - tBuild, {
    nodeCount: graphData.nodes.length,
    linkCount: graphData.links.length,
    init: 1,
  });
  const aesthetics = graphStore.aesthetics;

  // Compute adaptive layout params
  const adaptive = computeAdaptiveLayoutParams(graphData.nodes.length, graphData.links.length);
  lastForceOverrides = adaptive.forceOverrides;

  initialLayoutDone.value = false;
  isLayoutRunning.value = true;

  // E.2 — headless settle for large graphs: compute the layout OFF the render
  // loop (no per-frame render), then render once already settled. Runs on the
  // main thread in async chunks (UI stays responsive). Fully fallback-safe:
  // any failure or NaN falls through to the normal animated path.
  let preSettled = false;
  if (graphData.links.length > HEADLESS_SETTLE_EDGE_THRESHOLD) {
    try {
      isHeadlessSettling.value = true;
      isRenderingScene.value = false; // switch overlay to the settle-progress text
      settleProgress.value = 0;
      const is2D = graphStore.behaviors.viewMode === '2d-proj';
      const tSettle = performance.now();
      await settleLayoutAuto(
        graphData.nodes,
        graphData.links,
        effectiveForceSettings(),
        {
          numDimensions: is2D ? 2 : 3,
          nodeRelSize: aesthetics.nodeSize / 2,
          onProgress: (f) => { settleProgress.value = f; },
          shouldAbort: () => initToken !== myToken,
        },
      );
      recordPerf('headlessSettle', performance.now() - tSettle, {
        nodeCount: graphData.nodes.length,
        linkCount: graphData.links.length,
      });
      // Pin the settled positions (fx/fy/fz) so the engine renders them exactly
      // and can't kick them if it reheats — consistent with how the animated
      // path pins nodes once layout stops. A later reheat/scramble unpins them.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const n of graphData.nodes as any[]) {
        n.fx = n.x;
        n.fy = n.y;
        n.fz = is2D ? 0 : n.z;
      }
      preSettled = true;
    } catch (e) {
      console.warn('[GraphCanvas3D] headless settle failed; using animated layout', e);
      isHeadlessSettling.value = false;
    }
    // A newer initGraph() superseded this one while we awaited — bail out.
    if (initToken !== myToken) {
      isHeadlessSettling.value = false;
      return;
    }
    if (preSettled) {
      // Keep an overlay up through the synchronous ForceGraph3D creation +
      // graphData() digest below; let the "Rendering graph…" text paint first.
      isRenderingScene.value = true;
      isHeadlessSettling.value = false;
      await nextPaint();
      if (initToken !== myToken) {
        isRenderingScene.value = false;
        return;
      }
    }
  }

  // Pre-settled graphs render their final positions once (no warmup/cooldown so
  // the engine doesn't re-simulate); otherwise use the adaptive animated params.
  graphStore.updateLayoutExecution(
    preSettled
      ? { cooldownTicks: 0, ticksPerFrame: 1, warmupTicks: 0 }
      : {
          cooldownTicks: adaptive.cooldownTicks,
          ticksPerFrame: adaptive.ticksPerFrame,
          warmupTicks: adaptive.warmupTicks,
        },
  );
  isWarmingUp.value = !preSettled && adaptive.warmupTicks > 0;

  // First-mount counterpart to 'graphDataApply'. Covers the whole ForceGraph3D
  // construction because graphData() is chained into it and can't be isolated;
  // as there, the deferred mesh build shows up in 'forcegraphUpdate'.
  const tInitGraphData = performance.now();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graph3d = (ForceGraph3D as any)({ rendererConfig: { preserveDrawingBuffer: true, antialias: true } })(containerRef.value)
    .graphData(graphData)
    .nodeId('id')
    .nodeColor((node: GraphNode) => node.color)
    .nodeVal((node: GraphNode) => node.hidden ? 0 : node.size)
    .nodeRelSize(aesthetics.nodeSize / 2)
    .nodeOpacity(aesthetics.nodeOpacity)
    .nodeVisibility((node: GraphNode) => !node.hidden)
    .nodeThreeObject((node: GraphNode) => {
      if (!node.isCluster) return undefined;

      const nodeData = nodeDataMap.value.get(node.id);
      if (!nodeData) return undefined;

      const figure = nodeData.properties?.figure as string;
      const color = new THREE.Color(node.color);
      const size = Math.cbrt(node.size) * (aesthetics.nodeSize / 2);

      let geometry;
      if (figure === 'box') {
        geometry = new THREE.BoxGeometry(size * 2, size * 2, size * 2);
      } else if (figure === 'star') {
        geometry = new THREE.ConeGeometry(size, size * 2, 3);
      } else if (figure === 'diamond') {
        geometry = new THREE.OctahedronGeometry(size);
      } else if (figure === 'hexagon') {
        geometry = new THREE.CylinderGeometry(size, size, size * 0.5, 6);
      } else {
        return undefined;
      }

      const material = new THREE.MeshLambertMaterial({
        color,
        transparent: true,
        opacity: aesthetics.nodeOpacity,
      });

      return new THREE.Mesh(geometry, material);
    })
    .linkSource('source')
    .linkTarget('target')
    .linkColor((link: GraphLink) => link.color)
    .linkWidth((link: GraphLink) => link.hidden ? 0 : aesthetics.edgeWidth)
    .linkOpacity(aesthetics.edgeOpacity)
    .linkVisibility((link: GraphLink) => !link.hidden)
    .linkCurvature((link: GraphLink) => link.curvature ?? 0)
    .linkDirectionalArrowLength((link: GraphLink) =>
      link.isSimilarity ? 0 : (aesthetics.showArrows ? 4 * aesthetics.arrowSize : 0)
    )
    .linkDirectionalArrowRelPos(1)
    .useInstancedRendering(graphStore.behaviors.useInstancedRendering)
    .warmupTicks(graphStore.layoutExecution.warmupTicks)
    .cooldownTicks(graphStore.layoutExecution.cooldownTicks)
    .ticksPerFrame(graphStore.layoutExecution.ticksPerFrame)
    .backgroundColor(backgroundColor)
    .showNavInfo(false)
    .enableNodeDrag(graphStore.behaviors.enableNodeDrag)
    .onNodeDragEnd((node: GraphNode) => {
      // Pin node at drop position so it stays fixed after drag
      node.fx = node.x;
      node.fy = node.y;
      node.fz = node.z;
    })
    .onNodeClick((node: GraphNode, event: MouseEvent) => {
      if (node.isCluster) {
        emit('cluster-node-click', node.id);
        return;
      }
      // Alt+Click expands the node's neighbors (depth 1) — same as the context-menu action
      if (event.altKey && !graphStore.loading && graphStore.supportsExpand) {
        graphStore.selectNode(node.id);
        void graphStore.expandFromNode(node.id, 1);
        return;
      }
      // When graph lens is active, clicking the already-selected node pauses/resumes the lens
      if (graphStore.behaviors.edgeLensMode !== 'off'
        && !event.ctrlKey
        && graphStore.selectedNodeIds.size === 1
        && graphStore.selectedNodeIds.has(node.id)) {
        graphStore.lensPaused = !graphStore.lensPaused;
        return;
      }
      graphStore.selectNode(node.id, event.ctrlKey);
      // Progressive load: a node the user just opened jumps the enrichment
      // queue, so the detail panel fills in without waiting for its batch.
      void graphStore.prioritizeNodeProperties(node.id);
    })
    .onLinkClick((link: GraphLink, event: MouseEvent) => {
      graphStore.selectEdge(link.id, event.ctrlKey);
    })
    .onBackgroundClick(() => {
      graphStore.clearSelection();
    })
    .onNodeHover((node: GraphNode | null, _prevNode: GraphNode | null) => {
      hoveredNodeSync = node;
      const newHoverId = node?.id ?? null;
      if (hoverRAF !== null) cancelAnimationFrame(hoverRAF);
      hoverRAF = requestAnimationFrame(() => {
        graphStore.hoveredNodeId = newHoverId;
        hoverRAF = null;
      });

      if (node) {
        tooltipX.value = mouseX.value + 12;
        tooltipY.value = mouseY.value - 12;
        tooltipContent.value = { title: node.label, type: node.nodeType };
        tooltipVisible.value = true;
      } else {
        tooltipVisible.value = false;
        tooltipContent.value = null;
      }
    })
    .onLinkHover((link: GraphLink | null, _prevLink: GraphLink | null) => {
      hoveredLinkSync = link;
      if (link) {
        tooltipX.value = mouseX.value + 12;
        tooltipY.value = mouseY.value - 12;
        tooltipContent.value = { title: link.relationshipType, type: 'Edge' };
        tooltipVisible.value = true;
      } else {
        tooltipVisible.value = false;
        tooltipContent.value = null;
      }
    });
  // Context menu is NOT wired through onNodeRightClick/onLinkRightClick: the library
  // suppresses those callbacks whenever the pointer moved at all while the button was
  // held (any 1px jitter counts as a drag), which made the menu open only sometimes.
  // Instead the app-level mouseup handler (maybeOpenContextMenu) opens it.

  recordPerf('initGraphDataApply', performance.now() - tInitGraphData, {
    nodes: graphData.nodes.length,
    links: graphData.links.length,
    preSettled: preSettled ? 1 : 0,
  });

  const is2D = graphStore.behaviors.viewMode === '2d-proj';
  applyForceConfig(graph3d, effectiveForceSettings(), graphStore.aesthetics.nodeSize / 2, is2D);

  if (is2D) {
    graph3d.numDimensions(2);
  }

  // Re-apply community radial forces if active (survives initGraph re-init)
  applyCommunityRadialForce(
    graph3d,
    communityStore.communityMap,
    communityStore.communityRadialConfig,
    is2D,
  );

  // Re-apply the active layout mode's constraints (survives initGraph re-init,
  // including the auto-switch to 2D that re-inits the graph)
  applyLayoutModeForces();

  // Register blower force (stays disabled until Shift is held)
  pointerRepulsionForce = forcePointerRepulsion();
  pointerRepulsionForce.strength(graphStore.force3DSettings.pointerRepulsionStrength);
  pointerRepulsionForce.range(screenToWorldRange(graphStore.force3DSettings.pointerRepulsionRange));
  pointerRepulsionForce.sizeInertia(graphStore.force3DSettings.pointerSizeInertia);
  graph3d.d3Force('pointerRepulsion', pointerRepulsionForce);

  isWarmingUp.value = false;

  camera.startCameraTracking();

  graph3d.onEngineTick(() => {
    icons.updateIcons();
    edgeIcons.updateIcons();
  });

  graph3d.onEngineStop(() => {
    layoutStabilized.value = true;
    layout.stopLayout();
  });

  if (containerRef.value) {
    graph3d.width(containerRef.value.clientWidth);
    graph3d.height(containerRef.value.clientHeight);
  }

  const scene = graph3d.scene();
  if (scene) {
    labels.initRenderer(scene);
    icons.initRenderer(scene);
    const atlas = icons.getAtlas();
    if (atlas) {
      edgeIcons.initRenderer(scene, atlas);
    }
  }

  const controls = graph3d.controls();
  if (controls) {
    controls.minDistance = 10;
    controls.maxDistance = 10000;

    // Hand right-drag to our own cursor-locked pan if that behavior is on.
    camera.syncPanMode();

    // Update clipping plane normal when camera rotates + refresh labels
    controls.addEventListener('change', () => {
      if (isClippingActive.value && graph3d) {
        const cam = graph3d.camera() as THREE.Camera;
        const dir = new THREE.Vector3();
        cam.getWorldDirection(dir);
        clippingPlane.normal.copy(dir);
        updateOverlays();
      }
    });
  }

  if (is2D || graphStore.behaviors.useOrthographicCamera) {
    camera.patchCameraToOrthographic();
  }

  if (is2D) {
    camera.lock2DCamera();
    axisRotation.enable2DRotation();
  } else {
    axisRotation.disable2DRotation();
  }

  // Dev-only: expose renderer info + attach stats-gl overlay
  if (import.meta.env.DEV) {
    // Lets e2e tests locate a node on the canvas (WebGL is opaque to DOM selectors)
    (window as any).__GRAPH_NODE_SCREEN_COORDS__ = (nodeId: string) => {
      if (!graph3d) return null;
      const node = (graph3d.graphData().nodes as GraphNode[]).find(n => n.id === nodeId);
      if (!node || typeof node.x !== 'number') return null;
      return graph3d.graph2ScreenCoords(node.x, node.y ?? 0, node.z ?? 0);
    };

    const devRenderer = graph3d.renderer?.() as THREE.WebGLRenderer | null;
    if (devRenderer) {
      (window as any).__THREE_RENDERER_INFO__ = () => ({
        render: { ...devRenderer.info.render },
        memory: { ...devRenderer.info.memory },
        programs: devRenderer.info.programs?.length ?? 0,
      });

      if (wrapperRef.value) {
        devPerf.attach(devRenderer, wrapperRef.value);
      }
    }
  }

  // Drop the render-stage overlay only after the scene's first painted frame.
  if (isRenderingScene.value) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      isRenderingScene.value = false;
    }));
  }

  setTimeout(() => {
    if (graph3d) camera.zoomToFit();
  }, 500);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportPNG(
  filename: string = 'graph-3d.png',
  scale: number = 1,
  background: 'white' | 'transparent' = 'white',
) {
  if (!graph3d) return;

  const renderer = graph3d.renderer() as THREE.WebGLRenderer | null;
  const scene = graph3d.scene() as THREE.Scene | null;
  const camera_ = graph3d.camera() as THREE.PerspectiveCamera | THREE.OrthographicCamera | null;

  if (!renderer || !scene || !camera_) {
    console.error('Could not access 3D renderer/scene/camera');
    return;
  }

  // Save originals
  const origWidth = renderer.domElement.width;
  const origHeight = renderer.domElement.height;
  const origPixelRatio = renderer.getPixelRatio();
  const origBackground = scene.background;
  const origClearColor = new THREE.Color();
  renderer.getClearColor(origClearColor);
  const origClearAlpha = renderer.getClearAlpha();

  const targetWidth = Math.round(origWidth * scale);
  const targetHeight = Math.round(origHeight * scale);

  // Clamp to WebGL max renderbuffer size
  const gl = renderer.getContext();
  const maxSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
  if (targetWidth > maxSize || targetHeight > maxSize) {
    console.warn(`Export size ${targetWidth}x${targetHeight} exceeds WebGL max ${maxSize}. Clamping.`);
  }
  const clampedWidth = Math.min(targetWidth, maxSize);
  const clampedHeight = Math.min(targetHeight, maxSize);

  try {
    // Resize renderer for high-res capture (false = don't update CSS style)
    renderer.setPixelRatio(1);
    renderer.setSize(clampedWidth, clampedHeight, false);

    // Update camera aspect
    if ('isPerspectiveCamera' in camera_ && camera_.isPerspectiveCamera) {
      (camera_ as THREE.PerspectiveCamera).aspect = clampedWidth / clampedHeight;
      camera_.updateProjectionMatrix();
    }

    // Set background
    if (background === 'transparent') {
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
    } else {
      scene.background = new THREE.Color('#ffffff');
    }

    // Render and capture
    renderer.render(scene, camera_);

    const canvas = renderer.domElement as HTMLCanvasElement;
    const dataUrl = canvas.toDataURL('image/png');

    if (dataUrl.length < 100) {
      console.error('Export resulted in blank image - preserveDrawingBuffer may not be enabled');
      return;
    }

    const link = document.createElement('a');
    link.download = filename;
    link.href = dataUrl;
    link.click();
  } catch (error) {
    console.error('Error exporting 3D graph as PNG:', error);
  } finally {
    // Restore originals
    scene.background = origBackground;
    renderer.setClearColor(origClearColor, origClearAlpha);
    renderer.setPixelRatio(origPixelRatio);

    if (containerRef.value) {
      graph3d.width(containerRef.value.clientWidth);
      graph3d.height(containerRef.value.clientHeight);
    } else {
      renderer.setSize(origWidth, origHeight, false);
    }

    if ('isPerspectiveCamera' in camera_ && camera_.isPerspectiveCamera) {
      const w = containerRef.value?.clientWidth || origWidth;
      const h = containerRef.value?.clientHeight || origHeight;
      (camera_ as THREE.PerspectiveCamera).aspect = w / h;
      camera_.updateProjectionMatrix();
    }

    renderer.render(scene, camera_);
  }
}

// ---------------------------------------------------------------------------
// Expose methods for parent components
// ---------------------------------------------------------------------------

defineExpose({
  zoomToFit: camera.zoomToFit,
  focusOnNode: camera.focusOnNode,
  updateGraph,
  startLayout: layout.startLayout,
  stopLayout: layout.stopLayout,
  reheatLayout: layout.reheatLayout,
  scrambleLayout: layout.scrambleLayout,
  startEdgeTypeLayout: layout.startEdgeTypeLayout,
  isLayoutRunning,
  exportPNG,
});

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

// Track previous search query to detect search-triggered changes
let previousSearchQueryForDataWatch = '';
// Track previous counts: the getter below returns a fresh array every
// evaluation, so Vue fires this watch whenever the filtered/enhanced chain
// recomputes — even when both lengths are identical.
let previousCountsForDataWatch: [number, number] = [-1, -1];

// Data changes (node/edge counts) — full update
watch(
  () => [filteredNodes.value.length, filteredEdges.value.length] as [number, number],
  ([nodeCount, edgeCount]) => {
    const currentSearchQuery = graphStore.filters.search_query || '';
    const isSearchChange = currentSearchQuery !== previousSearchQueryForDataWatch;
    previousSearchQueryForDataWatch = currentSearchQuery;
    const countsChanged =
      nodeCount !== previousCountsForDataWatch[0] || edgeCount !== previousCountsForDataWatch[1];
    previousCountsForDataWatch = [nodeCount, edgeCount];

    if (isSearchChange && graphStore.behaviors.searchMode === 'hide') return;
    // Highlight-mode search: node/edge membership is unchanged, so a full
    // updateGraph() (graphData() → Three.js object recreation + d3-force
    // re-init) is pure waste and froze the tab on 200k+ graphs. The search
    // watcher below handles highlight painting via updateVisuals().
    if (isSearchChange && !countsChanged) return;
    updateGraph();

    // After similarity computation, auto-run edge-type layout on the rebuilt graph
    if (similarityStore.needsLayoutAfterCompute) {
      similarityStore.needsLayoutAfterCompute = false;
      layout.startEdgeTypeLayout(
        similarityStore.layoutEdgeType,
        similarityStore.layoutStrategy,
        similarityStore.useScoreAsWeight,
      );
    }
  }
);

// Filter changes (type filters, property filters) — visuals only.
// This is the ONLY canvas reaction to these filters: the data chain
// (displayNodes/displayEdges in the store) deliberately ignores them, so the
// data watcher above never fires and no Three.js rebuild / layout reheat runs.
// Hiding happens via the appearance pipeline (hidden flag), preserving
// positions. updateOverlays keeps labels/icons in sync with newly
// hidden/shown nodes (previously done implicitly by the full rebuild).
watch(
  () => JSON.stringify([
    graphStore.filters.node_types,
    graphStore.filters.edge_types,
    graphStore.filters.nodePropertyFilters,
    graphStore.filters.edgePropertyFilters,
  ]),
  () => {
    updateVisuals();
    updateOverlays();
  }
);

// Table filter (DataTablePanel sync) — visuals only, same contract as above.
// The sets are replaced wholesale by setTableFilteredIds, so identity watch.
watch(
  () => [graphStore.tableFilteredNodeIds, graphStore.tableFilteredEdgeIds],
  () => {
    updateVisuals();
    updateOverlays();
  }
);

// Layout execution settings — apply to graph3d live
watch(
  () => graphStore.layoutExecution,
  (exec) => {
    if (!graph3d) return;
    graph3d
      .cooldownTicks(exec.cooldownTicks)
      .ticksPerFrame(exec.ticksPerFrame);
  },
  { deep: true }
);

// Aesthetics changes — update graph3d settings + labels
watch(
  () => graphStore.aesthetics,
  (aesthetics) => {
    if (graph3d) {
      graph3d
        .linkDirectionalArrowLength((link: GraphLink) =>
      link.isSimilarity ? 0 : (aesthetics.showArrows ? 4 * aesthetics.arrowSize : 0)
    )
        .linkWidth(aesthetics.edgeWidth)
        .linkOpacity(aesthetics.edgeOpacity)
        .nodeRelSize(aesthetics.nodeSize / 2)
        .nodeOpacity(aesthetics.nodeOpacity);
      updateOverlays();
    }
  },
  { deep: true }
);

// Multi-edge curvature toggle — requires graph rebuild
watch(
  () => graphStore.aesthetics.enableMultiEdgeCurvature,
  () => { updateGraph(); }
);

// Force3D settings — single call replaces the old 50-line block.
// Uses effectiveForceSettings() so adaptive/mode overrides aren't clobbered
// by unrelated store changes while a layout mode is active.
watch(
  () => graphStore.force3DSettings,
  () => {
    if (!graph3d) return;
    applyForceConfig(graph3d, effectiveForceSettings(), graphStore.aesthetics.nodeSize / 2, graphStore.behaviors.viewMode === '2d-proj');
  },
  { deep: true }
);

// Auto-switch to 2D projection for planar layouts (community radial, ego, hive),
// restoring the previous view mode when the layout is turned off.
let viewModeBeforeLayout: '3d' | null = null;

function autoSwitchTo2D() {
  if (graphStore.behaviors.viewMode === '3d') {
    viewModeBeforeLayout = '3d';
    graphStore.updateBehaviors({ viewMode: '2d-proj' });
  }
}

function restorePreLayoutViewMode() {
  if (viewModeBeforeLayout === '3d') {
    graphStore.updateBehaviors({ viewMode: viewModeBeforeLayout });
    viewModeBeforeLayout = null;
  }
}

watch(
  () => communityStore.radialLayoutEnabled,
  (enabled) => {
    if (enabled) {
      autoSwitchTo2D();
    } else if (graphStore.layoutAlgorithm === 'force') {
      restorePreLayoutViewMode();
    }
  },
);

watch(
  () => [communityStore.radialLayoutEnabled, communityStore.communityRadialConfig] as const,
  () => {
    if (!graph3d) return;
    const is2D = graphStore.behaviors.viewMode === '2d-proj';
    applyCommunityRadialForce(
      graph3d,
      communityStore.communityMap,
      communityStore.communityRadialConfig,
      is2D,
    );

    // Unpin nodes so the radial forces can move them, then restart simulation
    unpinAllNodes(is2D);
    layout.startLayout();
  },
  { deep: true }
);

// ---------------------------------------------------------------------------
// Layout modes (ego / hive)
// ---------------------------------------------------------------------------

/**
 * Register/remove the active layout mode's positional constraints (forces,
 * pinned positions, hidden set). No simulation lifecycle calls — initGraph and
 * updateGraph re-apply this after data swaps; applyLayoutMode drives lifecycle.
 */
/** Restore link curvatures a layout mode overrode (marker: __origCurvature). */
function restoreModeCurvatures() {
  if (!graph3d) return;
  const data = graph3d.graphData();
  if (!data?.links) return;
  let touched = false;
  for (const link of data.links as GraphLink[]) {
    if (link.__origCurvature !== undefined) {
      link.curvature = link.__origCurvature;
      delete link.__origCurvature;
      touched = true;
    }
  }
  // Re-set the accessor to force a curve re-digest (no simulation running)
  if (touched) graph3d.linkCurvature((l: GraphLink) => l.curvature ?? 0);
}

/** Pin every laid-out node at its computed position (static layouts). */
function pinPositions(positions: Map<string, { x: number; y: number }>) {
  if (!graph3d) return;
  const data = graph3d.graphData();
  if (!data?.nodes) return;
  data.nodes.forEach((node: GraphNode) => {
    const pos = positions.get(node.id);
    if (!pos) return; // cluster/synthetic nodes keep their position
    node.x = pos.x;
    node.y = pos.y;
    node.z = 0;
    node.fx = pos.x;
    node.fy = pos.y;
    node.fz = 0;
    node.vx = 0;
    node.vy = 0;
    node.vz = 0;
  });
}

function applyLayoutModeForces() {
  if (!graph3d) return;
  const mode = graphStore.layoutAlgorithm;
  const cfg = graphStore.layoutModeConfig;

  if (mode !== 'ego') {
    layoutHiddenNodeIds.value = null;
    graphStore.egoLayoutStats = null;
  }
  // Both hive and ego override curvatures; restore before a mode that doesn't
  if (mode !== 'hive' && mode !== 'ego') {
    restoreModeCurvatures();
  }
  if (mode !== 'ego' && mode !== 'hive' && mode !== 'hierarchical') {
    guides.clear();
  }

  if (mode === 'ego') {
    const focusId = cfg.ego.focusNodeId;
    const hasFocus = !!focusId && graphStore.nodes.some((n) => n.node_id === focusId);
    if (!hasFocus) {
      // Inert until the user picks a focus node (no silent fallback)
      layoutHiddenNodeIds.value = null;
      graphStore.egoLayoutStats = null;
      guides.clear();
      return;
    }
    const result = computeTreeLayout(graphStore.nodes, graphStore.edges, {
      mode: 'radial',
      focusNodeId: focusId!,
      direction: cfg.ego.direction,
      edgeTypes: cfg.ego.edgeTypes,
      levelSpacing: cfg.ego.ringSpacing,
      nodeSpacing: EGO_MIN_NODE_ARC,
      orphanPolicy: 'outer-ring',
      ringOrdering: cfg.ego.ringOrdering,
      ringOrderingKey: cfg.ego.ringOrderingKey,
      crossingHeuristic: cfg.ego.crossingHeuristic,
      crossingSweeps: cfg.ego.crossingSweeps,
      communityMap: cfg.ego.ringOrdering === 'community' ? communityStore.communityMap : null,
    });
    pinPositions(result.positions);
    graphStore.egoLayoutStats = {
      nonTreeEdgeCount: result.nonTreeEdgeCount,
      sameRingEdgeCount: result.sameRingEdgeCount,
      siftingSkippedLargeRing: result.siftingSkippedLargeRing,
    };

    // Same-ring edges arc along their ring instead of chording across the
    // interior, freeing it for the radial tree. Mirrors the hive curvature path.
    const egoData = graph3d.graphData();
    if (egoData?.links) {
      const links = egoData.links as GraphLink[];
      if (cfg.ego.arcIntraRingEdges) {
        // Snapshot the multi-edge fan value BEFORE mutating, so re-runs compose
        // from the original rather than from a previous run's arc
        for (const link of links) {
          if (link.__origCurvature === undefined) link.__origCurvature = link.curvature ?? 0;
        }
        const curvatures = computeEgoLinkCurvatures(links, {
          positions: result.positions,
          levels: result.levels,
          parents: result.parents,
          levelStats: result.levelStats,
          levelSpacing: cfg.ego.ringSpacing,
          baseCurvature: (link) => (link as GraphLink).__origCurvature ?? 0,
        });
        for (const link of links) {
          link.curvature = curvatures.get(link) ?? link.__origCurvature;
        }
        graph3d.linkCurvature((l: GraphLink) => l.curvature ?? 0);
      } else {
        restoreModeCurvatures();
      }
    }

    if (cfg.ego.maxHops !== null) {
      const hidden = new Set<string>();
      for (const [nodeId, level] of result.levels) {
        if (level > cfg.ego.maxHops) hidden.add(nodeId);
      }
      layoutHiddenNodeIds.value = hidden.size > 0 ? hidden : null;
    } else {
      layoutHiddenNodeIds.value = null;
    }

    guides.showEgoRings(
      computeRingGuideSpec({ levelStats: result.levelStats, maxHops: cfg.ego.maxHops }),
      { focusHalo: true, ringSpacing: cfg.ego.ringSpacing },
    );
  } else if (mode === 'hierarchical') {
    const result = computeTreeLayout(graphStore.nodes, graphStore.edges, {
      mode: 'layered',
      focusNodeId: null,
      direction: cfg.hierarchical.traversal,
      edgeTypes: cfg.hierarchical.edgeTypes,
      levelSpacing: cfg.hierarchical.levelSpacing,
      nodeSpacing: cfg.hierarchical.nodeSpacing,
      layeredDirection: cfg.hierarchical.direction,
      orphanPolicy: 'adopt',
    });
    pinPositions(result.positions);

    let minAlong = 0;
    let maxAlong = 0;
    for (const pos of result.positions.values()) {
      const along = cfg.hierarchical.direction === 'td' ? pos.x : pos.y;
      minAlong = Math.min(minAlong, along);
      maxAlong = Math.max(maxAlong, along);
    }
    guides.showLayerLines({
      layers: result.levelStats.map((stat) => ({
        offset: stat.offset,
        label: stat.unreachable ? 'unlinked' : `L${stat.level}`,
        dashed: stat.unreachable,
      })),
      direction: cfg.hierarchical.direction,
      extent: { min: minAlong, max: maxAlong },
    });
  } else if (mode === 'hive') {
    const { positions, axes } = computeHivePositions(graphStore.nodes, cfg.hive, {
      nodeDegrees: graphStore.nodeDegrees,
      communityMap: communityStore.communityMap,
    });
    pinPositions(positions);
    // Curve the links: intra-axis links are collinear with their axis and
    // would be invisible straight; cross-axis links arc gently off the center
    const data = graph3d.graphData();
    if (data?.links) {
      const curvatures = computeHiveLinkCurvatures(data.links as GraphLink[], positions);
      for (const link of data.links as GraphLink[]) {
        if (link.__origCurvature === undefined) link.__origCurvature = link.curvature ?? 0;
        link.curvature = curvatures.get(link) ?? link.__origCurvature;
      }
      graph3d.linkCurvature((l: GraphLink) => l.curvature ?? 0);
    }

    guides.showHiveAxes(
      computeHiveAxesSpec({
        axes,
        innerRadius: cfg.hive.innerRadius,
        outerRadius: cfg.hive.outerRadius,
      }),
    );
  }
}

/** React to a layout mode/config change: apply constraints and drive the simulation. */
function applyLayoutMode() {
  if (!graph3d) return;
  const mode = graphStore.layoutAlgorithm;
  const isModeLayout = mode === 'ego' || mode === 'hive' || mode === 'hierarchical';

  if (isModeLayout) {
    // Planar layouts read correctly only in 2D. The viewMode watcher re-inits
    // the graph, and initGraph re-applies the mode — so bail out here.
    if (graphStore.behaviors.viewMode === '3d') {
      autoSwitchTo2D();
      return;
    }
    // An in-flight edge-type layout would fight the mode's constraints
    applyEdgeTypeLayoutForce(graph3d, null, 'unified');
  }

  const is2D = graphStore.behaviors.viewMode === '2d-proj';
  const focusId = graphStore.layoutModeConfig.ego.focusNodeId;
  const hasFocus = mode === 'ego' && !!focusId && graphStore.nodes.some((n) => n.node_id === focusId);

  applyLayoutModeForces();

  // Camera refit — the layout can land far outside the previous framing
  const myToken = initToken;
  const scheduleRefit = () => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (initToken === myToken && graph3d) camera.zoomToFit();
    }));
  };

  if (mode === 'hive' || mode === 'hierarchical' || hasFocus) {
    // All mode layouts are fixed analytic positions — no simulation.
    // stopLayout pins remaining (cluster) nodes, zeroes cooldown, shows labels.
    layout.stopLayout();
    scheduleRefit();
  } else if (mode !== 'ego') {
    // Back to force: release constraints and re-run the free simulation
    restorePreLayoutViewMode();
    unpinAllNodes(is2D);
    layout.startLayout();
  }
  // ego without focus: inert (hint shown in the panel / toast on transition)

  updateVisuals();
}

watch(() => graphStore.layoutAlgorithm, (newMode, oldMode) => {
  // Guidance only on the transition edge — applyLayoutMode re-runs on every
  // config change and would spam a toast placed inside it
  if (newMode === 'ego' && oldMode !== 'ego' && !graphStore.layoutModeConfig.ego.focusNodeId) {
    toast.info('Pick a focus node: select one and use "Use selected node", or right-click a node → "Ego layout from here"');
  }
  applyLayoutMode();
});

let layoutConfigDebounce: ReturnType<typeof setTimeout> | null = null;
watch(
  () => graphStore.layoutModeConfig,
  () => {
    if (graphStore.layoutAlgorithm === 'force') return;
    if (layoutConfigDebounce) clearTimeout(layoutConfigDebounce);
    layoutConfigDebounce = setTimeout(() => { applyLayoutMode(); }, 150);
  },
  { deep: true }
);

// Layouts keyed on communities go stale when detection re-runs
watch(
  () => communityStore.communityMap,
  () => {
    const mode = graphStore.layoutAlgorithm;
    if (mode === 'hive' && graphStore.layoutModeConfig.hive.axisKey === 'community') {
      applyLayoutMode();
    } else if (mode === 'ego' && graphStore.layoutModeConfig.ego.ringOrdering === 'community') {
      applyLayoutMode();
    }
  }
);

// Pointer repulsion settings — update force parameters live (skip during ramp)
watch(
  () => [graphStore.force3DSettings.pointerRepulsionStrength, graphStore.force3DSettings.pointerRepulsionRange] as const,
  ([strength, screenRange]) => {
    if (pointerRepulsionForce && !isBlowerActive.value) {
      pointerRepulsionForce.strength(strength);
      pointerRepulsionForce.range(screenToWorldRange(screenRange));
    }
  }
);

// Size inertia toggle — update force immediately
watch(
  () => graphStore.force3DSettings.pointerSizeInertia,
  (inertia) => {
    if (pointerRepulsionForce) pointerRepulsionForce.sizeInertia(inertia);
  }
);

// Clipping plane distance — update from slider
watch(
  () => graphStore.force3DSettings.clippingPlaneDistance,
  (distance) => {
    if (isClippingActive.value) {
      clippingPlane.constant = distance;
      updateOverlays();
    }
  }
);

// Clipping plane toggle — sync with store (e.g. from panel checkbox)
watch(
  () => graphStore.force3DSettings.clippingPlaneEnabled,
  (enabled) => {
    if (!graph3d) return;
    const renderer = graph3d.renderer() as THREE.WebGLRenderer;
    if (enabled && !isClippingActive.value) {
      isClippingActive.value = true;
      const cam = graph3d.camera() as THREE.Camera;
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      clippingPlane.normal.copy(dir);
      clippingPlane.constant = graphStore.force3DSettings.clippingPlaneDistance;
      renderer.clippingPlanes = [clippingPlane];
      labels.setClippingPlane(clippingPlane);
      updateOverlays();
    } else if (!enabled && isClippingActive.value) {
      isClippingActive.value = false;
      renderer.clippingPlanes = [];
      labels.setClippingPlane(null);
      updateOverlays();
    }
  }
);

// Visual mapping changes — update graph data
watch(
  () => {
    const nodeSize = metricsStore.visualMapping.nodeSize;
    const edgeWeight = metricsStore.visualMapping.edgeWeight;
    const metricsCount = metricsStore.computedMetrics.size;
    const nodeSizeMetric = metricsStore.nodeSizeMetric;
    const nodeSizeValuesSize = nodeSizeMetric?.values?.size || 0;
    return { nodeSize, edgeWeight, metricsCount, nodeSizeValuesSize };
  },
  () => { updateGraph(); },
  { deep: true }
);

// Orthographic camera toggle — requires full re-init
watch(
  () => graphStore.behaviors.useOrthographicCamera,
  () => { initGraph(); }
);

// 2D/3D view mode toggle — requires full re-init
watch(
  () => graphStore.behaviors.viewMode,
  () => { initGraph(); }
);

// Instanced rendering toggle — requires full re-init
watch(
  () => graphStore.behaviors.useInstancedRendering,
  () => { initGraph(); }
);

// Node drag toggle — runtime toggle (no re-init needed)
watch(
  () => graphStore.behaviors.enableNodeDrag,
  (enabled) => {
    if (graph3d) graph3d.enableNodeDrag(enabled);
  }
);

// Map-style pan toggle — runtime toggle: hands right-drag to us or back to the controls
watch(
  () => graphStore.behaviors.mapStylePan,
  () => { camera.syncPanMode(); }
);

// Selection, graph lens behavior, degree dimming params — visuals + labels
watch(
  () => [
    graphStore.selectedNodeIds.size,
    graphStore.selectedEdgeIds.size,
    graphStore.behaviors.edgeLensMode,
    graphStore.behaviors.edgeLensDimOpacity,
    graphStore.behaviors.degreeDimEnabled,
    graphStore.behaviors.degreeDimThreshold,
    graphStore.behaviors.degreeDimOpacity,
    graphStore.behaviors.degreeDimPreserveBridges,
    graphStore.lensPaused,
  ],
  () => {
    updateVisuals();
    updateOverlays();
  }
);

// Node type icon assignment changes — full visual update (sphere transparency + icon billboards)
watch(
  () => graphStore.nodeTypeIcons,
  () => { updateVisuals(); },
  { deep: true }
);

// Property-based icon config changes — recompute icon overrides and update visuals
watch(
  () => graphStore.nodePropertyIconConfigs,
  () => { updateVisuals(); },
  { deep: true }
);

// Label density culling settings
watch(
  () => [
    graphStore.behaviors.labelDensityCulling,
    graphStore.behaviors.labelDensity,
    graphStore.behaviors.labelGridCellSize,
    graphStore.behaviors.labelSizeThreshold,
  ],
  () => { updateOverlays(); }
);

// Hover changes (graph lens) — debounced to avoid strobing in dense regions
// All transitions (node→node, node→null, null→node) are debounced uniformly
// so rapid cursor movement through gaps between nodes gets coalesced.
watch(
  () => graphStore.hoveredNodeId,
  () => {
    if (graphStore.behaviors.edgeLensMode === 'off' || camera.getIsCameraMoving()) return;
    if (lensHoverTimeout) clearTimeout(lensHoverTimeout);
    lensHoverTimeout = setTimeout(() => {
      updateVisuals();
      updateOverlays();
      lensHoverTimeout = null;
    }, LENS_HOVER_DEBOUNCE_MS);
  }
);

// Search changes — visuals + center on match
let previousSearchQuery3D = '';
watch(
  () => [graphStore.filters.search_query, graphStore.behaviors.searchMode],
  () => {
    updateVisuals();
    updateOverlays();

    const currentQuery = graphStore.filters.search_query || '';
    const matchedIds = graphStore.searchMatchedNodeIds;
    const hasMatches = matchedIds && matchedIds.size > 0;

    if (currentQuery &&
        currentQuery !== previousSearchQuery3D &&
        hasMatches &&
        graphStore.behaviors.centerOnSearch) {
      camera.centerOnBestMatch();
    }

    previousSearchQuery3D = currentQuery;
  }
);

// Color changes — debounced
let colorUpdateTimeout3D: ReturnType<typeof setTimeout> | null = null;
watch(
  () => [graphStore.nodeTypeColors, graphStore.edgeTypeColors],
  () => {
    if (colorUpdateTimeout3D) clearTimeout(colorUpdateTimeout3D);
    colorUpdateTimeout3D = setTimeout(() => { updateVisuals(); }, 50);
  },
  { deep: true }
);

// Community color changes — debounced (same pattern as nodeTypeColors)
watch(
  () => communityStore.communityColorMap,
  () => {
    if (colorUpdateTimeout3D) clearTimeout(colorUpdateTimeout3D);
    colorUpdateTimeout3D = setTimeout(() => { updateVisuals(); }, 50);
  },
);

// Similarity display mode changes — full graph update
watch(
  () => similarityStore.displayMode,
  () => { updateGraph(); },
);

// Text format changes — update graph to refresh labels
watch(
  () => [graphStore.textFormatRules, graphStore.textFormatDefaults],
  () => { updateGraph(); },
  { deep: true }
);

// ---------------------------------------------------------------------------
// Soprador — d3-force with node pinning (only nearby nodes move)
// ---------------------------------------------------------------------------

/**
 * Convert a screen-space range (pixels) to world-space units based on current camera.
 * This ensures the blower cylinder has a consistent apparent size regardless of zoom.
 */
function screenToWorldRange(screenPixels: number): number {
  if (!graph3d) return screenPixels;
  const cam = graph3d.camera() as THREE.Camera & {
    zoom?: number; isOrthographicCamera?: boolean;
    isPerspectiveCamera?: boolean; fov?: number;
  };
  if (!cam) return screenPixels;

  const renderer = graph3d.renderer() as THREE.WebGLRenderer | null;
  const vh = renderer ? renderer.domElement.clientHeight : 600;

  if (cam.isOrthographicCamera && cam.zoom) {
    // Orthographic: pixelsPerUnit = vh * zoom / frustumSize
    const ORTHO_FRUSTUM = 2000;
    const pixelsPerUnit = vh * cam.zoom / ORTHO_FRUSTUM;
    return pixelsPerUnit > 0 ? screenPixels / pixelsPerUnit : screenPixels;
  }

  // Perspective: pixelsPerUnit = halfH / (distance * tan(fov/2))
  const controls = graph3d.controls?.();
  if (controls?.target && cam.fov) {
    const dist = cam.position.distanceTo(controls.target);
    const halfFovRad = (cam.fov / 2) * Math.PI / 180;
    const pixelsPerUnit = (vh / 2) / (dist * Math.tan(halfFovRad));
    return pixelsPerUnit > 0 ? screenPixels / pixelsPerUnit : screenPixels;
  }

  return screenPixels;
}

/** Update the blower ray from the current mouse position. */
function updateBlowerRay() {
  if (!graph3d || !pointerRepulsionForce) return;
  const renderer = graph3d.renderer() as THREE.WebGLRenderer;
  const rect = renderer.domElement.getBoundingClientRect();
  blowerPointer.x = ((mouseX.value - rect.left) / rect.width) * 2 - 1;
  blowerPointer.y = -((mouseY.value - rect.top) / rect.height) * 2 + 1;
  const cam = graph3d.camera() as THREE.Camera;
  blowerRaycaster.setFromCamera(blowerPointer, cam);
  const o = blowerRaycaster.ray.origin;
  const d = blowerRaycaster.ray.direction;
  pointerRepulsionForce.rayOrigin([o.x, o.y, o.z]);
  pointerRepulsionForce.rayDirection([d.x, d.y, d.z]);
}

/**
 * Pin all nodes OUTSIDE the cylinder (set fx/fy/fz) so only nearby nodes move.
 * Nodes on the central ray (hovered node) are also pinned so they stay put.
 */
function pinNodesOutsideCylinder() {
  if (!graph3d || !pointerRepulsionForce) return;
  const nodes = graph3d.graphData().nodes as GraphNode[];
  const [ox, oy, oz] = pointerRepulsionForce.rayOrigin();
  const [dx, dy, dz] = pointerRepulsionForce.rayDirection();
  const range = pointerRepulsionForce.range(); // Use force's current (ramped) range
  const range2 = range * range;
  const hoveredId = graphStore.hoveredNodeId;
  const relSize = graphStore.aesthetics.nodeSize / 2;

  for (const node of nodes) {
    // Always pin the hovered node (stays in place)
    if (node.id === hoveredId) {
      node.fx = node.x; node.fy = node.y; node.fz = node.z;
      continue;
    }

    // Compute perpendicular distance to ray
    if (node.x === undefined || node.y === undefined) continue;
    const px = node.x - ox, py = node.y - oy, pz = (node.z ?? 0) - oz;
    const t = px * dx + py * dy + pz * dz;
    const perpX = px - t * dx, perpY = py - t * dy, perpZ = pz - t * dz;
    const dist2 = perpX * perpX + perpY * perpY + perpZ * perpZ;

    // Node visual radius — nodes within this distance of the ray are "on the ray"
    const nodeRadius = Math.cbrt(node.size ?? 1) * relSize;
    const innerRadius2 = nodeRadius * nodeRadius;

    if (dist2 > range2 || dist2 < innerRadius2) {
      // Outside cylinder or intersected by ray — pin in place
      node.fx = node.x; node.fy = node.y; node.fz = node.z;
    } else {
      // Inside cylinder but not on ray — unpin so force can move it
      node.fx = undefined; node.fy = undefined; node.fz = undefined;
    }
  }
}

/**
 * Unpin all nodes (remove fx/fy/fz) to restore normal simulation behavior.
 * In 2D projection mode, z stays pinned at 0 instead of being released.
 */
function unpinAllNodes(is2D = false) {
  if (!graph3d) return;
  const nodes = graph3d.graphData().nodes as GraphNode[];
  for (const node of nodes) {
    node.fx = undefined;
    node.fy = undefined;
    if (is2D) {
      node.z = 0;
      node.fz = 0;
    } else {
      node.fz = undefined;
    }
  }
}

/** Blower/vacuum tick loop: ramps up force, re-pins nodes, and updates labels each frame. */
let lastReheatTime = 0;
function blowerRampTick() {
  if (!isBlowerActive.value || !pointerRepulsionForce) return;

  const now = performance.now();
  const elapsed = now - blowerStartTime;
  const t = Math.min(1, elapsed / BLOWER_RAMP_DURATION);

  const baseStrength = graphStore.force3DSettings.pointerRepulsionStrength;
  const baseScreenRange = graphStore.force3DSettings.pointerRepulsionRange;

  if (t < 1) {
    // Ramp-up: ease-out cubic
    const eased = 1 - (1 - t) * (1 - t) * (1 - t);
    pointerRepulsionForce.strength(baseStrength * pointerToolSign * eased);
    pointerRepulsionForce.range(screenToWorldRange(baseScreenRange) * eased);
  } else if (pointerToolSign === -1) {
    // Vacuum: range grows over time so it pulls from further away.
    // After the initial ramp (1.5s), range expands: +100% per second.
    const growthElapsed = elapsed - BLOWER_RAMP_DURATION;
    const growthFactor = 1 + growthElapsed / 1000;
    // Scale strength proportionally so distant nodes feel adequate force
    // (linear decay = 1-dist/range would otherwise make far nodes feel nothing)
    pointerRepulsionForce.strength(baseStrength * pointerToolSign * growthFactor);
    pointerRepulsionForce.range(screenToWorldRange(baseScreenRange) * growthFactor);

    // Re-reheat simulation every 1s to keep alpha high and simulation alive
    if (now - lastReheatTime > 1000 && graph3d) {
      graph3d.d3Force()?.alphaTarget?.(0.3);
      graph3d.d3ReheatSimulation();
      lastReheatTime = now;
    }
  } else {
    // Blower: fixed range, just keep synced with zoom
    pointerRepulsionForce.strength(baseStrength * pointerToolSign);
    pointerRepulsionForce.range(screenToWorldRange(baseScreenRange));
  }
  pinNodesOutsideCylinder();

  // Update labels every frame so they follow node movement
  updateOverlays();

  // Keep running while blower is active (not just during ramp)
  blowerRAF = requestAnimationFrame(blowerRampTick);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(() => {
  initGraph();

  // Register "Expand neighbors" context menu action (depth 1, quick expand)
  contextMenu.addAction({
    id: 'expand-neighbors',
    label: 'Expand neighbors',
    icon: Network,
    // Hidden entirely (not just disabled) on a connection without expand
    // support — a permanently disabled action reads as a bug.
    visible: (t) => t.type === 'node' && graphStore.supportsExpand,
    disabled: () => graphStore.loading,
    handler: async (t) => {
      await graphStore.expandFromNode(t.id, 1);
    },
  });

  // Register "Ego layout from here" — the investigator's gesture: right-click a
  // suspicious node and rearrange the graph in rings around it
  contextMenu.addAction({
    id: 'ego-layout-focus',
    label: 'Ego layout from here',
    icon: '🎯',
    visible: (t) => t.type === 'node',
    handler: (t) => {
      graphStore.updateLayoutModeConfig({ ego: { focusNodeId: t.id } });
      graphStore.selectNode(t.id); // size emphasis via the selection pipeline
      graphStore.setLayoutAlgorithm('ego');
      toast.success(`Ego layout from ${t.label}`);
    },
  });

  // Track pointer over canvas — keyboard shortcuts only fire when pointer is over the 3D view
  containerRef.value?.addEventListener('mouseenter', () => { isPointerOverCanvas = true; });
  containerRef.value?.addEventListener('mouseleave', () => { isPointerOverCanvas = false; });

  // Track mouse position for tooltip placement + soprador ray update
  containerRef.value?.addEventListener('mousemove', (event: MouseEvent) => {
    mouseX.value = event.clientX;
    mouseY.value = event.clientY;

    // Update soprador ray + re-pin nodes when blower is active
    if (isBlowerActive.value) {
      updateBlowerRay();
      pinNodesOutsideCylinder();
    }
  });

  // Track right-click mousedown for drag-vs-click detection (context menu opens only on a
  // stationary click) and, when map-style pan is on, to start a cursor-locked pan drag.
  _onMouseDown = function onMouseDown(event: MouseEvent) {
    if (event.button !== 2) return;
    rightClickMouseDownPos = { x: event.clientX, y: event.clientY };
    rightClickDownTarget = resolveContextMenuTarget(hoveredNodeSync, hoveredLinkSync);

    if (graphStore.behaviors.mapStylePan) {
      isMapPanning = true;
      lastPanPos = { x: event.clientX, y: event.clientY };
    }
  };

  // Opens the context menu on a stationary right-click, targeting whatever was hovered
  // when the button was PRESSED (see rightClickDownTarget). The native contextmenu event
  // stays suppressed by the graph library, so this mouseup path is the single trigger.
  function maybeOpenContextMenu(event: MouseEvent) {
    const stationary = isStationaryRightClick(rightClickMouseDownPos, event.clientX, event.clientY);
    rightClickMouseDownPos = null;
    const downTarget = rightClickDownTarget;
    rightClickDownTarget = null;
    if (!stationary || !isPointerOverCanvas) return;

    // Fall back to the mouseup-time hover for a stationary press where the throttled
    // raycast only caught the node after the button went down
    const target = downTarget ?? resolveContextMenuTarget(hoveredNodeSync, hoveredLinkSync);
    if (!target) return;
    // Configurable menu actions condition on node properties, which load
    // progressively — bump this node so property-gated entries appear fast
    // (the menu's visible-actions computed re-evaluates when they arrive).
    if (target.type === 'node') void graphStore.prioritizeNodeProperties(target.id);
    contextMenu.show(event, target);
    tooltipVisible.value = false;
  }

  _onMouseMove = function onMouseMove(event: MouseEvent) {
    if (!isMapPanning || !lastPanPos) return;
    camera.applyMapStylePan(event.clientX - lastPanPos.x, event.clientY - lastPanPos.y);
    lastPanPos = { x: event.clientX, y: event.clientY };
  };

  _onMouseUp = function onMouseUp(event: MouseEvent) {
    if (event.button !== 2) return;
    isMapPanning = false;
    lastPanPos = null;
    maybeOpenContextMenu(event);
  };

  containerRef.value?.addEventListener('mousedown', _onMouseDown);
  // Listen on window so a drag that leaves the canvas still tracks and still ends.
  window.addEventListener('mousemove', _onMouseMove);
  window.addEventListener('mouseup', _onMouseUp);

  // Keyboard shortcuts for 3D canvas — only active when pointer is over the visualizer
  _onKeyDown = function onKeyDown(event: KeyboardEvent) {
    if (!isPointerOverCanvas) return;

    // Escape clears selection (same as background click)
    if (event.key === 'Escape') {
      graphStore.clearSelection();
      return;
    }

    // Axis-constrained rotation (X/Y/Z keys) — not while blower/vacuum is active
    if (!isBlowerActive.value && axisRotation.handleKeyDown(event)) return;

    // Track Space for chord shortcuts
    if (event.code === 'Space') {
      isSpaceHeld = true;
      event.preventDefault();
      return;
    }

    // Space + L = scramble + re-run layout
    if (isSpaceHeld && (event.key === 'l' || event.key === 'L')) {
      event.preventDefault();
      layout.scrambleLayout();
      return;
    }

    // Space + C = reset view (orientation + zoom to fit)
    if (isSpaceHeld && (event.key === 'c' || event.key === 'C')) {
      event.preventDefault();
      camera.resetView();
      return;
    }

    // Soprador (Shift) / Aspirador (Ctrl): activate pointer force + node pinning
    // In 2D mode, activeAxis is always 'z' (passive rotation) — don't block blower
    const is2D = graphStore.behaviors.viewMode === '2d-proj';
    if (isBlowerActive.value || (!is2D && axisRotation.activeAxis.value !== null)) return;
    if (!graph3d || !pointerRepulsionForce) return;

    const isBlower = event.key === 'Shift' && graphStore.force3DSettings.pointerRepulsionEnabled;
    const isVacuum = event.key === 'Control' && graphStore.force3DSettings.pointerVacuumEnabled;
    if (!isBlower && !isVacuum) return;

    isBlowerActive.value = true;
    pointerToolSign = isBlower ? 1 : -1;

    // Initialize ray, start with zero strength/range for smooth ramp
    updateBlowerRay();
    pointerRepulsionForce.strength(0);
    pointerRepulsionForce.range(0);
    pointerRepulsionForce.enabled(true);
    pinNodesOutsideCylinder();

    // Start ramp-up loop
    blowerStartTime = performance.now();
    lastReheatTime = blowerStartTime;
    blowerRAF = requestAnimationFrame(blowerRampTick);

    // Reheat simulation with infinite cooldown so it keeps running
    savedCooldownTicks = graphStore.layoutExecution.cooldownTicks;
    graph3d.cooldownTicks(Infinity);
    graph3d.d3Force()?.alphaTarget?.(0.3);
    graph3d.d3ReheatSimulation();
  }

  _onKeyUp = function onKeyUp(event: KeyboardEvent) {
    if (event.code === 'Space') { isSpaceHeld = false; return; }

    // Axis-constrained rotation release
    if (axisRotation.handleKeyUp(event)) return;

    const releaseBlower = event.key === 'Shift' && isBlowerActive.value && pointerToolSign === 1;
    const releaseVacuum = event.key === 'Control' && isBlowerActive.value && pointerToolSign === -1;
    if (!releaseBlower && !releaseVacuum) return;

    isBlowerActive.value = false;

    // Cancel ramp-up loop
    if (blowerRAF !== null) {
      cancelAnimationFrame(blowerRAF);
      blowerRAF = null;
    }

    // Disable force and unpin all nodes
    if (pointerRepulsionForce) pointerRepulsionForce.enabled(false);
    unpinAllNodes();

    // Restore cooldown and let simulation cool down
    if (graph3d) {
      graph3d.d3Force()?.alphaTarget?.(0);
      if (savedCooldownTicks !== null) {
        graph3d.cooldownTicks(savedCooldownTicks);
        savedCooldownTicks = null;
      }
    }
  }

  // Clipping plane: Alt+scroll moves depth, blocks zoom
  // Use capture phase to intercept before orbit controls
  _onWheel = function onWheel(event: WheelEvent) {
    if (!isClippingActive.value || !event.altKey || !graph3d) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = event.deltaY * 0.2;
    clippingPlane.constant += delta;
    graphStore.updateForce3DSettings({ clippingPlaneDistance: clippingPlane.constant });
    updateOverlays();
  }

  window.addEventListener('keydown', _onKeyDown);
  window.addEventListener('keyup', _onKeyUp);
  containerRef.value?.addEventListener('wheel', _onWheel, { capture: true, passive: false } as AddEventListenerOptions);

  const resizeObserver = new ResizeObserver(() => {
    if (graph3d && containerRef.value) {
      graph3d.width(containerRef.value.clientWidth);
      graph3d.height(containerRef.value.clientHeight);
    }
  });

  if (containerRef.value) {
    resizeObserver.observe(containerRef.value);
  }
});

onUnmounted(() => {
  devPerf.dispose();
  camera.dispose();
  labels.dispose();
  icons.dispose();
  edgeIcons.dispose();
  axisRotation.dispose();
  guides.dispose();
  if (hoverRAF) {
    cancelAnimationFrame(hoverRAF);
    hoverRAF = null;
  }
  if (lensHoverTimeout) {
    clearTimeout(lensHoverTimeout);
    lensHoverTimeout = null;
  }
  if (layoutConfigDebounce) {
    clearTimeout(layoutConfigDebounce);
    layoutConfigDebounce = null;
  }
  // Clean up blower
  if (blowerRAF !== null) { cancelAnimationFrame(blowerRAF); blowerRAF = null; }
  if (pointerRepulsionForce) pointerRepulsionForce.enabled(false);
  unpinAllNodes();
  pointerRepulsionForce = null;
  // Clean up keyboard/wheel event listeners
  contextMenu.removeAction('expand-neighbors');
  contextMenu.removeAction('ego-layout-focus');
  if (_onKeyDown) window.removeEventListener('keydown', _onKeyDown);
  if (_onKeyUp) window.removeEventListener('keyup', _onKeyUp);
  if (_onWheel) containerRef.value?.removeEventListener('wheel', _onWheel);
  if (_onMouseDown) containerRef.value?.removeEventListener('mousedown', _onMouseDown);
  if (_onMouseMove) window.removeEventListener('mousemove', _onMouseMove);
  if (_onMouseUp) window.removeEventListener('mouseup', _onMouseUp);
  if (graph3d) {
    const renderer = graph3d.renderer?.() as THREE.WebGLRenderer | null;
    if (renderer) {
      renderer.clippingPlanes = [];
      renderer.forceContextLoss();
      renderer.dispose();
    }
    graph3d._destructor?.();
    graph3d = null;
  }
});
</script>

<template>
  <div ref="wrapperRef" class="graph-wrapper-3d">
    <div ref="containerRef" class="graph3d-container"></div>

    <!-- Warmup loading overlay (shown while the simulation pre-computes and
         while the scene is synchronously built after the settle) -->
    <div v-if="isWarmingUp || isHeadlessSettling || isRenderingScene" class="warmup-overlay">
      <div class="warmup-spinner"></div>
      <span v-if="isRenderingScene">Rendering graph...</span>
      <span v-else-if="isHeadlessSettling">Computing layout... {{ Math.round(settleProgress * 100) }}%</span>
      <span v-else>Computing layout...</span>
    </div>

    <!-- Context Menu -->
    <GraphContextMenu />

    <!-- Tooltip -->
    <div
      v-if="tooltipVisible && tooltipContent"
      class="tooltip"
      :style="{ left: tooltipX + 'px', top: tooltipY + 'px' }"
    >
      <div class="tooltip-header">
        <strong>{{ tooltipContent.title }}</strong>
        <span class="tooltip-type">{{ tooltipContent.type }}</span>
      </div>
    </div>

    <!-- 3D Controls hint -->
    <div class="controls-hint">
      <span><kbd>Alt</kbd>+<kbd>Click</kbd> Expand node</span>
      <span><kbd>X</kbd>/<kbd>Y</kbd>/<kbd>Z</kbd> + <kbd>Drag</kbd> Axis Rotation</span>
      <span><kbd>Shift</kbd> Blower</span>
      <span><kbd>Space</kbd>+<kbd>L</kbd> Relayout</span>
      <span><kbd>Space</kbd>+<kbd>C</kbd> Reset View</span>
    </div>
  </div>
</template>

<style scoped>
.graph-wrapper-3d {
  position: relative;
  flex: 1;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.graph3d-container {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

/* Ensure the canvas created by 3d-force-graph stays within bounds */
.graph3d-container :deep(canvas) {
  display: block;
  max-width: 100%;
  max-height: 100%;
}

.tooltip {
  position: fixed;
  background: var(--card-background, white);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  padding: 8px 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 1000;
  max-width: 300px;
  pointer-events: none;
}

.tooltip-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
}

.tooltip-type {
  font-size: 11px;
  padding: 2px 6px;
  background: var(--bg-secondary, #f0f0f0);
  border-radius: 4px;
  color: var(--text-muted, #666);
}

.warmup-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(250, 250, 250, 0.85);
  z-index: 10;
  font-size: 14px;
  color: var(--text-muted, #666);
  pointer-events: none;
}

.warmup-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-color, #ddd);
  border-top-color: var(--primary-color, #42b883);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.controls-hint {
  position: absolute;
  bottom: 8px;
  right: 8px;
  display: flex;
  gap: 12px;
  padding: 4px 10px;
  background: rgba(255, 255, 255, 0.85);
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-muted, #666);
  pointer-events: none;
}

.controls-hint kbd {
  display: inline-block;
  padding: 1px 4px;
  font-size: 10px;
  font-family: inherit;
  background: var(--bg-secondary, #eee);
  border: 1px solid var(--border-color, #ccc);
  border-radius: 3px;
  margin-right: 2px;
}

</style>
