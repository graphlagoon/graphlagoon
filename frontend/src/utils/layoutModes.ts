/**
 * Pure position/level computations for the non-force layout modes (ego, hive).
 *
 * These functions operate on minimal structural shapes (store `Node`/`Edge`-compatible)
 * so they are trivially unit-testable and worker-portable. The component layer maps
 * results onto the live graph3d node objects by id.
 */
import type { EgoDirection, HiveScale } from '@/types/graph';

interface EgoNodeInput {
  node_id: string;
}

interface EgoEdgeInput {
  src: string;
  dst: string;
  relationship_type: string;
}

export interface EgoHopsOptions {
  focusNodeId: string;
  direction: EgoDirection;
  /** Restrict traversal to these relationship types (null/empty = all) */
  edgeTypes: string[] | null;
}

export interface EgoHopsResult {
  /** nodeId → hop count from focus (focus itself = 0). Unreachable nodes = maxHop + 1. */
  hops: Map<string, number>;
  /** Largest hop count among reachable nodes */
  maxHop: number;
  /** Ids of nodes not reachable under the direction/edgeTypes constraints */
  unreachable: Set<string>;
}

/**
 * BFS hop distances from a focus node, optionally directed and restricted to a
 * subset of relationship types. Unreachable nodes are placed on a dedicated
 * outermost ring (maxHop + 1) — in fraud analysis, "present in the graph but not
 * connected by the traversed relationships" is itself information.
 */
function buildAdjacency(
  edges: EgoEdgeInput[],
  direction: EgoDirection,
  edgeTypes: string[] | null
): Map<string, string[]> {
  const typeFilter = edgeTypes && edgeTypes.length > 0 ? new Set(edgeTypes) : null;
  const adjacency = new Map<string, string[]>();
  const addNeighbor = (from: string, to: string) => {
    const list = adjacency.get(from);
    if (list) list.push(to);
    else adjacency.set(from, [to]);
  };
  for (const edge of edges) {
    if (typeFilter && !typeFilter.has(edge.relationship_type)) continue;
    if (direction === 'out' || direction === 'both') addNeighbor(edge.src, edge.dst);
    if (direction === 'in' || direction === 'both') addNeighbor(edge.dst, edge.src);
  }
  return adjacency;
}

export function computeEgoHops(
  nodes: EgoNodeInput[],
  edges: EgoEdgeInput[],
  options: EgoHopsOptions
): EgoHopsResult {
  const { focusNodeId, direction, edgeTypes } = options;
  const adjacency = buildAdjacency(edges, direction, edgeTypes);

  const hops = new Map<string, number>();
  hops.set(focusNodeId, 0);
  let maxHop = 0;
  let frontier = [focusNodeId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const depth = hops.get(id)!;
      for (const neighbor of adjacency.get(id) ?? []) {
        if (hops.has(neighbor)) continue;
        hops.set(neighbor, depth + 1);
        maxHop = Math.max(maxHop, depth + 1);
        next.push(neighbor);
      }
    }
    frontier = next;
  }

  const unreachable = new Set<string>();
  for (const node of nodes) {
    if (!hops.has(node.node_id)) {
      unreachable.add(node.node_id);
      hops.set(node.node_id, maxHop + 1);
    }
  }

  return { hops, maxHop, unreachable };
}

// ---------------------------------------------------------------------------
// Tree layout engine (deterministic, no simulation)
//
// One BFS-tree engine, two projections:
//  - 'radial'  → ego network: focus at the origin, rings per hop, angles from
//    the tree structure (children near their parent — radial tidy tree)
//  - 'layered' → hierarchical: layers per level (money flow), slots per subtree
// ---------------------------------------------------------------------------

export interface TreeLayoutOptions {
  mode: 'radial' | 'layered';
  /** Single explicit root (ego). When null, roots = nodes without incoming traversed edges. */
  focusNodeId: string | null;
  direction: EgoDirection;
  edgeTypes: string[] | null;
  /** Radial: base gap between rings. Layered: distance between levels. */
  levelSpacing: number;
  /** Radial: min arc length between neighbors on a ring. Layered: gap between slots. */
  nodeSpacing: number;
  /** Layered only: 'td' (levels grow downward) or 'lr' (levels grow rightward) */
  layeredDirection?: 'td' | 'lr';
  /**
   * What to do with nodes unreachable from the roots: 'outer-ring' (ego — park
   * them on a dedicated outermost ring/layer) or 'adopt' (hierarchical — treat
   * the smallest-id unreached node as an extra root until everything is placed;
   * handles cycles with no in-degree-0 entry point).
   */
  orphanPolicy: 'outer-ring' | 'adopt';
}

export interface TreeLevelStat {
  level: number;
  /** Radial: ring radius. Layered: offset along the level axis. */
  offset: number;
  count: number;
  unreachable: boolean;
}

export interface TreeLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  /** nodeId → level (unreachable under 'outer-ring' policy = maxLevel + 1) */
  levels: Map<string, number>;
  levelStats: TreeLevelStat[];
  maxLevel: number;
  unreachable: Set<string>;
  roots: string[];
}

/**
 * Deterministic BFS-tree layout. Children are visited in sorted-id order and
 * leaves receive sequential angular/horizontal slots; internal nodes sit at the
 * mean of their children's slots — so subtrees occupy contiguous sectors and
 * tree edges stay short. Ring radii (radial) grow with both level and ring
 * population so crowded rings get the circumference they need.
 */
export function computeTreeLayout(
  nodes: EgoNodeInput[],
  edges: EgoEdgeInput[],
  options: TreeLayoutOptions
): TreeLayoutResult {
  const { mode, focusNodeId, direction, edgeTypes, levelSpacing, nodeSpacing, orphanPolicy } = options;
  const adjacency = buildAdjacency(edges, direction, edgeTypes);
  const allIds = nodes.map((n) => n.node_id).sort();
  const idSet = new Set(allIds);

  // --- Roots ---
  let roots: string[];
  if (focusNodeId && idSet.has(focusNodeId)) {
    roots = [focusNodeId];
  } else {
    const hasIncoming = new Set<string>();
    for (const [from, tos] of adjacency) {
      if (!idSet.has(from)) continue;
      for (const to of tos) hasIncoming.add(to);
    }
    roots = allIds.filter((id) => !hasIncoming.has(id));
    if (roots.length === 0 && allIds.length > 0) roots = [allIds[0]]; // pure cycle
  }

  // --- BFS forest (deterministic: sorted roots, sorted neighbors) ---
  const levels = new Map<string, number>();
  const children = new Map<string, string[]>();
  let maxLevel = 0;

  function bfs(startRoots: string[]) {
    let frontier = startRoots.filter((id) => !levels.has(id));
    const startLevel = 0;
    for (const id of frontier) levels.set(id, startLevel);
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        const depth = levels.get(id)!;
        maxLevel = Math.max(maxLevel, depth);
        const neighbors = [...(adjacency.get(id) ?? [])].filter((n) => idSet.has(n)).sort();
        for (const neighbor of neighbors) {
          if (levels.has(neighbor)) continue;
          levels.set(neighbor, depth + 1);
          maxLevel = Math.max(maxLevel, depth + 1);
          const list = children.get(id);
          if (list) list.push(neighbor);
          else children.set(id, [neighbor]);
          next.push(neighbor);
        }
      }
      frontier = next;
    }
  }

  bfs(roots);

  if (orphanPolicy === 'adopt') {
    // Keep adopting the smallest-id unreached node as an extra root (cycles
    // without an in-degree-0 entry, disconnected components)
    let remaining = allIds.filter((id) => !levels.has(id));
    while (remaining.length > 0) {
      const extraRoot = remaining[0];
      roots = [...roots, extraRoot];
      bfs([extraRoot]);
      remaining = allIds.filter((id) => !levels.has(id));
    }
  }

  const unreachable = new Set(allIds.filter((id) => !levels.has(id)));

  // --- Leaf slots via DFS over the forest (subtrees = contiguous slot ranges) ---
  const slot = new Map<string, number>();
  let nextSlot = 0;
  function assignSlots(id: string): number {
    const kids = children.get(id) ?? [];
    if (kids.length === 0) {
      slot.set(id, nextSlot);
      return nextSlot++;
    }
    let sum = 0;
    for (const kid of kids) sum += assignSlots(kid);
    const mid = sum / kids.length;
    slot.set(id, mid);
    return mid;
  }
  for (const root of roots) {
    if (levels.get(root) === 0) assignSlots(root);
  }
  const totalSlots = Math.max(1, nextSlot);

  // --- Level population ---
  const countByLevel = new Map<number, number>();
  for (const level of levels.values()) {
    countByLevel.set(level, (countByLevel.get(level) ?? 0) + 1);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const levelStats: TreeLevelStat[] = [];

  if (mode === 'radial') {
    // Ring radii: monotonic, growing with both level and ring population
    const radiusByLevel = new Map<number, number>();
    let prevRadius = 0;
    for (let level = 0; level <= maxLevel; level++) {
      const count = countByLevel.get(level) ?? 0;
      const capacityRadius = (count * nodeSpacing) / (2 * Math.PI);
      const radius = level === 0 ? 0 : Math.max(prevRadius + levelSpacing, capacityRadius);
      radiusByLevel.set(level, radius);
      prevRadius = radius;
      if (level > 0) levelStats.push({ level, offset: radius, count, unreachable: false });
    }

    for (const [id, level] of levels) {
      const angle = ((slot.get(id) ?? 0) / totalSlots) * 2 * Math.PI;
      const radius = radiusByLevel.get(level) ?? 0;
      positions.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    }

    // Unreachable nodes ('outer-ring' policy): dedicated outermost ring, spread by id order
    if (unreachable.size > 0) {
      const unreachableLevel = maxLevel + 1;
      const capacityRadius = (unreachable.size * nodeSpacing) / (2 * Math.PI);
      const radius = Math.max(prevRadius + levelSpacing, capacityRadius);
      const sorted = [...unreachable].sort();
      sorted.forEach((id, i) => {
        const angle = (i / sorted.length) * 2 * Math.PI;
        positions.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
        levels.set(id, unreachableLevel);
      });
      levelStats.push({ level: unreachableLevel, offset: radius, count: unreachable.size, unreachable: true });
    }
  } else {
    // Layered. A level can be arbitrarily wide (e.g. a bipartite fraud graph
    // where every transaction is a root — thousands of nodes on level 0, which
    // would render as a single hair-thin line). Wide levels therefore WRAP into
    // sub-rows of bounded width; each level becomes a band, and level offsets
    // accumulate the band heights. Nodes keep their subtree (slot) order, so
    // related nodes stay adjacent even when wrapped.
    const layered = options.layeredDirection ?? 'td';
    const totalPlaced = levels.size + unreachable.size;
    const perRow = Math.max(8, Math.ceil(1.5 * Math.sqrt(totalPlaced)));
    const subRowSpacing = nodeSpacing * 0.8;

    // Group per level in subtree order (slot asc, ties by id for determinism)
    const idsByLevel = new Map<number, string[]>();
    for (const [id, level] of levels) {
      const list = idsByLevel.get(level);
      if (list) list.push(id);
      else idsByLevel.set(level, [id]);
    }
    const bySlot = (a: string, b: string) => {
      const diff = (slot.get(a) ?? 0) - (slot.get(b) ?? 0);
      return diff !== 0 ? diff : a.localeCompare(b);
    };

    let cursor = 0; // depth offset where the current level band starts
    const placeBand = (ids: string[], level: number, isUnreachable: boolean) => {
      levelStats.push({ level, offset: cursor, count: ids.length, unreachable: isUnreachable });
      const rows = Math.max(1, Math.ceil(ids.length / perRow));
      ids.forEach((id, idx) => {
        const row = Math.floor(idx / perRow);
        const rowCount = Math.min(perRow, ids.length - row * perRow);
        const along = (idx % perRow - (rowCount - 1) / 2) * nodeSpacing;
        const depth = cursor + row * subRowSpacing;
        // 'td': levels grow downward (-y); 'lr': rightward (+x).
        // `|| 0` normalizes -0 at depth 0.
        positions.set(id, layered === 'td' ? { x: along, y: -depth || 0 } : { x: depth, y: along });
        levels.set(id, level);
      });
      cursor += (rows - 1) * subRowSpacing + levelSpacing;
    };

    for (let level = 0; level <= maxLevel; level++) {
      const ids = (idsByLevel.get(level) ?? []).sort(bySlot);
      placeBand(ids, level, false);
    }

    // Unreachable ('outer-ring' policy in layered mode): one extra bottom band
    if (unreachable.size > 0) {
      placeBand([...unreachable].sort(), maxLevel + 1, true);
    }
  }

  return { positions, levels, levelStats, maxLevel, unreachable, roots };
}

// ---------------------------------------------------------------------------
// Ego ring guide spec (pure math — rendered by useLayoutGuides)
// ---------------------------------------------------------------------------

export interface RingGuideSpec {
  rings: { hop: number; radius: number; dashed: boolean; label: string }[];
}

/**
 * Guide circles for the ego layout, derived from the tree layout's actual ring
 * radii (which adapt to ring population). Rings hidden by the maxHops cutoff
 * are omitted; the unreachable ring renders dashed.
 */
export function computeRingGuideSpec(opts: {
  levelStats: TreeLevelStat[];
  maxHops: number | null;
}): RingGuideSpec {
  const { levelStats, maxHops } = opts;
  const rings: RingGuideSpec['rings'] = [];

  for (const stat of levelStats) {
    if (stat.level < 1) continue;
    if (maxHops !== null && stat.level > maxHops) continue;
    rings.push({
      hop: stat.level,
      radius: stat.offset,
      dashed: stat.unreachable,
      label: stat.unreachable ? 'unreachable' : String(stat.level),
    });
  }

  return { rings };
}

// ---------------------------------------------------------------------------
// Hive axes guide spec (pure math — rendered by useLayoutGuides)
// ---------------------------------------------------------------------------

export interface HiveAxisSpec {
  label: string;
  inner: { x: number; y: number };
  outer: { x: number; y: number };
  labelPos: { x: number; y: number };
  textAlign: 'left' | 'right' | 'center';
}

export interface HiveAxesSpec {
  axes: HiveAxisSpec[];
}

/**
 * Axis lines + label anchors for the hive plot. Angles MUST match the implicit
 * angles of computeHivePositions (i * 2π / n) so nodes sit exactly on their axis.
 */
export function computeHiveAxesSpec(opts: {
  axes: string[];
  innerRadius: number;
  outerRadius: number;
  labelOffset?: number;
}): HiveAxesSpec {
  const { axes, innerRadius, outerRadius } = opts;
  const labelOffset = opts.labelOffset ?? 24;
  const angleStep = axes.length > 0 ? (2 * Math.PI) / axes.length : 0;

  return {
    axes: axes.map((label, i) => {
      const angle = i * angleStep;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const labelRadius = outerRadius + labelOffset;
      return {
        label,
        inner: { x: innerRadius * cos, y: innerRadius * sin },
        outer: { x: outerRadius * cos, y: outerRadius * sin },
        labelPos: { x: labelRadius * cos, y: labelRadius * sin },
        textAlign: cos > 0.1 ? 'left' : cos < -0.1 ? 'right' : 'center',
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Hive link curvature (pure — caller mutates link.curvature)
// ---------------------------------------------------------------------------

interface CurvatureLinkInput {
  source: string | { id: string };
  target: string | { id: string };
}

const HIVE_INTRA_AXIS_CURVATURE = 0.5;
const HIVE_INTER_AXIS_CURVATURE = 0.2;

/**
 * Curvature per link for the hive plot: links between nodes on the SAME axis
 * are collinear with it and would be invisible — arc them well off the axis
 * (0.5). Cross-axis links get a modest arc (0.2) to reduce clutter through the
 * center. Links with an endpoint absent from `positions` (cluster/synthetic
 * nodes) get no entry — the caller leaves their curvature untouched.
 */
export function computeHiveLinkCurvatures<L extends CurvatureLinkInput>(
  links: L[],
  positions: Map<string, HivePosition>
): Map<L, number> {
  const result = new Map<L, number>();
  for (const link of links) {
    const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
    const targetId = typeof link.target === 'object' ? link.target.id : link.target;
    const sourcePos = positions.get(sourceId);
    const targetPos = positions.get(targetId);
    if (!sourcePos || !targetPos) continue;
    result.set(
      link,
      sourcePos.axisIndex === targetPos.axisIndex
        ? HIVE_INTRA_AXIS_CURVATURE
        : HIVE_INTER_AXIS_CURVATURE
    );
  }
  return result;
}

interface HiveNodeInput {
  node_id: string;
  node_type: string;
  properties?: Record<string, unknown>;
}

export interface HivePositionsOptions {
  /** 'node_type', 'community' (Louvain), or 'prop:<name>' of a categorical node property */
  axisKey: string;
  /** Categories beyond this count are bucketed into an "Others" axis */
  maxAxes: number;
  /** 'degree' or 'prop:<name>' of a numeric node property */
  positionKey: string;
  scale: HiveScale;
  innerRadius: number;
  outerRadius: number;
}

export interface HivePositionsDeps {
  nodeDegrees: Map<string, number>;
  /** nodeId → community id, required when axisKey === 'community' */
  communityMap?: Map<string, number> | null;
}

export interface HivePosition {
  x: number;
  y: number;
  axisIndex: number;
  axisLabel: string;
}

export interface HivePositionsResult {
  positions: Map<string, HivePosition>;
  /** Axis labels in angular order (may end with 'Others') */
  axes: string[];
  /** How many categories were bucketed into 'Others' (0 = none) */
  othersCategoryCount: number;
}

export const HIVE_OTHERS_AXIS = 'Others';

function categoryOf(
  node: HiveNodeInput,
  axisKey: string,
  communityMap?: Map<string, number> | null
): string {
  if (axisKey === 'node_type') return node.node_type;
  if (axisKey === 'community') {
    const communityId = communityMap?.get(node.node_id);
    return communityId === undefined ? '(none)' : `Community ${communityId}`;
  }
  const propName = axisKey.startsWith('prop:') ? axisKey.slice(5) : axisKey;
  const value = node.properties?.[propName];
  return value === null || value === undefined ? '(missing)' : String(value);
}

function metricOf(
  node: HiveNodeInput,
  positionKey: string,
  nodeDegrees: Map<string, number>
): number | null {
  if (positionKey === 'degree') return nodeDegrees.get(node.node_id) ?? 0;
  const propName = positionKey.startsWith('prop:') ? positionKey.slice(5) : positionKey;
  const raw = node.properties?.[propName];
  const numeric = typeof raw === 'number' ? raw : parseFloat(String(raw));
  return isNaN(numeric) ? null : numeric;
}

/**
 * Deterministic hive plot positions: one radial axis per category (evenly spaced
 * angles), radius along the axis from a per-axis-normalized metric. Same graph +
 * same options = same picture, always — this comparability is the point of the layout.
 *
 * - Categories beyond `maxAxes` (by descending node count, ties by name) collapse
 *   into a trailing "Others" axis.
 * - Nodes missing the metric go to the inner end of their axis.
 * - `rank` scale spreads nodes uniformly by their value ranking within the axis
 *   (robust to outliers); ties and ordering are broken by node_id for determinism.
 */
export function computeHivePositions(
  nodes: HiveNodeInput[],
  options: HivePositionsOptions,
  deps: HivePositionsDeps
): HivePositionsResult {
  const { axisKey, maxAxes, positionKey, scale, innerRadius, outerRadius } = options;

  // --- Axis bucketing: top-N categories by node count, rest into Others ---
  const countByCategory = new Map<string, number>();
  for (const node of nodes) {
    const cat = categoryOf(node, axisKey, deps.communityMap);
    countByCategory.set(cat, (countByCategory.get(cat) ?? 0) + 1);
  }
  const sortedCategories = Array.from(countByCategory.keys()).sort((a, b) => {
    const diff = (countByCategory.get(b) ?? 0) - (countByCategory.get(a) ?? 0);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
  const keptCategories = sortedCategories.slice(0, Math.max(1, maxAxes));
  const othersCategoryCount = sortedCategories.length - keptCategories.length;
  const axes = othersCategoryCount > 0 ? [...keptCategories, HIVE_OTHERS_AXIS] : keptCategories;
  const axisIndexByCategory = new Map<string, number>();
  keptCategories.forEach((cat, i) => axisIndexByCategory.set(cat, i));

  // --- Group nodes per axis with their metric ---
  const nodesByAxis = new Map<number, { id: string; metric: number | null }[]>();
  for (const node of nodes) {
    const cat = categoryOf(node, axisKey, deps.communityMap);
    const axisIndex = axisIndexByCategory.get(cat) ?? axes.length - 1;
    const entry = { id: node.node_id, metric: metricOf(node, positionKey, deps.nodeDegrees) };
    const list = nodesByAxis.get(axisIndex);
    if (list) list.push(entry);
    else nodesByAxis.set(axisIndex, [entry]);
  }

  // --- Radius per node, normalized per axis ---
  const positions = new Map<string, HivePosition>();
  const angleStep = (2 * Math.PI) / axes.length;
  for (const [axisIndex, entries] of nodesByAxis) {
    const angle = axisIndex * angleStep;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Deterministic order: metric ascending (missing first), ties/order by id
    entries.sort((a, b) => {
      const ma = a.metric ?? -Infinity;
      const mb = b.metric ?? -Infinity;
      return ma !== mb ? ma - mb : a.id.localeCompare(b.id);
    });

    let radiusOf: (entry: { metric: number | null }, index: number) => number;
    if (scale === 'rank' || entries.length === 1) {
      const span = Math.max(1, entries.length - 1);
      radiusOf = (_entry, index) =>
        entries.length === 1
          ? (innerRadius + outerRadius) / 2
          : innerRadius + (index / span) * (outerRadius - innerRadius);
    } else {
      const values = entries.filter((e) => e.metric !== null).map((e) => e.metric!) ;
      const transform = scale === 'log'
        ? (v: number) => Math.log10(Math.max(v, 0) + 1)
        : (v: number) => v;
      const min = values.length > 0 ? transform(Math.min(...values)) : 0;
      const max = values.length > 0 ? transform(Math.max(...values)) : 1;
      const range = max - min;
      radiusOf = (entry) => {
        if (entry.metric === null) return innerRadius;
        if (range === 0) return (innerRadius + outerRadius) / 2;
        const t = (transform(entry.metric) - min) / range;
        return innerRadius + t * (outerRadius - innerRadius);
      };
    }

    entries.forEach((entry, index) => {
      const radius = radiusOf(entry, index);
      positions.set(entry.id, {
        x: radius * cos,
        y: radius * sin,
        axisIndex,
        axisLabel: axes[axisIndex],
      });
    });
  }

  return { positions, axes, othersCategoryCount };
}
