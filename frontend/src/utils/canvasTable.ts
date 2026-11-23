/**
 * Tables computed from the graph on the canvas (the `show-table` context-menu
 * action): the no-code neighborhood walk, the helpers a table program sees
 * (`hops`, `neighbors`, `edgesOf`, `node`), and the normalization of what a
 * program returns into `{ columns, rows }`.
 *
 * Pure (no stores, no Vue): the neighborhood runs on the main thread, the
 * program helpers inside the sandboxed worker, and both run in Node tests.
 * `api/graphlagoon/services/canvas_table.py` ports the neighborhood for agents;
 * the shared fixture in __tests__/fixtures/canvasTable.json keeps them equal.
 */
import type { CanvasTableParam, NeighborhoodTableSource } from '@/types/contextMenuActions';
import { MAX_NEIGHBORHOOD_HOPS } from '@/types/contextMenuActions';

export interface CanvasNode {
  node_id: string;
  node_type: string;
  properties?: Record<string, unknown>;
}

export interface CanvasEdge {
  edge_id: string;
  src: string;
  dst: string;
  relationship_type: string;
  properties?: Record<string, unknown>;
}

export interface CanvasGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** The clicked item, with the canvas's ids. */
export type CanvasItem =
  | { type: 'node'; node_id: string; node_type: string; properties?: Record<string, unknown> }
  | { type: 'edge'; edge_id: string; src: string; dst: string; relationship_type: string; properties?: Record<string, unknown> };

export interface CanvasTableResult {
  columns: string[];
  rows: (string | null)[][];
  truncated: boolean;
}

/** Same shape as the label renderer's metric resolver. */
export type MetricLookup = (target: 'node' | 'edge', id: string, ref: string) => unknown;

export const MAX_CANVAS_ROWS = 100_000;
export const MAX_CANVAS_COLUMNS = 200;
/** Columns picked when the action names none: every property found, up to this many. */
export const MAX_AUTO_COLUMNS = 50;

export type Direction = 'any' | 'out' | 'in';

export interface WalkOptions {
  direction?: Direction;
  edgeTypes?: string[];
}

export interface GraphIndex {
  nodes: Map<string, CanvasNode>;
  out: Map<string, CanvasEdge[]>;
  in: Map<string, CanvasEdge[]>;
}

export function indexGraph(graph: CanvasGraph): GraphIndex {
  const nodes = new Map<string, CanvasNode>();
  for (const n of graph.nodes) nodes.set(String(n.node_id), n);
  const out = new Map<string, CanvasEdge[]>();
  const inn = new Map<string, CanvasEdge[]>();
  const push = (m: Map<string, CanvasEdge[]>, k: string, e: CanvasEdge) => {
    const list = m.get(k);
    if (list) list.push(e);
    else m.set(k, [e]);
  };
  for (const e of graph.edges) {
    push(out, String(e.src), e);
    push(inn, String(e.dst), e);
  }
  return { nodes, out, in: inn };
}

function typeSet(types?: string[]): Set<string> | null {
  const kept = (types ?? []).filter(Boolean);
  return kept.length ? new Set(kept) : null;
}

/** The edges a walk may take from `id`, with the node at their other end. */
function steps(index: GraphIndex, id: string, opts: WalkOptions): Array<[CanvasEdge, string]> {
  const allowed = typeSet(opts.edgeTypes);
  const dir = opts.direction ?? 'any';
  const result: Array<[CanvasEdge, string]> = [];
  if (dir !== 'in') {
    for (const e of index.out.get(id) ?? []) if (!allowed || allowed.has(e.relationship_type)) result.push([e, String(e.dst)]);
  }
  if (dir !== 'out') {
    for (const e of index.in.get(id) ?? []) if (!allowed || allowed.has(e.relationship_type)) result.push([e, String(e.src)]);
  }
  return result;
}

/** Breadth-first walk: every node within `hops` steps of the seeds, with its distance (seeds at 0). */
export function walk(index: GraphIndex, seeds: string[], hops: number, opts: WalkOptions = {}): Map<string, number> {
  const dist = new Map<string, number>();
  let frontier: string[] = [];
  for (const s of seeds) {
    if (!dist.has(s)) {
      dist.set(s, 0);
      frontier.push(s);
    }
  }
  for (let depth = 1; depth <= hops && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const [, other] of steps(index, id, opts)) {
        if (!dist.has(other)) {
          dist.set(other, depth);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

function seedsOf(item: CanvasItem): string[] {
  return item.type === 'node' ? [String(item.node_id)] : [String(item.src), String(item.dst)];
}

/** One cell: text, or null for nothing. Objects and arrays as JSON. */
export function cell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clampHops(hops: unknown): number {
  const n = Math.trunc(Number(hops));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_NEIGHBORHOOD_HOPS);
}

/** The modal's editable inputs of a neighborhood table (the walk's depth and direction). */
export function neighborhoodParams(spec: NeighborhoodTableSource): CanvasTableParam[] {
  return [
    {
      id: 'hops',
      label: 'Hops',
      type: 'select',
      options: Array.from({ length: MAX_NEIGHBORHOOD_HOPS }, (_, i) => String(i + 1)),
      default: String(clampHops(spec.hops)),
      required: true,
    },
    { id: 'direction', label: 'Direction', type: 'select', options: ['any', 'out', 'in'], default: spec.direction ?? 'any', required: true },
  ];
}

/** The spec with the modal's values applied. */
export function withNeighborhoodValues(spec: NeighborhoodTableSource, values: Record<string, string>): NeighborhoodTableSource {
  const direction = values.direction;
  return {
    ...spec,
    hops: clampHops(values.hops ?? spec.hops),
    direction: direction === 'out' || direction === 'in' || direction === 'any' ? direction : spec.direction ?? 'any',
  };
}

function propertyColumns(items: Array<{ properties?: Record<string, unknown> }>): string[] {
  const seen = new Set<string>();
  for (const it of items) {
    for (const key of Object.keys(it.properties ?? {})) {
      if (seen.size >= MAX_AUTO_COLUMNS) return [...seen];
      seen.add(key);
    }
  }
  return [...seen];
}

function readColumn(
  target: 'node' | 'edge',
  column: string,
  id: string,
  properties: Record<string, unknown> | undefined,
  metric?: MetricLookup,
): string | null {
  if (column.startsWith('metric:')) return metric ? cell(metric(target, id, column.slice(7))) : null;
  return cell(properties?.[column]);
}

/**
 * The no-code canvas table: walk from the clicked item, then list the nodes
 * reached (`list: 'nodes'`, the clicked one left out) or the edges touching
 * the listed nodes (`list: 'edges'`, the clicked node counts).
 */
export function neighborhoodTable(
  graph: CanvasGraph,
  item: CanvasItem,
  spec: NeighborhoodTableSource,
  metric?: MetricLookup,
  rowLimit: number = MAX_CANVAS_ROWS,
): CanvasTableResult {
  const index = indexGraph(graph);
  const hops = clampHops(spec.hops);
  const dist = walk(index, seedsOf(item), hops, { direction: spec.direction, edgeTypes: spec.edgeTypes });
  const wantedTypes = typeSet(spec.nodeTypes);
  const listed = [...dist.entries()].filter(([id]) => {
    const node = index.nodes.get(id);
    return node && (!wantedTypes || wantedTypes.has(node.node_type));
  });

  if (spec.list === 'edges') {
    const allowed = typeSet(spec.listEdgeTypes);
    const hopOf = new Map(listed);
    const edges: Array<[CanvasEdge, number]> = [];
    const seen = new Set<string>();
    for (const [id] of listed) {
      for (const e of [...(index.out.get(id) ?? []), ...(index.in.get(id) ?? [])]) {
        if (seen.has(e.edge_id) || (allowed && !allowed.has(e.relationship_type))) continue;
        seen.add(e.edge_id);
        edges.push([e, Math.min(hopOf.get(String(e.src)) ?? Infinity, hopOf.get(String(e.dst)) ?? Infinity)]);
      }
    }
    edges.sort((a, b) => a[1] - b[1]);
    const props = spec.columns?.length ? spec.columns : propertyColumns(edges.map(([e]) => e));
    const columns = ['edge_id', 'relationship_type', 'src', 'dst', 'hop', ...props].slice(0, MAX_CANVAS_COLUMNS);
    const rows = edges.slice(0, rowLimit).map(([e, hop]) =>
      [e.edge_id, e.relationship_type, String(e.src), String(e.dst), String(hop), ...props.map((c) => readColumn('edge', c, e.edge_id, e.properties, metric))].slice(0, MAX_CANVAS_COLUMNS),
    );
    return { columns, rows, truncated: edges.length > rowLimit };
  }

  // Nodes: the clicked node is the question, not an answer.
  const seeds = new Set(item.type === 'node' ? seedsOf(item) : []);
  const nodes = listed
    .filter(([id]) => !seeds.has(id))
    .sort((a, b) => a[1] - b[1])
    .map(([id, hop]) => [index.nodes.get(id)!, hop] as const);
  const props = spec.columns?.length ? spec.columns : propertyColumns(nodes.map(([n]) => n));
  const columns = ['node_id', 'node_type', 'hop', ...props].slice(0, MAX_CANVAS_COLUMNS);
  const rows = nodes.slice(0, rowLimit).map(([n, hop]) =>
    [String(n.node_id), n.node_type, String(hop), ...props.map((c) => readColumn('node', c, String(n.node_id), n.properties, metric))].slice(0, MAX_CANVAS_COLUMNS),
  );
  return { columns, rows, truncated: nodes.length > rowLimit };
}

/** Whether a program can reach `metric(...)` (decides if metric values are shipped to the worker). */
export function programUsesMetric(code: string): boolean {
  return /\bmetric\b/.test(code);
}

export interface ProgramHelpers {
  node: (id: string) => CanvasNode | undefined;
  /** Nodes within `k` steps of `id` (itself left out), nearest first, each with its `hop`. */
  hops: (id: string, k: number, opts?: WalkOptions & { nodeTypes?: string[] }) => Array<CanvasNode & { hop: number }>;
  /** hops(id, 1, opts). */
  neighbors: (id: string, opts?: WalkOptions & { nodeTypes?: string[] }) => Array<CanvasNode & { hop: number }>;
  /** Edges touching any of `ids` (once each). `types` limits the relationship types, `direction` is relative to `ids`. */
  edgesOf: (ids: string | string[], opts?: { types?: string[]; direction?: Direction }) => CanvasEdge[];
}

/** The graph helpers a table program sees (indexes built once per run). */
export function programHelpers(graph: CanvasGraph): ProgramHelpers {
  const index = indexGraph(graph);
  const hops: ProgramHelpers['hops'] = (id, k, opts = {}) => {
    const start = String(id);
    const wanted = typeSet(opts.nodeTypes);
    const dist = walk(index, [start], clampHops(k), opts);
    const out: Array<CanvasNode & { hop: number }> = [];
    for (const [nid, hop] of dist) {
      if (nid === start) continue;
      const node = index.nodes.get(nid);
      if (node && (!wanted || wanted.has(node.node_type))) out.push({ ...node, hop });
    }
    return out.sort((a, b) => a.hop - b.hop);
  };
  return {
    node: (id) => index.nodes.get(String(id)),
    hops,
    neighbors: (id, opts) => hops(id, 1, opts),
    edgesOf: (ids, opts = {}) => {
      const allowed = typeSet(opts.types);
      const dir = opts.direction ?? 'any';
      const seen = new Set<string>();
      const result: CanvasEdge[] = [];
      for (const raw of Array.isArray(ids) ? ids : [ids]) {
        const id = String(raw);
        const lists = [dir !== 'in' ? index.out.get(id) : undefined, dir !== 'out' ? index.in.get(id) : undefined];
        for (const list of lists) {
          for (const e of list ?? []) {
            if (seen.has(e.edge_id) || (allowed && !allowed.has(e.relationship_type))) continue;
            seen.add(e.edge_id);
            result.push(e);
          }
        }
      }
      return result;
    },
  };
}

/**
 * What a program returned, as a table: an array of objects (columns in first
 * seen order), an array of plain values (one `value` column), or
 * `{ columns, rows }`. Anything else throws with a message for the modal.
 */
export function toTable(result: unknown, rowLimit: number = MAX_CANVAS_ROWS): CanvasTableResult {
  const limit = Math.max(1, Math.min(rowLimit, MAX_CANVAS_ROWS));
  if (result && typeof result === 'object' && !Array.isArray(result) && 'columns' in result && 'rows' in result) {
    const { columns, rows } = result as { columns: unknown; rows: unknown };
    if (!Array.isArray(columns) || !Array.isArray(rows)) throw new Error('`columns` and `rows` must be arrays');
    const cols = columns.slice(0, MAX_CANVAS_COLUMNS).map((c) => String(c));
    const out = rows.slice(0, limit).map((r, i) => {
      if (!Array.isArray(r)) throw new Error(`Row ${i + 1} is not an array`);
      return cols.map((_, j) => cell(r[j]));
    });
    return { columns: cols, rows: out, truncated: rows.length > limit };
  }
  if (!Array.isArray(result)) {
    throw new Error(`The program must return an array of objects or { columns, rows }; it returned ${result === null ? 'null' : typeof result}`);
  }
  const taken = result.slice(0, limit);
  if (taken.every((r) => r === null || typeof r !== 'object' || Array.isArray(r))) {
    return { columns: ['value'], rows: taken.map((v) => [cell(v)]), truncated: result.length > limit };
  }
  const columns: string[] = [];
  const known = new Set<string>();
  for (const r of taken) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    for (const k of Object.keys(r)) {
      if (!known.has(k) && columns.length < MAX_CANVAS_COLUMNS) {
        known.add(k);
        columns.push(k);
      }
    }
  }
  const rows = taken.map((r) =>
    r && typeof r === 'object' && !Array.isArray(r)
      ? columns.map((c) => cell((r as Record<string, unknown>)[c]))
      : columns.map((_, j) => (j === 0 ? cell(r) : null)),
  );
  return { columns, rows, truncated: result.length > limit };
}
