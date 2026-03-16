/**
 * Pure functions for computing node and link visual appearance in the 3D graph.
 *
 * These functions eliminate the duplication between buildGraphData() and
 * updateVisuals() in GraphCanvas3D.vue by providing a single source of truth
 * for how nodes/links should look given the current store state.
 */

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/**
 * Convert a hex color string to rgba with the given alpha.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Calculate curvature for an edge in a multi-edge group that may contain
 * both forward (A→B) and reverse (B→A) edges.
 *
 * Strategy: forward edges fan out on the positive side, reverse edges on the
 * negative side. Within each sub-group, edges are spread evenly starting from
 * the baseline. When a sub-group has a single edge, it still gets a small
 * offset so it doesn't overlap with the other direction's edges.
 *
 * The caller is responsible for negating the result for reversed edges so
 * that the force-graph's direction-dependent perpendicular places them on the
 * correct visual side.
 *
 * @param indexInSubgroup  0-based index within the same-direction sub-group
 * @param subgroupCount    total edges in the same-direction sub-group
 * @param hasOppositeDir   whether the pair group contains edges in the other direction
 */
export function getMultiEdgeCurvature3D(
  indexInSubgroup: number,
  subgroupCount: number,
  hasOppositeDir: boolean,
): number {
  const STEP = 0.15;
  const CAP = 0.6;

  if (subgroupCount <= 0) return 0;

  if (subgroupCount === 1 && !hasOppositeDir) {
    // Only one edge between these nodes, no curvature needed
    return 0;
  }

  if (subgroupCount === 1) {
    // Single edge in this direction but opposite direction exists — offset to avoid overlap
    return Math.min(STEP, CAP);
  }

  // Multiple same-direction edges: spread starting from STEP
  // e.g. 2 edges: STEP, 2*STEP   |  3 edges: STEP, 2*STEP, 3*STEP
  const magnitude = (indexInSubgroup + 1) * STEP;
  return Math.min(magnitude, CAP);
}

/**
 * Compute the effective link color with alpha for graph lens and degree dimming.
 *
 * The 3d-force-graph lib multiplies linkOpacity * colorAlpha(color), so we
 * compensate: to achieve a desired visible opacity, we set
 * colorAlpha = desired / linkOpacity.
 */
export function computeLinkColor(
  baseColor: string,
  sourceId: string,
  targetId: string,
  focusFilter: Set<string> | null,
  hubs: Set<string> | null,
  edgeLensMode: string,
  edgeLensDimOpacity: number,
  degreeDimOpacity: number,
  edgeOpacity: number,
): string {
  let desiredOpacity = 1.0;

  // Graph Lens dimming: dim edges where either endpoint is outside the focused neighborhood
  if (edgeLensMode === 'dim' && focusFilter !== null) {
    if (!focusFilter.has(sourceId) || !focusFilter.has(targetId)) {
      desiredOpacity = Math.min(desiredOpacity, edgeLensDimOpacity);
    }
  }

  // Degree dimming: only dim hub-to-non-hub edges (edges between two hubs stay full)
  if (hubs !== null) {
    const srcIsHub = hubs.has(sourceId);
    const dstIsHub = hubs.has(targetId);
    if ((srcIsHub && !dstIsHub) || (!srcIsHub && dstIsHub)) {
      desiredOpacity = Math.min(desiredOpacity, degreeDimOpacity);
    }
  }

  if (desiredOpacity < 1) {
    const linkOpacity = edgeOpacity || 0.6;
    const colorAlpha = Math.min(1.0, desiredOpacity / linkOpacity);
    return hexToRgba(baseColor, colorAlpha);
  }
  return baseColor;
}

// ---------------------------------------------------------------------------
// Shared context snapshot — collected once per update pass
// ---------------------------------------------------------------------------

/**
 * All the store-derived state needed to compute node/link appearances.
 * Collected once at the top of buildGraphData() or updateVisuals() and
 * passed to the per-item functions, avoiding repeated store accesses.
 */
export interface AppearanceContext {
  // Aesthetics
  baseNodeSize: number;
  nodeOpacity: number;
  edgeOpacity: number;

  // Filters
  nodeTypeFilter: string[];
  hasNodeTypeFilter: boolean;
  nodeTypeFilterSet: Set<string>;
  edgeTypeFilter: string[];
  hasEdgeTypeFilter: boolean;
  edgeTypeFilterSet: Set<string>;

  // Search
  searchMode: string; // 'highlight' | 'hide'
  searchMatchedIds: Set<string> | null;
  searchHiddenIds: Set<string> | null;
  isHighlightMode: boolean;

  // Property filters
  propFilterHiddenNodeIds: Set<string> | null;
  propFilterHiddenEdgeIds: Set<string> | null;

  // Focus (graph lens)
  focusedNodeIds: Set<string> | null;
  edgeLensMode: string; // 'off' | 'dim' | 'hide'
  edgeLensDimOpacity: number;

  // Degree dimming
  dimmedByDegreeIds: Set<string> | null;
  degreeDimOpacity: number;

  // Hub nodes (for link dimming)
  hubNodeIds: Set<string> | null;

  // Selection
  selectedNodeIds: Set<string>;

  // Metric mapping
  nodeSizeMetric: { values: Map<string, number>; min: number; max: number } | null;
  nodeSizeMapping: { minSize: number; maxSize: number };

  // Color lookup
  getNodeTypeColor: (type: string) => string;
  getEdgeTypeColor: (type: string) => string;
}

// ---------------------------------------------------------------------------
// Node appearance
// ---------------------------------------------------------------------------

export interface NodeAppearanceResult {
  color: string;
  size: number;
  hidden: boolean;
}

/**
 * Compute the visual appearance (color, size, hidden) for a single node.
 *
 * @param nodeId - The node identifier
 * @param nodeType - The node type string
 * @param isCluster - Whether this is a cluster node
 * @param clusterBaseSize - Pre-computed cluster size (only used when isCluster)
 * @param clusterColor - Cluster color from properties (only used when isCluster)
 * @param ctx - Shared context with all store-derived state
 */
export function computeNodeAppearance(
  nodeId: string,
  nodeType: string,
  isCluster: boolean,
  clusterBaseSize: number,
  clusterColor: string | null,
  ctx: AppearanceContext,
): NodeAppearanceResult {
  const baseColor = isCluster
    ? (clusterColor || '#9333ea')
    : ctx.getNodeTypeColor(nodeType);
  let color = baseColor;
  let size = isCluster ? clusterBaseSize : ctx.baseNodeSize;

  // Visibility checks
  const isTypeHidden = ctx.hasNodeTypeFilter && !ctx.nodeTypeFilterSet.has(nodeType);
  const isSearchHidden = ctx.searchHiddenIds?.has(nodeId) ?? false;
  const isPropFilterHidden = ctx.propFilterHiddenNodeIds?.has(nodeId) ?? false;
  const isFocusHidden =
    ctx.edgeLensMode === 'hide' &&
    ctx.focusedNodeIds !== null &&
    !ctx.focusedNodeIds.has(nodeId);
  const hidden = isTypeHidden || isSearchHidden || isPropFilterHidden || isFocusHidden;

  // Metric-based size mapping (skip for clusters)
  if (!isCluster && ctx.nodeSizeMetric) {
    const metricValue = ctx.nodeSizeMetric.values.get(nodeId);
    if (metricValue !== undefined) {
      const range = ctx.nodeSizeMetric.max - ctx.nodeSizeMetric.min || 1;
      const normalized = (metricValue - ctx.nodeSizeMetric.min) / range;
      const { minSize, maxSize } = ctx.nodeSizeMapping;
      const desiredRadius = minSize + normalized * (maxSize - minSize);
      // Compensate for lib's cbrt: radius = cbrt(val) * relSize
      const relSize = ctx.baseNodeSize / 2;
      size = (desiredRadius / relSize) ** 3;
    }
  }

  // Search highlight mode
  if (ctx.isHighlightMode) {
    if (ctx.searchMatchedIds?.has(nodeId)) {
      size *= 1.5;
    } else {
      color = '#cccccc';
      size *= 0.75;
    }
  }

  // Degree dimming: fade non-hub nodes connected to hubs
  if (!hidden && ctx.dimmedByDegreeIds?.has(nodeId)) {
    const nodeAlpha = Math.min(1.0, ctx.degreeDimOpacity / (ctx.nodeOpacity || 1.0));
    color = hexToRgba('#cccccc', nodeAlpha);
    size *= 0.6;
  }

  // Graph Lens dim: fade non-focused nodes
  if (
    !hidden &&
    ctx.edgeLensMode === 'dim' &&
    ctx.focusedNodeIds !== null &&
    !ctx.focusedNodeIds.has(nodeId)
  ) {
    const lensAlpha = Math.min(1.0, ctx.edgeLensDimOpacity / (ctx.nodeOpacity || 1.0));
    color = hexToRgba(baseColor, lensAlpha);
  }

  // Selection highlight
  if (ctx.selectedNodeIds.has(nodeId)) {
    size *= 1.5;
  }

  return { color, size, hidden };
}

// ---------------------------------------------------------------------------
// Link appearance
// ---------------------------------------------------------------------------

export interface LinkAppearanceResult {
  color: string;
  hidden: boolean;
}

/**
 * Compute the visual appearance (color, hidden) for a single link.
 *
 * @param edgeId - The edge identifier
 * @param relationshipType - The edge type string
 * @param sourceId - Source node ID
 * @param targetId - Target node ID
 * @param hiddenNodeIds - Set of all hidden node IDs (aggregated from all sources)
 * @param ctx - Shared context with all store-derived state
 */
export function computeLinkAppearance(
  edgeId: string,
  relationshipType: string,
  sourceId: string,
  targetId: string,
  hiddenNodeIds: Set<string>,
  ctx: AppearanceContext,
): LinkAppearanceResult {
  const isEdgeTypeHidden =
    ctx.hasEdgeTypeFilter && !ctx.edgeTypeFilterSet.has(relationshipType);
  const edgePropHidden = ctx.propFilterHiddenEdgeIds?.has(edgeId) ?? false;
  const hidden =
    isEdgeTypeHidden ||
    hiddenNodeIds.has(sourceId) ||
    hiddenNodeIds.has(targetId) ||
    edgePropHidden;

  const baseColor = ctx.getEdgeTypeColor(relationshipType);
  const color = hidden
    ? baseColor
    : computeLinkColor(
        baseColor,
        sourceId,
        targetId,
        ctx.focusedNodeIds,
        ctx.hubNodeIds,
        ctx.edgeLensMode,
        ctx.edgeLensDimOpacity,
        ctx.degreeDimOpacity,
        ctx.edgeOpacity,
      );

  return { color, hidden };
}
