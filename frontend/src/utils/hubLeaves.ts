/**
 * Hub leaf arrangement: a hub's leaves (nodes whose only neighbour is that hub)
 * are laid out right next to it instead of being left to the force simulation.
 *
 * Nothing is grouped or hidden in the data — every leaf stays a real node.
 * Position carries the link, so the hub–leaf edges can be left undrawn
 * (see `implicitEdgeKey`). Two shapes:
 *   - crown:  one sunflower spiral around the hub;
 *   - petals: one sunflower disc per value of a key (node type, property…),
 *             discs placed around the hub, largest first.
 *
 * Pure: no Vue, no three.js. The force in `forceHubLeaves` is plain d3 shape so
 * it runs both on the live engine and in the headless settle worker.
 */

export type HubLeavesMode = 'free' | 'crown' | 'petals';

/** Golden angle: successive points never line up radially (Vogel 1979). */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Vogel spiral r = c·√i keeps nearest neighbours ≈ 1.75·c apart; c = d/1.75 gives ≈ d. */
const SPIRAL_FACTOR = 1 / 1.75;
/** Bucket for leaves the key does not resolve on. Sorted last, never scattered. */
export const MISSING_KEY = '(no value)';
/** Petal that gathers the smallest groups when a key has more values than maxPetals. */
export const OTHER_KEY = 'Other';
/** More petals than this stop reading as groups; the smallest go to OTHER_KEY. */
export const DEFAULT_MAX_PETALS = 8;

export interface HubLeavesLink {
  id: string;
  source: string;
  target: string;
}

export interface HubLeafRegion {
  hub: string;
  /** Group value ('' in crown mode). */
  key: string;
  count: number;
  /** Centre of the region relative to the hub. */
  dx: number;
  dy: number;
  /** Radius of the region's disc. */
  radius: number;
  /** OTHER_KEY only: how many values it gathers. */
  values?: number;
  /** Leaf ids from the centre of the disc outwards (spiral order). */
  members: string[];
}

export interface HubLeavesPlan {
  /** leaf id → its hub and offset from the hub. */
  offsets: Map<string, { hub: string; dx: number; dy: number }>;
  /** hub id → radius of everything arranged around it (keeps other nodes out). */
  hubRadius: Map<string, number>;
  regions: HubLeafRegion[];
  /** Edge ids between a leaf and its hub (drawn implicitly by position). */
  implicitEdgeIds: Set<string>;
  /** Automatic key (keyCandidates): the candidate chosen for each hub. */
  keyByHub: Map<string, string>;
}

/** A key the automatic choice may pick: its name (shown to the user) and how it reads a leaf. */
export interface HubLeavesKeyCandidate {
  name: string;
  keyOf: (leafId: string, hubId: string) => string | null;
}

export interface HubLeavesOptions {
  mode: Exclude<HubLeavesMode, 'free'>;
  /** A node is a hub when it has at least this many leaves. */
  minLeaves: number;
  /** Minimum distance between two leaf centres. */
  spacing: number;
  /** Visual radius of a hub (the arrangement starts outside it). */
  hubRadiusOf: (hubId: string) => number;
  /** Group key of a leaf (petals). null → MISSING_KEY. Ignored in crown mode. */
  keyOf?: (leafId: string, hubId: string) => string | null;
  /** Petals, automatic key: each hub picks the best candidate (scoreKey). Wins over keyOf. */
  keyCandidates?: HubLeavesKeyCandidate[];
  /** Most petals per hub; the smallest groups beyond it share one OTHER_KEY petal. Default 8. */
  maxPetals?: number;
}

/**
 * How well a key splits a hub's leaves into petals, 0 when it does not.
 * coverage × information, where information is the Shannon entropy of the
 * values (bits, at most log2(maxPetals)), discounted by (maxPetals/k)² when the
 * key has more values than petals. So an even split by role (5 values) beats
 * node type when almost every leaf is a Person, and a name or an id (one value
 * per leaf) scores near zero.
 */
export function scoreKey(values: (string | null)[], maxPetals = DEFAULT_MAX_PETALS): number {
  const counts = new Map<string, number>();
  let present = 0;
  for (const v of values) {
    if (v === null) continue;
    present++;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const k = counts.size;
  if (k < 2 || present === 0) return 0;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / present;
    h -= p * Math.log2(p);
  }
  const info = Math.min(h, Math.log2(maxPetals));
  return (present / values.length) * info * Math.min(1, (maxPetals / k) ** 2);
}

/** The best candidate for one hub's leaves (first one wins a tie); null when none splits them. */
export function chooseKey(
  leaves: string[],
  hub: string,
  candidates: HubLeavesKeyCandidate[],
  maxPetals = DEFAULT_MAX_PETALS,
): HubLeavesKeyCandidate | null {
  let best: HubLeavesKeyCandidate | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = scoreKey(leaves.map((l) => c.keyOf(l, hub)), maxPetals);
    if (score > bestScore + 1e-9) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Leaves per hub: a leaf's distinct neighbours, self-loops ignored, are exactly {hub}. */
export function findHubLeaves(links: HubLeavesLink[], minLeaves: number): Map<string, string[]> {
  const neighbours = new Map<string, Set<string>>();
  for (const l of links) {
    if (l.source === l.target) continue;
    let a = neighbours.get(l.source);
    if (!a) neighbours.set(l.source, (a = new Set()));
    a.add(l.target);
    let b = neighbours.get(l.target);
    if (!b) neighbours.set(l.target, (b = new Set()));
    b.add(l.source);
  }
  const byHub = new Map<string, string[]>();
  for (const [id, set] of neighbours) {
    if (set.size !== 1) continue;
    const hub = set.values().next().value as string;
    // Two nodes linked only to each other: neither is a hub.
    if ((neighbours.get(hub)?.size ?? 0) < 2) continue;
    let list = byHub.get(hub);
    if (!list) byHub.set(hub, (list = []));
    list.push(id);
  }
  for (const [hub, leaves] of byHub) {
    if (leaves.length < minLeaves) byHub.delete(hub);
    else leaves.sort();
  }
  return byHub;
}

/** Offsets of n points on a sunflower spiral, starting at radius r0. */
export function spiralOffsets(n: number, spacing: number, r0 = 0): { dx: number; dy: number }[] {
  const c = spacing * SPIRAL_FACTOR;
  const out: { dx: number; dy: number }[] = [];
  for (let i = 0; i < n; i++) {
    // Area-preserving: an annulus from r0 holds the same points per area as a disc.
    const r = Math.sqrt(r0 * r0 + c * c * (i + 0.5));
    const a = i * GOLDEN_ANGLE;
    out.push({ dx: r * Math.cos(a), dy: r * Math.sin(a) });
  }
  return out;
}

/** Radius of a sunflower disc of n points (outermost centre + half a spacing). */
export function spiralRadius(n: number, spacing: number, r0 = 0): number {
  const c = spacing * SPIRAL_FACTOR;
  return Math.sqrt(r0 * r0 + c * c * Math.max(0, n - 0.5)) + spacing / 2;
}

function compareGroups(a: [string, string[]], b: [string, string[]]): number {
  if ((a[0] === MISSING_KEY) !== (b[0] === MISSING_KEY)) return a[0] === MISSING_KEY ? 1 : -1;
  if (b[1].length !== a[1].length) return b[1].length - a[1].length;
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

export function computeHubLeavesPlan(links: HubLeavesLink[], opts: HubLeavesOptions): HubLeavesPlan {
  const plan: HubLeavesPlan = {
    offsets: new Map(),
    hubRadius: new Map(),
    regions: [],
    implicitEdgeIds: new Set(),
    keyByHub: new Map(),
  };
  const maxPetals = Math.max(2, opts.maxPetals ?? DEFAULT_MAX_PETALS);
  const d = opts.spacing;
  const byHub = findHubLeaves(links, opts.minLeaves);
  if (byHub.size === 0) return plan;

  for (const [hub, leaves] of byHub) {
    const inner = opts.hubRadiusOf(hub) + d;
    if (opts.mode === 'crown') {
      const offs = spiralOffsets(leaves.length, d, inner);
      leaves.forEach((leaf, i) => plan.offsets.set(leaf, { hub, ...offs[i] }));
      const radius = spiralRadius(leaves.length, d, inner);
      plan.hubRadius.set(hub, radius);
      plan.regions.push({ hub, key: '', count: leaves.length, dx: 0, dy: 0, radius, members: leaves });
      continue;
    }

    let keyOf = opts.keyOf;
    if (opts.keyCandidates) {
      const chosen = chooseKey(leaves, hub, opts.keyCandidates, maxPetals);
      keyOf = chosen?.keyOf;
      if (chosen) plan.keyByHub.set(hub, chosen.name);
    }
    const groups = new Map<string, string[]>();
    for (const leaf of leaves) {
      const key = keyOf?.(leaf, hub) ?? MISSING_KEY;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(leaf);
    }
    let ordered = [...groups.entries()].sort(compareGroups);
    // Too many petals: the largest keep theirs, the rest share one "Other".
    let otherValues = 0;
    if (ordered.length > maxPetals) {
      const kept = ordered.slice(0, maxPetals - 1);
      const rest = ordered.slice(maxPetals - 1);
      otherValues = rest.length;
      ordered = [...kept, [OTHER_KEY, rest.flatMap(([, m]) => m)]];
    }
    const radii = ordered.map(([, members]) => spiralRadius(members.length, d));
    const gap = d;
    const circumference = radii.reduce((s, r) => s + 2 * r + gap, 0);
    // Ring that fits every disc side by side, and clears the hub.
    const ring = Math.max(circumference / (2 * Math.PI), inner + Math.max(...radii));
    let along = 0;
    let outer = 0;
    ordered.forEach(([key, members], gi) => {
      const R = radii[gi];
      // Start at the top (−π/2) and go clockwise on screen, largest first.
      const angle = -Math.PI / 2 + ((along + R + gap / 2) / circumference) * 2 * Math.PI;
      along += 2 * R + gap;
      const cx = ring * Math.cos(angle);
      const cy = ring * Math.sin(angle);
      const offs = spiralOffsets(members.length, d);
      members.forEach((leaf, i) => plan.offsets.set(leaf, { hub, dx: cx + offs[i].dx, dy: cy + offs[i].dy }));
      const region: HubLeafRegion = { hub, key, count: members.length, dx: cx, dy: cy, radius: R, members };
      if (otherValues && gi === ordered.length - 1) region.values = otherValues;
      plan.regions.push(region);
      outer = Math.max(outer, ring + R);
    });
    plan.hubRadius.set(hub, outer);
  }

  for (const l of links) {
    const a = plan.offsets.get(l.source);
    const b = plan.offsets.get(l.target);
    if ((a && a.hub === l.target) || (b && b.hub === l.source)) plan.implicitEdgeIds.add(l.id);
  }
  return plan;
}

/**
 * Text of a region label ("Person (114)", or "285 leaves" for a crown). ASCII
 * punctuation only: the label atlas covers ASCII 32–126 (FastLabelRenderer).
 */
export function regionLabel(region: HubLeafRegion, hidden = 0): string {
  let text: string;
  if (region.key === '') text = `${region.count} leaves`;
  else if (region.values) text = `${region.values} other values (${region.count})`;
  else text = `${region.key} (${region.count})`;
  return hidden > 0 ? `${text} +${hidden} hidden` : text;
}

// ---------------------------------------------------------------------------
// Reveal on zoom (D7, opt-in): far away a region shows only its inner leaves
// ---------------------------------------------------------------------------

/** Below this distance on screen between two leaf centres, leaves start to be hidden. */
export const REVEAL_MIN_PX = 6;
/** A region never shows fewer leaves than this (or all, if it has fewer). */
export const REVEAL_MIN_LEAVES = 3;

/**
 * How many of a region's n leaves to show when two neighbouring leaves are
 * `spacingPx` apart on screen. Keeps the shown leaves about REVEAL_MIN_PX apart
 * (density ∝ spacing²), quantized to powers of 2 so a small zoom does not
 * redraw and the count does not flicker around a threshold.
 */
export function revealCount(n: number, spacingPx: number): number {
  if (!(spacingPx > 0) || spacingPx >= REVEAL_MIN_PX) return n;
  const frac = (spacingPx / REVEAL_MIN_PX) ** 2;
  const q = 2 ** Math.floor(Math.log2(frac));
  return Math.min(n, Math.max(REVEAL_MIN_LEAVES, Math.ceil(n * q)));
}

/**
 * Leaves hidden at this zoom: the outer part of each region (inner leaves stay,
 * so nothing moves), never one in `keep` (selected, hovered). `hiddenByRegion`
 * is in plan.regions order, for the "+N hidden" marks.
 */
export function zoomHiddenLeaves(
  regions: HubLeafRegion[],
  spacingPx: number,
  keep: Set<string> = new Set(),
): { hidden: Set<string>; hiddenByRegion: number[] } {
  const hidden = new Set<string>();
  const hiddenByRegion = regions.map((r) => {
    const shown = revealCount(r.members.length, spacingPx);
    let n = 0;
    for (let i = shown; i < r.members.length; i++) {
      const id = r.members[i];
      if (keep.has(id)) continue;
      hidden.add(id);
      n++;
    }
    return n;
  });
  return { hidden, hiddenByRegion };
}

// ---------------------------------------------------------------------------
// Serializable form (worker messages) and the d3 force
// ---------------------------------------------------------------------------

export interface SerializedHubLeavesPlan {
  offsets: [string, string, number, number][];
  hubRadius: [string, number][];
}

export function serializeHubLeavesPlan(plan: HubLeavesPlan): SerializedHubLeavesPlan {
  return {
    offsets: [...plan.offsets].map(([leaf, o]) => [leaf, o.hub, o.dx, o.dy]),
    hubRadius: [...plan.hubRadius],
  };
}

interface ForceNode {
  id: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

interface Placement {
  offsets: Map<string, { hub: string; dx: number; dy: number }>;
  hubRadius: Map<string, number>;
  maxRadius: number;
  spacing: number;
}

function toPlacement(serialized: SerializedHubLeavesPlan, spacing: number): Placement {
  const hubRadius = new Map(serialized.hubRadius);
  let maxRadius = 0;
  for (const r of hubRadius.values()) maxRadius = Math.max(maxRadius, r);
  return {
    offsets: new Map(serialized.offsets.map(([leaf, hub, dx, dy]) => [leaf, { hub, dx, dy }])),
    hubRadius,
    maxRadius,
    spacing,
  };
}

/** Where a node is anchored: its pin when it has one (a dragged or pinned hub), else its position. */
function anchorX(n: ForceNode): number { return n.fx ?? n.x!; }
function anchorY(n: ForceNode): number { return n.fy ?? n.y!; }

/**
 * Put n at (x, y) moving with `anchor`: the simulation integrates velocity
 * after the forces ran, so sharing the anchor's velocity keeps the offset
 * exact through that step. A pinned node is moved through its pin.
 */
function place(n: ForceNode, x: number, y: number, anchor: ForceNode) {
  n.x = x;
  n.y = y;
  n.vx = anchor.fx != null ? 0 : anchor.vx ?? 0;
  n.vy = anchor.fy != null ? 0 : anchor.vy ?? 0;
  if (n.fx != null) n.fx = x;
  if (n.fy != null) n.fy = y;
}

/** One placement pass over `nodes`. O(nodes + hubs) with a grid over the hubs. */
function placeAll(nodes: ForceNode[], byId: Map<string, ForceNode>, p: Placement) {
  // Grid of hub anchors; a cell wide enough that a node only meets hubs in its 3×3 block.
  const cell = 2 * p.maxRadius + 2 * p.spacing;
  const grid = new Map<string, [ForceNode, number][]>();
  for (const [id, r] of p.hubRadius) {
    const h = byId.get(id);
    if (!h || h.x === undefined || h.y === undefined) continue;
    const key = `${Math.floor(anchorX(h) / cell)},${Math.floor(anchorY(h) / cell)}`;
    const list = grid.get(key);
    if (list) list.push([h, r]);
    else grid.set(key, [[h, r]]);
  }
  // Keep non-leaves out of every arrangement (a hub keeps its own radius clear too).
  for (const n of nodes) {
    if (p.offsets.has(n.id) || n.x === undefined || n.y === undefined) continue;
    const own = p.hubRadius.get(n.id) ?? p.spacing / 2;
    const gx = Math.floor(n.x / cell);
    const gy = Math.floor(n.y / cell);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const hubs = grid.get(`${gx + i},${gy + j}`);
        if (!hubs) continue;
        for (const [h, r] of hubs) {
          if (h === n) continue;
          const hx = anchorX(h);
          const hy = anchorY(h);
          const dx = n.x - hx;
          const dy = n.y - hy;
          const min = r + own + p.spacing;
          if (dx * dx + dy * dy >= min * min) continue;
          const dist = Math.hypot(dx, dy);
          // Coincident points: push along a deterministic direction.
          const ux = dist > 1e-6 ? dx / dist : 1;
          const uy = dist > 1e-6 ? dy / dist : 0;
          place(n, hx + ux * min, hy + uy * min, h);
        }
      }
    }
  }
  for (const n of nodes) {
    const o = p.offsets.get(n.id);
    if (!o) continue;
    const h = byId.get(o.hub);
    if (!h || h.x === undefined || h.y === undefined) continue;
    place(n, anchorX(h) + o.dx, anchorY(h) + o.dy, h);
  }
}

/**
 * d3 force that keeps each leaf at `hub + offset` and pushes every other node
 * out of a hub's arrangement (so the layout reserves its space).
 *
 * Register it LAST: it overwrites positions after the other forces ran.
 */
export function forceHubLeaves(serialized: SerializedHubLeavesPlan, spacing: number) {
  const p = toPlacement(serialized, spacing);
  let nodes: ForceNode[] = [];
  let byId = new Map<string, ForceNode>();
  function force() {
    placeAll(nodes, byId, p);
  }
  force.initialize = (ns: ForceNode[]) => {
    nodes = ns;
    byId = new Map(ns.map((n) => [n.id, n]));
  };
  return force;
}

/**
 * Apply the arrangement once to `nodes`, outside any simulation: for a layout
 * that is stopped or pinned, or nodes the simulation has not picked up yet.
 */
export function snapHubLeaves(nodes: ForceNode[], serialized: SerializedHubLeavesPlan, spacing: number): void {
  placeAll(nodes, new Map(nodes.map((n) => [n.id, n])), toPlacement(serialized, spacing));
}
