/**
 * Temporal money trace, forward, and backward by reversal (investigations, 03 §6.1). Pure and deterministic:
 * `workers/traceWorker.ts` runs it off the main thread and the server port (F3.8)
 * must return the same numbers for `__tests__/fixtures/trace/golpe-pix.json`.
 *
 * Readings of §6.1 fixed here (decision log F3.3):
 * - edges before the window start still run, so they build opening balances (the
 *   300 already in 8812-7); they never carry traced value because a seed counts
 *   only inside the window. Edges after the window end are dropped;
 * - `hop(u)` is `layer(u)`, the smallest hop at which traced value reached u (0 for
 *   a node never reached), so lots need no hop of their own;
 * - a lot expires only when its node pays (step a); balances left at the end are
 *   "retained" whatever their age;
 * - frontier and exit edges add no lot to their destination;
 * - `edgeTrace` holds x before the minimum cut (c); the cut part is `discarded.belowMin`;
 * - money is rounded to cents (half up) only in the returned result.
 */
import type { Edge, EdgeSemantics } from '@/types/graph';
import { edgeValue } from './edgeSemantics';

/** `lifo` exists for the backward trace (F3.4): LIFO on reversed edges is LIFO in real time. */
export type Allocation = 'fifo' | 'lifo' | 'proportional' | 'libr' | 'total';

export interface TraceEdge {
  id: string;
  src: string;
  dst: string;
  /** > 0. */
  amount: number;
  /** Epoch ms. */
  t: number;
}

export interface TraceParams {
  direction: 'forward' | 'backward';
  maxHops: number;
  /** Max dwell Δ in ms; null = no limit. */
  maxDwellMs: number | null;
  minAmount: number;
  /** [t0, t1] epoch ms; null = unbounded. */
  window: [number, number] | null;
  allocation: Allocation;
  stopTypes: string[];
  stopNodes: string[];
}

export interface TraceNode {
  layer: number;
  tracedIn: number;
  tracedOut: number;
  retained: number;
}

export interface TraceResult {
  edgeTrace: Record<string, number>;
  nodes: Record<string, TraceNode>;
  exits: Record<string, number>;
  frontier: { edgeId: string; amount: number }[];
  discarded: { belowMin: number; expired: number };
  seedTotal: number;
  exitTotal: number;
  /** Σexits / Σseed, 4 decimals. */
  coverage: number;
  method: TraceParams & { seedEdgeIds: string[] };
}

interface Lot {
  amount: number;
  traced: number;
  arrivedAt: number;
}

/** Graph edges with a positive amount and a time, read through the context's semantics (F3.1). */
export function toTraceEdges(edges: Edge[], semantics: EdgeSemantics | null | undefined): TraceEdge[] {
  const out: TraceEdge[] = [];
  for (const e of edges) {
    const { amount, t } = edgeValue(e, semantics);
    if (amount !== null && amount > 0 && t !== null) out.push({ id: e.edge_id, src: e.src, dst: e.dst, amount, t });
  }
  return out;
}

/** Takes `a` out of `lots` by the rule and returns x, the traced part of it. Mutates `lots`. */
function allocate(lots: Lot[], a: number, rule: Allocation): number {
  let B = 0;
  let T = 0;
  for (const l of lots) {
    B += l.amount;
    T += l.traced;
  }
  if (B <= 0) return 0;
  if (rule === 'proportional') {
    const x = a >= B ? T : (a * T) / B;
    if (a >= B) lots.length = 0;
    else for (const l of lots) {
      l.traced -= (a * l.traced) / B;
      l.amount -= (a * l.amount) / B;
    }
    return x;
  }
  if (rule === 'libr') {
    // Untraced leaves first (oldest first), then traced (oldest first).
    let need = a;
    for (const l of lots) {
      const take = Math.min(Math.max(0, l.amount - l.traced), need);
      l.amount -= take;
      need -= take;
    }
    let x = 0;
    for (const l of lots) {
      const take = Math.min(l.traced, need);
      l.amount -= take;
      l.traced -= take;
      x += take;
      need -= take;
    }
    removeEmpty(lots);
    return x;
  }
  // FIFO/LIFO; total contamination drains the balance like FIFO but reports all of `a`.
  const lifo = rule === 'lifo';
  let need = a;
  let x = 0;
  while (need > 0 && lots.length) {
    const l = lifo ? lots[lots.length - 1] : lots[0];
    if (l.amount <= need) {
      x += l.traced;
      need -= l.amount;
      if (lifo) lots.pop();
      else lots.shift();
    } else {
      const tr = (l.traced * need) / l.amount;
      x += tr;
      l.traced -= tr;
      l.amount -= need;
      need = 0;
    }
  }
  return rule === 'total' ? (T > 0 ? a : 0) : x;
}

function removeEmpty(lots: Lot[]): void {
  for (let i = lots.length - 1; i >= 0; i--) if (lots[i].amount <= 0) lots.splice(i, 1);
}

const cents = (v: number) => Math.round(v * 100) / 100;
const roundMap = (m: Record<string, number>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, cents(v)]));

export function traceForward(
  edges: TraceEdge[],
  nodeTypes: Record<string, string>,
  seed: { edgeIds: string[] },
  params: TraceParams,
): TraceResult {
  const [t0, t1] = params.window ?? [-Infinity, Infinity];
  const seeds = new Set(seed.edgeIds);
  const stopTypes = new Set(params.stopTypes);
  const stopNodes = new Set(params.stopNodes);
  const isStop = (v: string) => stopNodes.has(v) || stopTypes.has(nodeTypes[v]);

  // Stable order: time, then id (plain code-unit comparison, as Python sorts strings).
  const ordered = edges
    .filter(e => e.t <= t1)
    .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const lots = new Map<string, Lot[]>();
  const nodes: Record<string, TraceNode> = {};
  const edgeTrace: Record<string, number> = {};
  const exits: Record<string, number> = {};
  const frontier: { edgeId: string; amount: number }[] = [];
  const discarded = { belowMin: 0, expired: 0 };
  let seedTotal = 0;
  const seedEdgeIds: string[] = [];

  const node = (id: string, layer: number) => (nodes[id] ??= { layer, tracedIn: 0, tracedOut: 0, retained: 0 });

  for (const e of ordered) {
    const isSeed = seeds.has(e.id) && e.t >= t0;
    let x: number;
    let hopU: number;
    if (isSeed) {
      x = e.amount;
      hopU = 0;
      seedTotal += x;
      seedEdgeIds.push(e.id);
    } else {
      const uLots = lots.get(e.src) ?? [];
      if (params.maxDwellMs !== null) {
        for (const l of uLots) {
          if (l.traced > 0 && e.t - l.arrivedAt > params.maxDwellMs) {
            discarded.expired += l.traced;
            l.traced = 0;
          }
        }
      }
      x = allocate(uLots, e.amount, params.allocation);
      hopU = nodes[e.src]?.layer ?? 0;
      if (x > 0) nodes[e.src].tracedOut += x;
    }
    if (x > 0) edgeTrace[e.id] = x;
    if (x > 0 && x < params.minAmount) {
      discarded.belowMin += x;
      x = 0;
    }
    if (hopU >= params.maxHops) {
      if (x > 0) frontier.push({ edgeId: e.id, amount: x });
      continue;
    }
    if (x > 0) {
      const v = node(e.dst, hopU + 1);
      v.layer = Math.min(v.layer, hopU + 1);
      v.tracedIn += x;
    }
    if (isStop(e.dst)) {
      if (x > 0) exits[e.dst] = (exits[e.dst] ?? 0) + x;
      continue;
    }
    let vLots = lots.get(e.dst);
    if (!vLots) lots.set(e.dst, (vLots = []));
    vLots.push({ amount: e.amount, traced: x, arrivedAt: e.t });
  }

  for (const [id, n] of Object.entries(nodes)) {
    for (const l of lots.get(id) ?? []) n.retained += l.traced;
    nodes[id] = { layer: n.layer, tracedIn: cents(n.tracedIn), tracedOut: cents(n.tracedOut), retained: cents(n.retained) };
  }
  const exitTotal = Object.values(exits).reduce((s, v) => s + v, 0);
  return {
    edgeTrace: roundMap(edgeTrace),
    nodes,
    exits: roundMap(exits),
    frontier: frontier.map(f => ({ edgeId: f.edgeId, amount: cents(f.amount) })),
    discarded: { belowMin: cents(discarded.belowMin), expired: cents(discarded.expired) },
    seedTotal: cents(seedTotal),
    exitTotal: cents(exitTotal),
    coverage: seedTotal > 0 ? Math.round((exitTotal / seedTotal) * 1e4) / 1e4 : 0,
    method: { ...params, seedEdgeIds },
  };
}

/** The edges as the trace walks them: backward = reversed and in negated time. */
export function orientEdges(edges: TraceEdge[], direction: TraceParams['direction']): TraceEdge[] {
  return direction === 'backward' ? edges.map(e => ({ ...e, src: e.dst, dst: e.src, t: -e.t })) : edges;
}

/**
 * Backward ("where did it come from"): the forward walk on reversed edges in negated
 * time. Node figures read in that reversed sense (`exits` are the origins reached).
 * Only LIFO, proportional and total contamination keep their meaning reversed; FIFO
 * and LIBR do not (the screen does not offer them backward).
 */
export function traceBackward(
  edges: TraceEdge[],
  nodeTypes: Record<string, string>,
  seed: { edgeIds: string[] },
  params: TraceParams,
): TraceResult {
  const w = params.window;
  const r = traceForward(orientEdges(edges, 'backward'), nodeTypes, seed, { ...params, window: w ? [-w[1], -w[0]] : null });
  return { ...r, method: { ...r.method, window: w } };
}

export function runTrace(
  edges: TraceEdge[],
  nodeTypes: Record<string, string>,
  seed: { edgeIds: string[] },
  params: TraceParams,
): TraceResult {
  return (params.direction === 'backward' ? traceBackward : traceForward)(edges, nodeTypes, seed, params);
}
