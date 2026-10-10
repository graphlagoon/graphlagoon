/**
 * Paths between two nodes (investigations F3.6, 03 §6.3). Pure and deterministic:
 * `workers/pathWorker.ts` runs it off the main thread and the server port (F3.8) must
 * return the same paths.
 *
 * Tie-breaking: parallel edges between the same pair collapse to the lightest arc
 * (then the smallest edge id); neighbours are visited by node id; Dijkstra settles by
 * (distance, node id) and keeps the first predecessor; Yen orders candidates by
 * (cost, node sequence). Costs are summed from the source in path order.
 */

export interface PathEdge {
  id: string;
  src: string;
  dst: string;
  amount: number | null;
  /** Epoch ms. */
  t: number | null;
}

export type PathMode = 'shortest' | 'weighted' | 'k-shortest' | 'earliest';

export interface PathParams {
  mode: PathMode;
  /** false walks edges both ways; 'earliest' always follows direction and time. */
  directed: boolean;
  /** 'weighted' and 'k-shortest': 1 per hop, or 1 / amount (edges without an amount are skipped). */
  weight: 'hops' | 'inverse-amount';
  /** 'k-shortest', capped at 10. */
  k: number;
  /** 'earliest': departure time at the source (epoch ms); null = any. */
  t0: number | null;
  /** 'earliest': max dwell Δ in ms at an intermediate node; null = no limit. */
  maxDwellMs: number | null;
}

export interface Path {
  nodes: string[];
  edges: string[];
  /** Hops ('shortest'), weight sum ('weighted', 'k-shortest') or arrival epoch ms ('earliest'). */
  cost: number;
}

export const MAX_K = 10;

interface Arc {
  to: string;
  edge: string;
  w: number;
}
type Adjacency = Map<string, Arc[]>;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function buildAdjacency(edges: PathEdge[], directed: boolean, weight: PathParams['weight']): Adjacency {
  const best = new Map<string, Map<string, Arc>>();
  const put = (from: string, to: string, edge: string, w: number) => {
    let m = best.get(from);
    if (!m) best.set(from, (m = new Map()));
    const cur = m.get(to);
    if (!cur || w < cur.w || (w === cur.w && edge < cur.edge)) m.set(to, { to, edge, w });
  };
  for (const e of edges) {
    if (e.src === e.dst) continue;
    let w = 1;
    if (weight === 'inverse-amount') {
      if (e.amount === null || !(e.amount > 0)) continue;
      w = 1 / e.amount;
    }
    put(e.src, e.dst, e.id, w);
    if (!directed) put(e.dst, e.src, e.id, w);
  }
  const adj: Adjacency = new Map();
  for (const [from, m] of best) adj.set(from, [...m.values()].sort((a, b) => cmp(a.to, b.to)));
  return adj;
}

/** Edges and cost of a node sequence, summed from its first node. */
function pathOf(adj: Adjacency, nodes: string[]): Path {
  const edges: string[] = [];
  let cost = 0;
  for (let i = 0; i + 1 < nodes.length; i++) {
    const arc = adj.get(nodes[i])!.find((a) => a.to === nodes[i + 1])!;
    edges.push(arc.edge);
    cost += arc.w;
  }
  return { nodes, edges, cost };
}

function unwind(pred: Map<string, string>, source: string, target: string): string[] {
  const nodes = [target];
  while (nodes[0] !== source) nodes.unshift(pred.get(nodes[0])!);
  return nodes;
}

/** Fewest hops. */
export function bfs(adj: Adjacency, source: string, target: string): Path | null {
  const pred = new Map<string, string>([[source, source]]);
  let frontier = [source];
  while (frontier.length && !pred.has(target)) {
    const next: string[] = [];
    for (const u of frontier) {
      for (const { to } of adj.get(u) ?? []) {
        if (pred.has(to)) continue;
        pred.set(to, u);
        next.push(to);
      }
    }
    frontier = next;
  }
  if (!pred.has(target)) return null;
  return pathOf(adj, unwind(pred, source, target));
}

/** Binary min-heap of [distance, node], ordered by distance then node id. */
class Heap {
  private a: [number, string][] = [];
  get size() {
    return this.a.length;
  }
  private less(i: number, j: number) {
    const [di, ni] = this.a[i];
    const [dj, nj] = this.a[j];
    return di < dj || (di === dj && ni < nj);
  }
  private swap(i: number, j: number) {
    [this.a[i], this.a[j]] = [this.a[j], this.a[i]];
  }
  push(x: [number, string]) {
    this.a.push(x);
    for (let i = this.a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, string] {
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length) {
      this.a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.a.length && this.less(l, m)) m = l;
        if (r < this.a.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

/** Lightest path, avoiding `blockedNodes` and the `from→to` arcs in `blockedArcs`. */
export function dijkstra(
  adj: Adjacency,
  source: string,
  target: string,
  blockedNodes: Set<string> = new Set(),
  blockedArcs: Set<string> = new Set(),
): Path | null {
  const dist = new Map<string, number>([[source, 0]]);
  const pred = new Map<string, string>();
  const done = new Set<string>();
  const heap = new Heap();
  heap.push([0, source]);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (done.has(u)) continue;
    done.add(u);
    if (u === target) break;
    for (const { to, w } of adj.get(u) ?? []) {
      if (done.has(to) || blockedNodes.has(to) || blockedArcs.has(`${u}\u0000${to}`)) continue;
      const nd = d + w;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        pred.set(to, u);
        heap.push([nd, to]);
      }
    }
  }
  if (!done.has(target)) return null;
  return pathOf(adj, unwind(pred, source, target));
}

const sameStart = (p: string[], root: string[]) => root.every((n, i) => p[i] === n);
const byCostThenNodes = (a: Path, b: Path) => {
  if (a.cost !== b.cost) return a.cost - b.cost;
  for (let i = 0; i < Math.min(a.nodes.length, b.nodes.length); i++) {
    const c = cmp(a.nodes[i], b.nodes[i]);
    if (c) return c;
  }
  return a.nodes.length - b.nodes.length;
};

/** Yen's k loopless lightest paths, lightest first. */
export function yen(adj: Adjacency, source: string, target: string, k: number): Path[] {
  const first = dijkstra(adj, source, target);
  if (!first) return [];
  const found = [first];
  const candidates: Path[] = [];
  const seen = new Set([first.nodes.join('\u0000')]);
  while (found.length < Math.min(k, MAX_K)) {
    const prev = found[found.length - 1];
    for (let i = 0; i + 1 < prev.nodes.length; i++) {
      const root = prev.nodes.slice(0, i + 1);
      const blockedArcs = new Set(
        found.filter((p) => sameStart(p.nodes, root)).map((p) => `${p.nodes[i]}\u0000${p.nodes[i + 1]}`),
      );
      const spur = dijkstra(adj, root[i], target, new Set(root.slice(0, i)), blockedArcs);
      if (!spur) continue;
      const nodes = [...root.slice(0, i), ...spur.nodes];
      const key = nodes.join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(pathOf(adj, nodes));
    }
    if (!candidates.length) break;
    candidates.sort(byCostThenNodes);
    found.push(candidates.shift()!);
  }
  return found;
}

/**
 * Earliest arrival over time-respecting edges (§6.3): one pass over edges by (t, id).
 * Δ binds only intermediate nodes (the source holds the money since t0).
 */
export function earliestArrival(
  edges: PathEdge[],
  source: string,
  target: string,
  t0: number | null,
  maxDwellMs: number | null,
): Path | null {
  const timed = edges
    .filter((e): e is PathEdge & { t: number } => e.t !== null && e.src !== e.dst)
    .sort((a, b) => a.t - b.t || cmp(a.id, b.id));
  const arrival = new Map<string, number>([[source, t0 ?? -Infinity]]);
  const pred = new Map<string, PathEdge>();
  for (const e of timed) {
    const au = arrival.get(e.src);
    if (au === undefined || e.t < au) continue;
    if (maxDwellMs !== null && e.src !== source && e.t - au > maxDwellMs) continue;
    if (e.t < (arrival.get(e.dst) ?? Infinity)) {
      arrival.set(e.dst, e.t);
      pred.set(e.dst, e);
    }
  }
  if (target === source || !pred.has(target)) return null;
  const nodes = [target];
  const ids: string[] = [];
  while (nodes[0] !== source) {
    const e = pred.get(nodes[0])!;
    ids.unshift(e.id);
    nodes.unshift(e.src);
  }
  return { nodes, edges: ids, cost: arrival.get(target)! };
}

/** The paths `params.mode` asks for, best first; [] when there is none. */
export function findPaths(edges: PathEdge[], source: string, target: string, params: PathParams): Path[] {
  if (source === target) return [];
  if (params.mode === 'earliest') {
    const p = earliestArrival(edges, source, target, params.t0, params.maxDwellMs);
    return p ? [p] : [];
  }
  const adj = buildAdjacency(edges, params.directed, params.mode === 'shortest' ? 'hops' : params.weight);
  if (params.mode === 'k-shortest') return yen(adj, source, target, params.k);
  const p = params.mode === 'shortest' ? bfs(adj, source, target) : dijkstra(adj, source, target);
  return p ? [p] : [];
}
