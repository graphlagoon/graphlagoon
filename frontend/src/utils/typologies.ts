/**
 * Typology badges (investigations F4.3, 03 §6.4): graph patterns that match the
 * CC BCB 4.001/2020 indicators. Pure and deterministic; the Python mirror
 * (`api/graphlagoon/services/typologies.py`, MCP `run_typologies`) must return the
 * same hits on `__tests__/fixtures/typologies/small.json`.
 *
 * Badges only suggest: a person accepts one, and that writes `typology.accepted`.
 *
 * Money edges have an amount > 0. Windows slide from each timed edge (sorted by
 * time, then id); an edge with an amount but no time counts in every window.
 * Hits come sorted by node id, evidence edge ids sorted.
 */

export interface TypologyNode {
  id: string;
  type: string;
}

export interface TypologyEdge {
  id: string;
  src: string;
  dst: string;
  amount: number | null;
  /** Epoch ms. */
  t: number | null;
}

export interface TypologyGraph {
  nodes: TypologyNode[];
  edges: TypologyEdge[];
}

export interface TypologyHit {
  nodeId: string;
  evidenceEdgeIds: string[];
  explanation: string;
}

export type TypologyParams = Record<string, number>;

export interface Typology {
  id: string;
  label: string;
  /** CC 4.001 items the badge cites. */
  normRef: string;
  params: TypologyParams;
  detect(graph: TypologyGraph, params: TypologyParams): TypologyHit[];
}

export interface TypologyResult {
  id: string;
  label: string;
  normRef: string;
  params: TypologyParams;
  hits: TypologyHit[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Ceiling on DFS steps for the cycle search. shortcut: big graphs get a partial answer; move to a worker if it bites. */
const CYCLE_STEP_LIMIT = 200_000;

type MoneyEdge = TypologyEdge & { amount: number };
type TimedEdge = MoneyEdge & { t: number };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byTime = (a: TimedEdge, b: TimedEdge) => a.t - b.t || cmp(a.id, b.id);
const money = (x: number) => x.toFixed(2);
/** Integers print bare ("7"), others with 2 decimals; the Python mirror prints the same. */
const num = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2));
const sum = (es: { amount: number }[]) => es.reduce((s, e) => s + e.amount, 0);
const ids = (es: { id: string }[]) => [...new Set(es.map((e) => e.id))].sort(cmp);
const isTimed = (e: MoneyEdge): e is TimedEdge => e.t !== null;

function moneyEdges(g: TypologyGraph): MoneyEdge[] {
  return g.edges.filter((e): e is MoneyEdge => e.src !== e.dst && e.amount !== null && e.amount > 0);
}

function groupBy(edges: MoneyEdge[], key: 'src' | 'dst'): [string, MoneyEdge[]][] {
  const m = new Map<string, MoneyEdge[]>();
  for (const e of edges) {
    const list = m.get(e[key]);
    if (list) list.push(e);
    else m.set(e[key], [e]);
  }
  return [...m.entries()].sort((a, b) => cmp(a[0], b[0]));
}

/** The first window (from the earliest start) whose edges pass `ok`, or null. */
function firstWindow(edges: MoneyEdge[], windowMs: number, ok: (w: MoneyEdge[]) => boolean): MoneyEdge[] | null {
  const timed = edges.filter(isTimed).sort(byTime);
  const untimed = edges.filter((e) => e.t === null);
  if (!timed.length) return ok(untimed) ? untimed : null;
  for (let i = 0; i < timed.length; i++) {
    const w: MoneyEdge[] = [...untimed];
    for (let j = i; j < timed.length && timed[j].t <= timed[i].t + windowMs; j++) w.push(timed[j]);
    if (ok(w)) return w;
  }
  return null;
}

function distinctEnds(key: 'src' | 'dst', what: string) {
  return (g: TypologyGraph, p: TypologyParams): TypologyHit[] => {
    const hits: TypologyHit[] = [];
    const count = (w: MoneyEdge[]) => new Set(w.map((e) => e[key])).size;
    for (const [nodeId, edges] of groupBy(moneyEdges(g), key === 'src' ? 'dst' : 'src')) {
      const w = firstWindow(edges, p.windowDays * DAY_MS, (es) => count(es) >= p.minDistinct);
      if (w) hits.push({ nodeId, evidenceEdgeIds: ids(w), explanation: `${count(w)} distinct ${what} within ${num(p.windowDays)} d` });
    }
    return hits;
  };
}

function passagem(g: TypologyGraph, p: TypologyParams): TypologyHit[] {
  const edges = moneyEdges(g).filter(isTimed);
  const outs = new Map(groupBy(edges, 'src'));
  const hits: TypologyHit[] = [];
  for (const [nodeId, ins] of groupBy(edges, 'dst')) {
    const out = ((outs.get(nodeId) ?? []) as TimedEdge[]).sort(byTime);
    const left = new Map(out.map((o) => [o.id, o.amount]));
    const passed: TimedEdge[] = [];
    const used = new Map<string, TimedEdge>();
    let sent = 0;
    // FIFO: each inflow draws on what is left of the outflows in its window [t, t + Δ].
    for (const e of (ins as TimedEdge[]).sort(byTime)) {
      const takes: [TimedEdge, number][] = [];
      let covered = 0;
      for (const o of out) {
        if (covered >= e.amount) break;
        if (o.t < e.t || o.t > e.t + p.deltaHours * HOUR_MS || !(left.get(o.id)! > 0)) continue;
        const take = Math.min(left.get(o.id)!, e.amount - covered);
        takes.push([o, take]);
        covered += take;
      }
      if (covered < p.minOutRatio * e.amount) continue;
      passed.push(e);
      sent += covered;
      for (const [o, take] of takes) {
        left.set(o.id, left.get(o.id)! - take);
        used.set(o.id, o);
      }
    }
    if (!passed.length) continue;
    hits.push({
      nodeId,
      evidenceEdgeIds: ids([...passed, ...used.values()]),
      explanation: `${passed.length} inflow(s) of ${money(sum(passed))} passed on within ${num(p.deltaHours)} h (${money(sent)} out)`,
    });
  }
  return hits;
}

function fracionamento(g: TypologyGraph, p: TypologyParams): TypologyHit[] {
  const edges = moneyEdges(g);
  const byNode = new Map<string, { in: MoneyEdge[]; out: MoneyEdge[] }>();
  for (const e of edges) {
    for (const [node, side] of [[e.dst, 'in'], [e.src, 'out']] as const) {
      if (!byNode.has(node)) byNode.set(node, { in: [], out: [] });
      byNode.get(node)![side].push(e);
    }
  }
  const hits: TypologyHit[] = [];
  for (const nodeId of [...byNode.keys()].sort(cmp)) {
    const evidence: MoneyEdge[] = [];
    const parts: string[] = [];
    for (const [side, verb] of [['in', 'received'], ['out', 'sent']] as const) {
      const below = byNode.get(nodeId)![side].filter((e) => e.amount < p.limit);
      const w = firstWindow(below, p.windowDays * DAY_MS, (es) => es.length >= p.minCount && sum(es) >= p.limit);
      if (w) {
        evidence.push(...w);
        parts.push(`${verb} ${w.length} below ${num(p.limit)} summing ${money(sum(w))} within ${num(p.windowDays)} d`);
      }
      const near = below.filter((e) => e.amount >= p.nearRatio * p.limit);
      if (near.length) {
        evidence.push(...near);
        parts.push(`${verb} ${near.length} just below ${num(p.limit)}`);
      }
    }
    if (parts.length) hits.push({ nodeId, evidenceEdgeIds: ids(evidence), explanation: parts.join('; ') });
  }
  return hits;
}

function cicloTemporal(g: TypologyGraph, p: TypologyParams): TypologyHit[] {
  const out = new Map<string, TimedEdge[]>();
  for (const e of moneyEdges(g).filter(isTimed)) {
    if (!out.has(e.src)) out.set(e.src, []);
    out.get(e.src)!.push(e);
  }
  for (const list of out.values()) list.sort(byTime);
  let steps = 0;
  const hits: TypologyHit[] = [];
  const reported = new Set<string>();
  // A time-ordered cycle is found from its first edge; one hit per start node, each cycle once.
  for (const start of [...out.keys()].sort(cmp)) {
    const path: TimedEdge[] = [];
    const seen = new Set([start]);
    const walk = (node: string): TimedEdge[] | null => {
      for (const e of out.get(node) ?? []) {
        if (++steps > CYCLE_STEP_LIMIT) return null;
        if (path.length && e.t < path[path.length - 1].t) continue;
        if (e.dst === start) {
          const cycle = [...path, e];
          const key = ids(cycle).join('|');
          if (cycle.length >= p.minLength && e.amount >= p.minReturnRatio * cycle[0].amount && !reported.has(key)) {
            reported.add(key);
            return cycle;
          }
          continue;
        }
        if (seen.has(e.dst) || path.length + 1 >= p.maxLength) continue;
        seen.add(e.dst);
        path.push(e);
        const found = walk(e.dst);
        path.pop();
        seen.delete(e.dst);
        if (found) return found;
      }
      return null;
    };
    const cycle = walk(start);
    if (!cycle) continue;
    const back = cycle[cycle.length - 1].amount;
    hits.push({
      nodeId: start,
      evidenceEdgeIds: ids(cycle),
      explanation: `${cycle.length}-hop cycle in time order returned ${money(back)} of ${money(cycle[0].amount)}`,
    });
  }
  return hits;
}

function hubAtributo(g: TypologyGraph, p: TypologyParams): TypologyHit[] {
  const typeOf = new Map(g.nodes.map((n) => [n.id, n.type]));
  const linked = new Set<string>(); // "a|b" for every edge, both ways
  const links = new Map<string, Map<string, string>>(); // hub → neighbour → smallest link edge id
  for (const e of g.edges) {
    if (e.src === e.dst) continue;
    linked.add(`${e.src}|${e.dst}`).add(`${e.dst}|${e.src}`);
    if (e.amount !== null && e.amount > 0) continue; // money is a flow, not a shared element
    for (const [a, b] of [[e.src, e.dst], [e.dst, e.src]]) {
      if (!links.has(a)) links.set(a, new Map());
      const m = links.get(a)!;
      if (!m.has(b) || cmp(e.id, m.get(b)!) < 0) m.set(b, e.id);
    }
  }
  const hits: TypologyHit[] = [];
  for (const hub of [...links.keys()].sort(cmp)) {
    const byType = new Map<string, string[]>();
    for (const n of [...links.get(hub)!.keys()].sort(cmp)) {
      const type = typeOf.get(n) ?? '';
      if (type === (typeOf.get(hub) ?? '')) continue;
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type)!.push(n);
    }
    const groups = [...byType.entries()]
      .map(([type, ms]) => [type, ms.filter((m) => !ms.some((o) => o !== m && linked.has(`${m}|${o}`)))] as const)
      .filter(([, ms]) => ms.length >= p.minShared)
      .sort((a, b) => cmp(a[0], b[0]));
    if (!groups.length) continue;
    hits.push({
      nodeId: hub,
      evidenceEdgeIds: groups.flatMap(([, ms]) => ms.map((m) => links.get(hub)!.get(m)!)).sort(cmp),
      explanation: `shared by ${groups.map(([type, ms]) => `${ms.length} unrelated ${type}`).join(', ')}`,
    });
  }
  return hits;
}

function dormenteReativada(g: TypologyGraph, p: TypologyParams): TypologyHit[] {
  const byNode = new Map<string, TimedEdge[]>();
  for (const e of moneyEdges(g).filter(isTimed)) {
    for (const node of [e.src, e.dst]) {
      if (!byNode.has(node)) byNode.set(node, []);
      byNode.get(node)!.push(e);
    }
  }
  const hits: TypologyHit[] = [];
  for (const nodeId of [...byNode.keys()].sort(cmp)) {
    const es = byNode.get(nodeId)!.sort(byTime);
    for (let i = 1; i < es.length; i++) {
      const gap = es[i].t - es[i - 1].t;
      if (gap < p.dormantDays * DAY_MS) continue;
      const burst = es.filter((e) => e.t >= es[i].t && e.t <= es[i].t + p.windowDays * DAY_MS);
      if (sum(burst) < p.minVolume) continue;
      hits.push({
        nodeId,
        evidenceEdgeIds: ids(burst),
        explanation: `idle ${Math.floor(gap / DAY_MS)} d, then ${money(sum(burst))} within ${num(p.windowDays)} d`,
      });
      break;
    }
  }
  return hits;
}

/**
 * The registry. Left out (MVP): `pos_incompativel` (IV-v a IV-z) needs the acquirer's
 * POS location and merchant profile, which no context declares yet.
 */
export const TYPOLOGIES: Typology[] = [
  {
    id: 'passagem',
    label: 'Pass-through account: money in, ≥ 90% out within Δ',
    normRef: 'CC 4.001 IV-k, IV-ad',
    params: { deltaHours: 24, minOutRatio: 0.9 },
    detect: passagem,
  },
  {
    id: 'concentracao_entradas',
    label: 'Many unrelated origins pay in',
    normRef: 'CC 4.001 I-h, IV-n',
    params: { minDistinct: 10, windowDays: 7 },
    detect: distinctEnds('src', 'origins'),
  },
  {
    id: 'dispersao_saidas',
    label: 'Pays out to many destinations',
    normRef: 'CC 4.001 IV-o, IV-p',
    params: { minDistinct: 10, windowDays: 7 },
    detect: distinctEnds('dst', 'destinations'),
  },
  {
    id: 'fracionamento',
    label: 'Structuring: split below the limit',
    normRef: 'CC 4.001 I-d, I-e, I-k, I-m, IV-b',
    // shortcut: 7 calendar days stand in for 5 business days.
    params: { limit: 50000, minCount: 3, windowDays: 7, nearRatio: 0.9 },
    detect: fracionamento,
  },
  {
    id: 'ciclo_temporal',
    label: 'Money comes back in a time-ordered cycle',
    normRef: 'CC 4.001 (layering)',
    params: { minLength: 2, maxLength: 6, minReturnRatio: 0.5 },
    detect: cicloTemporal,
  },
  {
    id: 'hub_atributo',
    label: 'Unrelated parties share an element (device, IP, phone, address, account, partner)',
    normRef: 'CC 4.001 III-f, III-i, III-k, III-l',
    params: { minShared: 3 },
    detect: hubAtributo,
  },
  {
    id: 'dormente_reativada',
    label: 'Dormant account reactivated with volume',
    normRef: 'CC 4.001 IV-e, IV-f',
    params: { dormantDays: 180, minVolume: 10000, windowDays: 30 },
    detect: dormenteReativada,
  },
];

/** Runs every typology (or `only`) with the defaults overridden by `params[id]`. */
export function runTypologies(
  graph: TypologyGraph,
  params: Record<string, Partial<TypologyParams>> = {},
  only?: string[],
): TypologyResult[] {
  return TYPOLOGIES.filter((t) => !only || only.includes(t.id)).map((t) => {
    const merged = { ...t.params, ...(params[t.id] ?? {}) } as TypologyParams;
    return { id: t.id, label: t.label, normRef: t.normRef, params: merged, hits: t.detect(graph, merged) };
  });
}
