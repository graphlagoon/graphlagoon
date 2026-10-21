/**
 * What the trace screen (T5, F3.4/F3.5) draws from a `TraceResult`: the traced
 * flows, a column per layer (canvas `trace-layers` layout and Sankey), the Sankey
 * geometry and the method stamp. Pure; edges are the ones the trace walked
 * (`orientEdges`), so a backward trace reads right to left in time.
 */
import type { TraceEdge, TraceResult } from './trace';
import { formatAmount } from './edgeSemantics';

export interface TraceFlow {
  id: string;
  src: string;
  dst: string;
  /** Traced part of the edge. */
  value: number;
  /** Real time (epoch ms), also for a backward trace. */
  t: number;
}

export interface TraceColumns {
  /** Node id → column; insertion order is the order inside a column. */
  columns: Map<string, number>;
  labels: string[];
  /** The last column holds the exits (origins, backward). */
  exits: boolean;
}

/**
 * Edges that carried traced value to a node the trace reached (frontier and
 * below-minimum edges are left out), sorted by time.
 */
export function traceFlows(result: TraceResult, edges: TraceEdge[]): TraceFlow[] {
  const flows: TraceFlow[] = [];
  for (const e of edges) {
    const value = result.edgeTrace[e.id];
    if (!value || !(e.dst in result.nodes)) continue;
    flows.push({ id: e.id, src: e.src, dst: e.dst, value, t: Math.abs(e.t) });
  }
  return flows.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
}

/** Seed sources in column 0, each reached node at its layer, the exits in a last column. */
export function traceColumns(result: TraceResult, flows: TraceFlow[], direction: 'forward' | 'backward'): TraceColumns {
  const seeds = new Set(result.method.seedEdgeIds);
  const exits = new Set(Object.keys(result.exits));
  const columns = new Map<string, number>();
  /** Exit → the first node that paid it, to line exits up with their payers. */
  const exitFrom = new Map<string, string>();
  for (const f of flows) {
    if (!columns.has(f.src) && !exits.has(f.src)) columns.set(f.src, seeds.has(f.id) ? 0 : (result.nodes[f.src]?.layer ?? 0));
    if (exits.has(f.dst)) {
      if (!exitFrom.has(f.dst)) exitFrom.set(f.dst, f.src);
    } else if (!columns.has(f.dst)) columns.set(f.dst, result.nodes[f.dst].layer);
  }
  const last = Math.max(0, ...columns.values());
  const sorted = new Map([...columns].sort((a, b) => a[1] - b[1]));
  const rank = new Map([...sorted.keys()].map((id, i) => [id, i]));
  const exitIds = [...exitFrom.keys()].sort((a, b) => rank.get(exitFrom.get(a)!)! - rank.get(exitFrom.get(b)!)!);
  for (const id of exitIds) sorted.set(id, last + 1);
  const labels = ['Seed', ...Array.from({ length: last }, (_, i) => `Layer ${i + 1}`)];
  if (exitIds.length) labels.push(direction === 'backward' ? 'Origins' : 'Exits');
  return { columns: sorted, labels, exits: exitIds.length > 0 };
}

export interface SankeyNode {
  id: string;
  col: number;
  x: number;
  y: number;
  h: number;
  value: number;
}

export interface SankeyLink {
  src: string;
  dst: string;
  value: number;
  edgeIds: string[];
  path: string;
}

/** Hand-rolled Sankey: node height = max(in, out), bands stacked in node order. */
export function sankeyLayout(
  flows: TraceFlow[],
  { columns, labels }: TraceColumns,
  { width = 900, height = 320, nodeWidth = 14, gap = 16, pad = 24 } = {},
): { nodes: SankeyNode[]; links: SankeyLink[] } {
  const pairs = new Map<string, { src: string; dst: string; value: number; edgeIds: string[] }>();
  const inSum = new Map<string, number>();
  const outSum = new Map<string, number>();
  for (const f of flows) {
    const key = `${f.src}\u0000${f.dst}`;
    const p = pairs.get(key) ?? pairs.set(key, { src: f.src, dst: f.dst, value: 0, edgeIds: [] }).get(key)!;
    p.value += f.value;
    p.edgeIds.push(f.id);
    outSum.set(f.src, (outSum.get(f.src) ?? 0) + f.value);
    inSum.set(f.dst, (inSum.get(f.dst) ?? 0) + f.value);
  }
  const byCol: string[][] = labels.map(() => []);
  for (const [id, col] of columns) byCol[col]?.push(id);
  const value = (id: string) => Math.max(inSum.get(id) ?? 0, outSum.get(id) ?? 0);

  const usable = height - 2 * pad;
  let k = Infinity;
  for (const ids of byCol) {
    const total = ids.reduce((s, id) => s + value(id), 0);
    if (total > 0) k = Math.min(k, (usable - gap * (ids.length - 1)) / total);
  }
  if (!Number.isFinite(k)) k = 0;

  const step = labels.length > 1 ? (width - 2 * pad - nodeWidth) / (labels.length - 1) : 0;
  const nodes = new Map<string, SankeyNode>();
  byCol.forEach((ids, col) => {
    const colHeight = ids.reduce((s, id) => s + value(id) * k, 0) + gap * Math.max(0, ids.length - 1);
    let y = pad + (usable - colHeight) / 2;
    for (const id of ids) {
      const h = value(id) * k;
      nodes.set(id, { id, col, x: pad + col * step, y, h, value: value(id) });
      y += h + gap;
    }
  });

  const outOffset = new Map<string, number>();
  const inOffset = new Map<string, number>();
  const ordered = [...pairs.values()]
    .filter(p => nodes.has(p.src) && nodes.has(p.dst))
    .sort((a, b) => nodes.get(a.dst)!.y - nodes.get(b.dst)!.y || nodes.get(a.src)!.y - nodes.get(b.src)!.y);
  const links = ordered.map(p => {
    const s = nodes.get(p.src)!;
    const d = nodes.get(p.dst)!;
    const w = p.value * k;
    const y0 = s.y + (outOffset.get(p.src) ?? 0);
    const y1 = d.y + (inOffset.get(p.dst) ?? 0);
    outOffset.set(p.src, (outOffset.get(p.src) ?? 0) + w);
    inOffset.set(p.dst, (inOffset.get(p.dst) ?? 0) + w);
    const x0 = s.x + nodeWidth;
    const x1 = d.x;
    const xm = (x0 + x1) / 2;
    const r = (n: number) => Math.round(n * 10) / 10;
    const path = `M ${r(x0)} ${r(y0)} C ${r(xm)} ${r(y0)}, ${r(xm)} ${r(y1)}, ${r(x1)} ${r(y1)} `
      + `L ${r(x1)} ${r(y1 + w)} C ${r(xm)} ${r(y1 + w)}, ${r(xm)} ${r(y0 + w)}, ${r(x0)} ${r(y0 + w)} Z`;
    return { ...p, path };
  });
  return { nodes: [...nodes.values()], links };
}

const ALLOCATION_LABELS: Record<string, string> = {
  fifo: 'FIFO',
  lifo: 'LIFO',
  proportional: 'proportional',
  libr: 'LIBR',
  total: 'total contamination',
};

export function formatTraceTime(t: number): string {
  return new Date(t).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** One line with every parameter of the run (the method stamp of T5 and of the evidence). */
export function methodStamp(method: TraceResult['method'], currency?: string | null): string {
  const parts = [
    `method: ${method.direction}`,
    `${method.maxHops} layers`,
    `Δ ${method.maxDwellMs === null ? 'no limit' : `${+(method.maxDwellMs / 3_600_000).toFixed(2)} h`}`,
    `min ${formatAmount(method.minAmount, currency)}`,
    ALLOCATION_LABELS[method.allocation] ?? method.allocation,
    `stop: ${[...method.stopTypes, ...method.stopNodes].join(', ') || 'none'}`,
    `window ${method.window ? `${formatTraceTime(method.window[0])} → ${formatTraceTime(method.window[1])}` : 'none'}`,
    `seed: ${method.seedEdgeIds.join(', ')}`,
  ];
  return parts.join(' · ');
}
