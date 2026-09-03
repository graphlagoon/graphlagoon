/**
 * Pure position/level computations for the non-force layout modes (ego, hive).
 *
 * These functions operate on minimal structural shapes (store `Node`/`Edge`-compatible)
 * so they are trivially unit-testable and worker-portable. The component layer maps
 * results onto the live graph3d node objects by id.
 */
import type { EgoDirection, HiveScale, RingOrdering } from '@/types/graph';

interface EgoNodeInput {
  node_id: string;
  /** Optional — used by the 'node-type' ring ordering strategy */
  node_type?: string;
  /** Optional — used by the 'property' ring ordering strategy */
  properties?: Record<string, unknown>;
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
  /**
   * Radial only: how siblings are ordered on each ring. Strategies are mutually
   * exclusive — one angular meaning at a time, so two runs are comparable.
   *
   *  - 'id' (default): sorted-id order — the historical, purely structural behavior.
   *  - 'barycenter': radial-Sugiyama sweeps (Bachmaier, IEEE TVCG 2007) — each
   *    subtree rotates toward the mean angle of its non-tree neighbors, cutting
   *    chord crossings while preserving subtree contiguity.
   *  - 'node-type' / 'community' / 'property': group siblings into contiguous
   *    angular sectors by attribute. Nodes MISSING the attribute always form a
   *    single trailing sector — never scattered, never hidden.
   */
  ringOrdering?: RingOrdering;
  /** Property name for ringOrdering: 'property' (accepts a bare name or 'prop:<name>'). */
  ringOrderingKey?: string | null;
  /** nodeId → community id; required by ringOrdering: 'community'. */
  communityMap?: Map<string, number> | null;
  /**
   * Which heuristic ringOrdering: 'barycenter' actually runs. All are
   * deterministic; they differ in strength and cost.
   *
   *  - 'barycenter' (default): sibling sweeps by mean neighbour angle. Cheap, but
   *    only reorders WITHIN a parent — near-useless on a convergence star, where
   *    every alter shares one parent (measured: 455 → 443 crossings).
   *  - 'median': same sweeps using the circular median. Eades & Wormald (1994)
   *    prove a 3-approximation for one-sided crossing minimization; the mean has
   *    no such guarantee.
   *  - 'sifting': circular sifting (Baur & Brandes, GD 2004) — each node is tried
   *    at every ring position and kept where it crosses least. Designed for the
   *    single-ring case the sweeps cannot help.
   */
  crossingHeuristic?: CrossingHeuristic;
  /** Sweeps for 'barycenter'/'median' (default 3). Higher = more settling, same determinism. */
  crossingSweeps?: number;
  /** Guard for 'sifting': hard ceiling on ring size (default 150). */
  siftingMaxRingSize?: number;
  /**
   * Guard for 'sifting': budget in (ring size × ring chords), since cost depends
   * on density as much as size. Default 10000 ≈ 90ms worst case.
   */
  siftingWorkBudget?: number;
}

/** Heuristic used by the crossing-reduction ordering. All deterministic. */
export type CrossingHeuristic = 'barycenter' | 'median' | 'sifting';

export type { RingOrdering };

/** Bucket label for nodes lacking the attribute a sector strategy groups by. */
export const RING_SECTOR_MISSING = '(sem valor)';

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
  /** nodeId → BFS parent (roots and unreachable nodes have no entry) */
  parents: Map<string, string>;
  /**
   * True when a sector strategy was requested but NO node carried the attribute,
   * so the layout fell back to id order. The UI surfaces this instead of silently
   * drawing an ordering that means nothing.
   */
  ringOrderingDegraded: boolean;
  /**
   * Traversed edges that are NOT part of the BFS tree. These are the only edges
   * crossing reduction can act on — zero means 'barycenter' has nothing to do
   * (a pure convergence star, the common shape in fraud attribute graphs), which
   * the UI explains rather than leaving the user toggling a no-op.
   */
  nonTreeEdgeCount: number;
  /** Non-tree edges joining two nodes on the SAME ring — what arc routing affects. */
  sameRingEdgeCount: number;
  /**
   * Set when 'sifting' was requested but a sibling group exceeded
   * `siftingMaxRingSize`, so it kept the cheaper sweep result. Surfaced in the UI
   * rather than letting the user believe an expensive pass ran when it did not.
   */
  siftingSkippedLargeRing: boolean;
}

/**
 * Circular mean of a set of angles, in (-π, π]. Returns null for empty input or
 * when the vectors cancel out. Averaging unit vectors rather than raw radians is
 * what makes this wraparound-safe: the mean of 0.1 and 2π-0.1 is ~0, not π.
 */
export function circularMean(angles: number[]): number | null {
  let sumX = 0;
  let sumY = 0;
  for (const angle of angles) {
    sumX += Math.cos(angle);
    sumY += Math.sin(angle);
  }
  if (Math.hypot(sumX, sumY) < 1e-9) return null;
  return Math.atan2(sumY, sumX);
}

/** Wrap into (-π, π] so sibling ordering is a local rotation, immune to the 0/2π seam. */
function wrapToPi(angle: number): number {
  let wrapped = angle % (2 * Math.PI);
  if (wrapped > Math.PI) wrapped -= 2 * Math.PI;
  if (wrapped <= -Math.PI) wrapped += 2 * Math.PI;
  return wrapped;
}

/** Default sweep count: bounds cost at O(SWEEPS·(V+E)) and keeps the layout deterministic. */
const RADIAL_BARYCENTER_SWEEPS = 3;
/**
 * Hard ceiling on ring size for sifting — a coarse first gate before the work
 * budget below.
 */
const SIFTING_MAX_RING_SIZE = 150;
/**
 * Work budget for sifting, in units of (ring size × chords on that ring).
 *
 * Cost depends on BOTH size and density, so a size-only cap misses half the
 * picture: a 100-node ring costs ~66ms when sparse but ~440ms when dense.
 * Calibrated by measurement, not derived: 20000 still let a dense 80-node ring
 * reach 209ms, while 6000 was so strict it rejected nearly every ring above 60
 * nodes. 10000 lands at ~89ms worst case — inside the 150ms debounce the layout
 * re-runs in — while still sifting about half of the sampled shapes. Rings past
 * the budget keep the cheap sweep result and set `siftingSkippedLargeRing`.
 */
const SIFTING_WORK_BUDGET = 10000;
/** Sifting passes over the ring; converges fast, capped for predictable cost. */
const SIFTING_ROUNDS = 2;

/**
 * Circular median of a set of angles: the candidate angle minimizing total
 * circular distance to the rest. Eades & Wormald (1994) show the median beats
 * the mean for one-sided crossing minimization (3-approximation); the mean is
 * dragged around by outliers that the median ignores.
 */
export function circularMedian(angles: number[]): number | null {
  if (angles.length === 0) return null;
  if (angles.length <= 2) return circularMean(angles);
  let best: number | null = null;
  let bestCost = Infinity;
  for (const candidate of angles) {
    let cost = 0;
    for (const other of angles) cost += Math.abs(wrapToPi(other - candidate));
    // Ties resolve to the smaller angle, keeping the result deterministic
    if (cost < bestCost - 1e-12 || (Math.abs(cost - bestCost) <= 1e-12 && best !== null && candidate < best)) {
      best = candidate;
      bestCost = cost;
    }
  }
  return best;
}

/** Do chords (a1,a2) and (b1,b2) cross inside a circle, given positions on it? */
function chordsCross(a1: number, a2: number, b1: number, b2: number): boolean {
  // On a circle, two chords cross iff their endpoint pairs interleave in cyclic order
  const lo = Math.min(a1, a2);
  const hi = Math.max(a1, a2);
  const bIn1 = b1 > lo && b1 < hi;
  const bIn2 = b2 > lo && b2 < hi;
  return bIn1 !== bIn2;
}

/**
 * Circular sifting (Baur & Brandes, GD 2004) on one ring.
 *
 * The sweep heuristics only reorder siblings within a parent, so on a
 * convergence star — one focus, every alter a direct child — they have almost no
 * freedom, and crossings barely move. Sifting works on the ring itself: it lifts
 * each node out, tries every position, and drops it where the drawing crosses
 * least. That is the lever the sweeps do not have.
 *
 * `order` is mutated in place. Only edges among these nodes matter (chords of
 * this ring); edges leaving the ring cannot cross a chord of it.
 */
function siftRingOrder(
  order: string[],
  neighboursOf: (id: string) => string[],
  rounds: number
): void {
  const n = order.length;
  if (n < 4) return; // nothing meaningful to reorder

  const ringSet = new Set(order);
  // Adjacency restricted to this ring: only chords of the ring can cross a chord
  // of the ring, so edges leaving it are irrelevant here.
  const ringNeighbours = new Map<string, string[]>();
  for (const id of order) {
    const list: string[] = [];
    for (const other of neighboursOf(id)) {
      if (other !== id && ringSet.has(other)) list.push(other);
    }
    ringNeighbours.set(id, list);
  }

  const indexOf = new Map<string, number>();
  const sync = () => {
    indexOf.clear();
    order.forEach((id, i) => indexOf.set(id, i));
  };
  sync();

  /**
   * Crossings involving `id` alone, for a hypothetical position. Sifting only
   * needs the DELTA for the node being moved, so this is O(deg(id)·E) rather
   * than recounting the whole ring (which made the naive version O(n³·E²) and
   * unusable past ~80 nodes).
   */
  const crossingsFor = (id: string, at: number) => {
    const posOf = (other: string) => {
      const raw = indexOf.get(other)!;
      const from = indexOf.get(id)!;
      // Positions shift when id is lifted out and reinserted at `at`
      let shifted = raw;
      if (raw > from) shifted -= 1;
      return shifted >= at ? shifted + 1 : shifted;
    };
    let total = 0;
    for (const mine of ringNeighbours.get(id) ?? []) {
      const a1 = at;
      const a2 = posOf(mine);
      for (const other of order) {
        if (other === id) continue;
        for (const far of ringNeighbours.get(other) ?? []) {
          if (far === id || far === other) continue;
          // Count each opposing chord once
          if (other > far) continue;
          const b1 = posOf(other);
          const b2 = posOf(far);
          if (a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2) continue;
          if (chordsCross(a1, a2, b1, b2)) total++;
        }
      }
    }
    return total;
  };

  for (let round = 0; round < rounds; round++) {
    let improvedThisRound = false;
    // Snapshot so traversal order stays stable even as nodes move
    for (const id of [...order]) {
      const from = indexOf.get(id);
      if (from === undefined) continue;
      let bestPos = from;
      let bestCost = crossingsFor(id, from);
      for (let to = 0; to < n; to++) {
        if (to === from) continue;
        const cost = crossingsFor(id, to);
        // Strict improvement only, lowest index wins ties — keeps it deterministic
        if (cost < bestCost) {
          bestCost = cost;
          bestPos = to;
        }
      }
      if (bestPos !== from) {
        order.splice(from, 1);
        order.splice(bestPos, 0, id);
        sync();
        improvedThisRound = true;
      }
    }
    if (!improvedThisRound) break; // converged
  }
}

/**
 * Tightest angular gap between consecutive angles around the full circle
 * (wraparound included). Returns Infinity when fewer than two angles exist, so
 * callers sizing a radius by `spacing / gap` get no constraint from it.
 */
function minCircularGap(angles: number[]): number {
  if (angles.length < 2) return Infinity;
  const sorted = [...angles].sort((a, b) => a - b);
  let min = sorted[0] + 2 * Math.PI - sorted[sorted.length - 1]; // wraparound
  for (let i = 1; i < sorted.length; i++) {
    min = Math.min(min, sorted[i] - sorted[i - 1]);
  }
  // Coincident angles would divide by ~0; one slot is the real floor.
  return min > 1e-9 ? min : Infinity;
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
  const ringOrdering: RingOrdering = options.ringOrdering ?? 'id';
  const adjacency = buildAdjacency(edges, direction, edgeTypes);
  const allIds = nodes.map((n) => n.node_id).sort();
  const idSet = new Set(allIds);
  const nodeById = new Map(nodes.map((n) => [n.node_id, n]));

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
  const parents = new Map<string, string>();
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
          parents.set(neighbor, id);
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
  const runSlotPass = () => {
    slot.clear();
    nextSlot = 0;
    for (const root of roots) {
      if (levels.get(root) === 0) assignSlots(root);
    }
  };
  runSlotPass();

  // --- Ring ordering (radial only) ---------------------------------------
  //
  // The DFS pass above keeps subtrees contiguous; what it cannot decide is WHICH
  // sibling goes where. Reordering siblings is therefore the one degree of
  // freedom that never breaks sector contiguity. Strategies are exclusive: the
  // ring's angle carries one meaning at a time, so two runs stay comparable.
  let ringOrderingDegraded = false;
  let siftingSkippedLargeRing = false;

  if (mode === 'radial' && ringOrdering !== 'id') {
    // Post-order (children before parents), computed once and reused per sweep
    const postOrder: string[] = [];
    const visitPostOrder = (id: string) => {
      for (const kid of children.get(id) ?? []) visitPostOrder(kid);
      postOrder.push(id);
    };
    for (const root of roots) {
      if (levels.get(root) === 0) visitPostOrder(root);
    }

    const heuristic: CrossingHeuristic = options.crossingHeuristic ?? 'barycenter';

    if (ringOrdering === 'barycenter') {
      // Only non-tree edges can produce crossing chords, so they are what the
      // sweeps optimize. Tree edges are already short by construction.
      const nonTreeNeighbors = new Map<string, string[]>();
      for (const [from, tos] of adjacency) {
        if (!idSet.has(from)) continue;
        for (const to of tos) {
          if (!idSet.has(to)) continue;
          if (parents.get(to) === from || parents.get(from) === to) continue;
          const list = nonTreeNeighbors.get(from);
          if (list) list.push(to);
          else nonTreeNeighbors.set(from, [to]);
        }
      }

      const sweeps = Math.max(0, Math.round(options.crossingSweeps ?? RADIAL_BARYCENTER_SWEEPS));
      const useMedian = heuristic === 'median';

      for (let sweep = 0; sweep < sweeps; sweep++) {
        const total = Math.max(1, nextSlot);
        const angleOf = (id: string) => ((slot.get(id) ?? 0) / total) * 2 * Math.PI;

        // Each subtree's pull direction, aggregated over its whole subtree's
        // off-tree neighbours so a branch rotates toward where it actually
        // connects. 'barycenter' keeps the vector sum (mean); 'median' keeps the
        // raw angles so the median can ignore outliers the mean would chase.
        const vectors = new Map<string, { x: number; y: number }>();
        const angleLists = new Map<string, number[]>();
        for (const id of postOrder) {
          let x = 0;
          let y = 0;
          const collected: number[] = [];
          for (const neighbor of nonTreeNeighbors.get(id) ?? []) {
            if (!slot.has(neighbor)) continue;
            const angle = angleOf(neighbor);
            x += Math.cos(angle);
            y += Math.sin(angle);
            if (useMedian) collected.push(angle);
          }
          for (const kid of children.get(id) ?? []) {
            const kidVector = vectors.get(kid);
            if (kidVector) {
              x += kidVector.x;
              y += kidVector.y;
            }
            if (useMedian) collected.push(...(angleLists.get(kid) ?? []));
          }
          vectors.set(id, { x, y });
          if (useMedian) angleLists.set(id, collected);
        }

        for (const [parentId, kids] of children) {
          if (kids.length < 2) continue;
          const parentAngle = angleOf(parentId);
          const keyed = kids.map((id, index) => {
            const vector = vectors.get(id) ?? { x: 0, y: 0 };
            const target = useMedian
              ? circularMedian(angleLists.get(id) ?? [])
              : (Math.hypot(vector.x, vector.y) >= 1e-9 ? Math.atan2(vector.y, vector.x) : null);
            const hasDirection = target !== null;
            return {
              id,
              index,
              hasDirection,
              // Relative to the parent: a local rotation of the sector, not an
              // absolute angle — that is what makes the 0/2π seam harmless.
              key: hasDirection ? wrapToPi(target - parentAngle) : 0,
            };
          });
          keyed.sort((a, b) => {
            if (a.hasDirection !== b.hasDirection) return a.hasDirection ? -1 : 1;
            if (a.hasDirection && b.hasDirection && a.key !== b.key) return a.key - b.key;
            return a.index - b.index; // stable: unconstrained subtrees keep position
          });
          children.set(parentId, keyed.map((k) => k.id));
        }
        runSlotPass();
      }

      if (heuristic === 'sifting') {
        // The sweeps above can only reorder siblings by an angle estimate; on a
        // convergence star (one parent, every alter a child) that barely moves
        // anything. Sifting instead tries each sibling at every position and
        // keeps the one that actually crosses least — the lever the sweeps lack.
        // Applied per sibling group so subtree sectors stay contiguous.
        const maxRing = options.siftingMaxRingSize ?? SIFTING_MAX_RING_SIZE;
        const workBudget = options.siftingWorkBudget ?? SIFTING_WORK_BUDGET;
        const neighboursOf = (id: string) => nonTreeNeighbors.get(id) ?? [];
        for (const [parentId, kids] of children) {
          if (kids.length < 4) continue;
          // Cost scales with size AND density, so gate on both. Chords among
          // these siblings are the only edges sifting actually examines.
          const siblingSet = new Set(kids);
          let ringChords = 0;
          for (const kid of kids) {
            for (const neighbour of neighboursOf(kid)) {
              if (siblingSet.has(neighbour) && neighbour !== kid) ringChords++;
            }
          }
          if (kids.length > maxRing || kids.length * ringChords > workBudget) {
            siftingSkippedLargeRing = true;
            continue;
          }
          const order = [...kids];
          siftRingOrder(order, neighboursOf, SIFTING_ROUNDS);
          children.set(parentId, order);
        }
        runSlotPass();
      }
    } else {
      // --- Sector strategies: node-type / community / property ---
      //
      // Heterogeneous graphs are the norm here: a node may simply not carry the
      // attribute. Those nodes get a sentinel key so they form ONE trailing
      // sector — visible and contiguous. "These N nodes lack this field" is
      // itself information for the analyst; scattering or hiding them is not.
      const propKey = (options.ringOrderingKey ?? '').replace(/^prop:/, '');
      const communityMap = options.communityMap ?? null;

      const rawSectorOf = (id: string): string | null => {
        if (ringOrdering === 'node-type') {
          const type = nodeById.get(id)?.node_type;
          return type === undefined || type === null || type === '' ? null : String(type);
        }
        if (ringOrdering === 'community') {
          const community = communityMap?.get(id);
          return community === undefined ? null : String(community);
        }
        // 'property'
        if (!propKey) return null;
        const value = nodeById.get(id)?.properties?.[propKey];
        return value === undefined || value === null || value === '' ? null : String(value);
      };

      // Degradation check: if nobody carries the attribute, an attribute-based
      // ordering is meaningless — fall back to id order and say so.
      ringOrderingDegraded = !allIds.some((id) => rawSectorOf(id) !== null);

      if (!ringOrderingDegraded) {
        // Majority sector per subtree (ties → lexicographically smaller key), so
        // whole branches — not lone nodes — land in the same angular sector.
        const subtreeSector = new Map<string, string>();
        const tallies = new Map<string, Map<string, number>>();
        for (const id of postOrder) {
          const tally = new Map<string, number>();
          const own = rawSectorOf(id) ?? RING_SECTOR_MISSING;
          tally.set(own, 1);
          for (const kid of children.get(id) ?? []) {
            for (const [sector, count] of tallies.get(kid) ?? []) {
              tally.set(sector, (tally.get(sector) ?? 0) + count);
            }
          }
          tallies.set(id, tally);
          let best = RING_SECTOR_MISSING;
          let bestCount = -1;
          for (const [sector, count] of [...tally].sort((a, b) => a[0].localeCompare(b[0]))) {
            if (count > bestCount) {
              best = sector;
              bestCount = count;
            }
          }
          subtreeSector.set(id, best);
        }

        // Missing-value sector always sorts last, as one contiguous block
        const sectorRank = (id: string) => {
          const sector = subtreeSector.get(id) ?? RING_SECTOR_MISSING;
          return sector === RING_SECTOR_MISSING ? '￿' : sector;
        };
        for (const [parentId, kids] of children) {
          if (kids.length < 2) continue;
          children.set(
            parentId,
            [...kids].sort((a, b) => {
              const rank = sectorRank(a).localeCompare(sectorRank(b));
              return rank !== 0 ? rank : a.localeCompare(b);
            })
          );
        }
        runSlotPass();
      }
    }
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
    // Angles depend only on slots, never on radius — so they can be resolved
    // first and used to size the rings.
    const angleOfNode = new Map<string, number>();
    const anglesByLevel = new Map<number, number[]>();
    for (const [id, level] of levels) {
      const angle = ((slot.get(id) ?? 0) / totalSlots) * 2 * Math.PI;
      angleOfNode.set(id, angle);
      const list = anglesByLevel.get(level);
      if (list) list.push(angle);
      else anglesByLevel.set(level, [angle]);
    }

    // Ring radii: monotonic, growing with both level and ring population.
    //
    // `capacityRadius` alone assumes nodes are spread UNIFORMLY around the ring,
    // which the tidy-tree does not guarantee: angular width is allocated per
    // LEAF, so a ring mixing a deep bushy subtree with a shallow one packs the
    // shallow side far tighter than the average implies. Sizing by the ring's
    // actual tightest angular gap is what makes `nodeSpacing` a real minimum
    // rather than an average. Bounded by nodeSpacing·totalSlots/2π, since two
    // nodes on a ring are always at least one slot apart.
    const radiusByLevel = new Map<number, number>();
    let prevRadius = 0;
    for (let level = 0; level <= maxLevel; level++) {
      const count = countByLevel.get(level) ?? 0;
      const capacityRadius = (count * nodeSpacing) / (2 * Math.PI);
      const spacingRadius = nodeSpacing / minCircularGap(anglesByLevel.get(level) ?? []);
      const radius = level === 0
        ? 0
        : Math.max(prevRadius + levelSpacing, capacityRadius, spacingRadius);
      radiusByLevel.set(level, radius);
      prevRadius = radius;
      if (level > 0) levelStats.push({ level, offset: radius, count, unreachable: false });
    }

    for (const [id, level] of levels) {
      const angle = angleOfNode.get(id) ?? 0;
      const radius = radiusByLevel.get(level) ?? 0;
      positions.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    }

    // Unreachable nodes ('outer-ring' policy): dedicated outermost ring, spread by id order
    if (unreachable.size > 0) {
      const unreachableLevel = maxLevel + 1;
      const capacityRadius = (unreachable.size * nodeSpacing) / (2 * Math.PI);
      const radius = Math.max(prevRadius + levelSpacing, capacityRadius);
      // Under a non-default ordering, park each unreachable node near the mean
      // angle of the reachable neighbours it does have — pure id order puts them
      // at arbitrary angles, producing the longest chords in the drawing.
      let sorted: string[];
      if (ringOrdering === 'id') {
        sorted = [...unreachable].sort();
      } else {
        const meanAngle = new Map<string, number>();
        for (const id of unreachable) {
          const angles: number[] = [];
          for (const neighbor of adjacency.get(id) ?? []) {
            const pos = positions.get(neighbor);
            if (pos) angles.push(Math.atan2(pos.y, pos.x));
          }
          const mean = circularMean(angles);
          if (mean !== null) meanAngle.set(id, mean);
        }
        sorted = [...unreachable].sort((a, b) => {
          const angleA = meanAngle.get(a);
          const angleB = meanAngle.get(b);
          if (angleA === undefined && angleB === undefined) return a.localeCompare(b);
          if (angleA === undefined) return 1; // neighbourless nodes trail
          if (angleB === undefined) return -1;
          return angleA !== angleB ? angleA - angleB : a.localeCompare(b);
        });
      }
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

  // --- Edge shape stats (drive the UI's "this control is a no-op here" hints) ---
  let nonTreeEdgeCount = 0;
  let sameRingEdgeCount = 0;
  const typeFilter = edgeTypes && edgeTypes.length > 0 ? new Set(edgeTypes) : null;
  for (const edge of edges) {
    if (typeFilter && !typeFilter.has(edge.relationship_type)) continue;
    if (!idSet.has(edge.src) || !idSet.has(edge.dst)) continue;
    if (edge.src === edge.dst) continue;
    if (parents.get(edge.dst) === edge.src || parents.get(edge.src) === edge.dst) continue;
    nonTreeEdgeCount++;
    const srcLevel = levels.get(edge.src);
    const dstLevel = levels.get(edge.dst);
    if (srcLevel !== undefined && srcLevel === dstLevel && srcLevel >= 1) sameRingEdgeCount++;
  }

  return {
    positions,
    levels,
    levelStats,
    maxLevel,
    unreachable,
    roots,
    parents,
    ringOrderingDegraded,
    nonTreeEdgeCount,
    sameRingEdgeCount,
    siftingSkippedLargeRing,
  };
}

// ---------------------------------------------------------------------------
// Ego ring guide spec (pure math — rendered by useLayoutGuides)
// ---------------------------------------------------------------------------

export interface RingGuideSpec {
  /** `label: null` means "draw this ring without a caption". */
  rings: { hop: number; radius: number; dashed: boolean; label: string | null }[];
}

/**
 * Guide circles for the ego layout, derived from the tree layout's actual ring
 * radii (which adapt to ring population). Rings hidden by the maxHops cutoff
 * are omitted; the unreachable ring renders dashed.
 *
 * `hideLabels` suppresses the captions only — the geometry is unchanged, so
 * toggling it never moves a node or a ring.
 */
export function computeRingGuideSpec(opts: {
  levelStats: TreeLevelStat[];
  maxHops: number | null;
  hideLabels?: boolean;
}): RingGuideSpec {
  const { levelStats, maxHops, hideLabels = false } = opts;
  const rings: RingGuideSpec['rings'] = [];

  for (const stat of levelStats) {
    if (stat.level < 1) continue;
    if (maxHops !== null && stat.level > maxHops) continue;
    // Ring population is the first thing an analyst reads off an ego view
    // ("where is the mass?"), so it belongs in the guide label rather than
    // requiring them to count dots.
    const name = stat.unreachable ? 'unreachable' : String(stat.level);
    rings.push({
      hop: stat.level,
      radius: stat.offset,
      dashed: stat.unreachable,
      label: hideLabels ? null : stat.count > 0 ? `${name} · ${stat.count}` : name,
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

// ---------------------------------------------------------------------------
// Ego link curvature (pure — caller mutates link.curvature)
// ---------------------------------------------------------------------------

export interface EgoCurvatureDeps {
  positions: Map<string, { x: number; y: number }>;
  levels: Map<string, number>;
  /** BFS forest from computeTreeLayout — tree edges stay straight */
  parents: Map<string, string>;
  /** Ring radii, used to clamp an arc so it never reaches the neighbouring ring */
  levelStats: TreeLevelStat[];
  /** Existing multi-edge fan value to compose with (keeps parallel edges apart) */
  baseCurvature?: (link: unknown) => number;
  /**
   * Base ring gap. Used as the corridor width when a ring has no neighbour
   * outward (a single-ring ego graph would otherwise get zero headroom and lose
   * its arcs entirely), and to bound how far a cross-ring edge may bow.
   */
  levelSpacing?: number;
}

/** How far past its own ring an arc may bulge, as a fraction of the gap to the next ring. */
const EGO_ARC_HEADROOM = 0.6;
/** Absolute ceiling for arc + multi-edge fan combined — still short of the next ring. */
const EGO_ARC_HEADROOM_WITH_FAN = 0.9;
/** Slightly past the exact on-ring arc, so the curve reads as a deliberate arc. */
const EGO_ARC_OVERSHOOT = 1.15;
/** Matches the CAP in getMultiEdgeCurvature3D — the widest fan offset to expect. */
const EGO_MULTI_EDGE_CAP = 0.6;
const EGO_MAX_CURVATURE = 0.8;
/** Cross-ring bow ceiling, as a fraction of the ring gap (keeps long edges from sweeping). */
const EGO_CROSS_RING_MAX_OFFSET = 0.5;

/**
 * Curvature per link for the ego layout.
 *
 * The BFS tree is the layout's semantic skeleton, so tree edges stay perfectly
 * straight (radial spokes). Edges BETWEEN nodes on the same ring are the ones
 * that congest the drawing — as straight chords they cut across the interior,
 * over the very spokes the analyst is trying to read. Arcing them along their
 * own ring frees the interior while keeping every edge individually traceable
 * and selectable (which is precisely what edge bundling gives up).
 *
 * Same-ring geometry: for endpoints separated by signed shortest angle Δ on a
 * ring of radius r, a quadratic Bézier whose peak lands exactly on the ring
 * needs curvature tan(|Δ|/4). We overshoot slightly, then clamp so the peak
 * never reaches the next ring — an arc that invaded its neighbour would read as
 * passing through nodes it does not touch.
 */
export function computeEgoLinkCurvatures<L extends CurvatureLinkInput>(
  links: L[],
  deps: EgoCurvatureDeps
): Map<L, number> {
  const { positions, levels, parents, levelStats } = deps;
  const result = new Map<L, number>();
  // A single-ring layout has no "next ring" to measure against; fall back to the
  // configured ring spacing so those arcs still get a corridor to bulge into.
  const fallbackGap = deps.levelSpacing && deps.levelSpacing > 0 ? deps.levelSpacing : 60;

  const radiusByLevel = new Map<number, number>();
  for (const stat of levelStats) radiusByLevel.set(stat.level, stat.offset);
  // Gap to the next ring outward; the outermost ring reuses the last known gap.
  const gapByLevel = new Map<number, number>();
  const sortedStats = [...levelStats].sort((a, b) => a.level - b.level);
  let lastGap = fallbackGap;
  for (let i = 0; i < sortedStats.length; i++) {
    const next = sortedStats[i + 1];
    const gap = next ? next.offset - sortedStats[i].offset : lastGap;
    gapByLevel.set(sortedStats[i].level, gap > 0 ? gap : lastGap);
    if (gap > 0) lastGap = gap;
  }

  for (const link of links) {
    const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
    const targetId = typeof link.target === 'object' ? link.target.id : link.target;
    if (sourceId === targetId) continue; // self-loops keep their existing curvature

    const sourcePos = positions.get(sourceId);
    const targetPos = positions.get(targetId);
    if (!sourcePos || !targetPos) continue; // cluster/synthetic nodes

    // Tree edges: the radial skeleton reads best dead straight
    if (parents.get(targetId) === sourceId || parents.get(sourceId) === targetId) {
      result.set(link, 0);
      continue;
    }

    const sourceLevel = levels.get(sourceId);
    const targetLevel = levels.get(targetId);
    if (sourceLevel === undefined || targetLevel === undefined) continue;

    const sourceAngle = Math.atan2(sourcePos.y, sourcePos.x);
    const targetAngle = Math.atan2(targetPos.y, targetPos.x);
    const delta = wrapToPi(targetAngle - sourceAngle);
    const sign = delta >= 0 ? 1 : -1;

    const base = deps.baseCurvature?.(link) ?? 0;
    const boundedBase = Math.max(-EGO_MAX_CURVATURE, Math.min(EGO_MAX_CURVATURE, base));

    let curvature: number;
    let fanScale = 1;
    if (sourceLevel === targetLevel && sourceLevel >= 1) {
      const radius = radiusByLevel.get(sourceLevel) ?? Math.hypot(sourcePos.x, sourcePos.y);
      const half = Math.abs(delta) / 2;
      const chord = 2 * radius * Math.sin(half);
      if (chord < 1e-6) {
        curvature = 0;
      } else {
        const gap = gapByLevel.get(sourceLevel) ?? fallbackGap;
        // Quadratic Bézier midpoint sits at (chordMidpoint + control)/2, so the
        // peak radius for curvature k is r·cos(h) + k·chord/2. The midpoint is
        // also the curve's true maximum (the curve is symmetric), so bounding it
        // bounds the whole arc.
        const curvatureForPeak = (peak: number) => (2 * (peak - radius * Math.cos(half))) / chord;
        const maxCurvature = curvatureForPeak(radius + EGO_ARC_HEADROOM * gap);
        const magnitude = Math.min(EGO_ARC_OVERSHOOT * Math.tan(half / 2), Math.max(0, maxCurvature));
        // Near-antipodal endpoints sit at the wrap seam where the sign of delta
        // flips on sub-pixel jitter; fall back to the same id-based tiebreak used
        // for radially collinear pairs so the arc keeps its side.
        const stableSign = Math.abs(Math.abs(delta) - Math.PI) < 1e-6
          ? (sourceId < targetId ? 1 : -1)
          : sign;
        curvature = stableSign * magnitude;

        // Compress the multi-edge fan into whatever headroom the arc left, rather
        // than letting it push the peak past the neighbouring ring. Linear
        // rescaling keeps parallel edges ordered and distinct, just tighter.
        const maxTotal = curvatureForPeak(radius + EGO_ARC_HEADROOM_WITH_FAN * gap);
        const headroom = Math.max(0, maxTotal - magnitude);
        fanScale = Math.min(1, headroom / EGO_MULTI_EDGE_CAP);
      }
    } else {
      // Cross-ring shortcut: a gentle fan, enough to lift it off the spokes.
      // The bow scales with chord length, so cap it in world units — otherwise a
      // ring-1→ring-5 edge sweeps across every ring in between.
      const levelSpan = Math.abs(sourceLevel - targetLevel);
      const chord = Math.hypot(targetPos.x - sourcePos.x, targetPos.y - sourcePos.y);
      const offsetCap = EGO_CROSS_RING_MAX_OFFSET * fallbackGap;
      const magnitude = Math.min(
        0.1 + 0.05 * levelSpan,
        0.3,
        chord > 1e-6 ? offsetCap / chord : 0.3
      );
      // Radially collinear endpoints have no meaningful side — pick one deterministically
      curvature = Math.abs(delta) < 1e-6
        ? (sourceId < targetId ? magnitude : -magnitude)
        : sign * magnitude;
    }

    result.set(link, curvature + boundedBase * fanScale);
  }

  return result;
}

interface HiveNodeInput {
  node_id: string;
  node_type: string;
  properties?: Record<string, unknown>;
}

export interface HivePositionsOptions {
  /** 'node_type', 'community' (Louvain), 'prop:<name>' of a categorical node
   * property, or 'metric:<ref>' of a session-computed metric */
  axisKey: string;
  /** Categories beyond this count are bucketed into an "Others" axis */
  maxAxes: number;
  /** 'degree', 'prop:<name>' of a numeric node property, or 'metric:<ref>'
   * of a numeric session-computed metric */
  positionKey: string;
  scale: HiveScale;
  innerRadius: number;
  outerRadius: number;
}

export interface HivePositionsDeps {
  nodeDegrees: Map<string, number>;
  /** nodeId → community id, required when axisKey === 'community' */
  communityMap?: Map<string, number> | null;
  /**
   * Resolves 'metric:<ref>' axis/position keys (session-computed metrics).
   * Injected so layoutModes stays store-free; when absent, metric keys
   * behave like a missing value (inner radius / '(missing)' axis).
   */
  nodeMetricValue?: (ref: string, nodeId: string) => number | string | boolean | null | undefined;
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
  deps: HivePositionsDeps
): string {
  if (axisKey === 'node_type') return node.node_type;
  if (axisKey === 'community') {
    const communityId = deps.communityMap?.get(node.node_id);
    return communityId === undefined ? '(none)' : `Community ${communityId}`;
  }
  if (axisKey.startsWith('metric:')) {
    const value = deps.nodeMetricValue?.(axisKey.slice('metric:'.length), node.node_id);
    return value === null || value === undefined ? '(missing)' : String(value);
  }
  const propName = axisKey.startsWith('prop:') ? axisKey.slice(5) : axisKey;
  const value = node.properties?.[propName];
  return value === null || value === undefined ? '(missing)' : String(value);
}

function metricOf(
  node: HiveNodeInput,
  positionKey: string,
  deps: HivePositionsDeps
): number | null {
  if (positionKey === 'degree') return deps.nodeDegrees.get(node.node_id) ?? 0;
  let raw: unknown;
  if (positionKey.startsWith('metric:')) {
    raw = deps.nodeMetricValue?.(positionKey.slice('metric:'.length), node.node_id);
  } else {
    const propName = positionKey.startsWith('prop:') ? positionKey.slice(5) : positionKey;
    raw = node.properties?.[propName];
  }
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
    const cat = categoryOf(node, axisKey, deps);
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
    const cat = categoryOf(node, axisKey, deps);
    const axisIndex = axisIndexByCategory.get(cat) ?? axes.length - 1;
    const entry = { id: node.node_id, metric: metricOf(node, positionKey, deps) };
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
