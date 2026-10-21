/**
 * Enrichment tables in the investigation workspace (F2.2, 03 §2.1). Pure: which of a
 * context's side tables apply to a node, the lookup key, and "promote to nodes".
 */
import type { EnrichmentTable, GraphContext } from '@/types/graph';
import type { FileEnrichmentSpec } from '@/types/investigation';
import { columnsOf, lines, parseLine } from '@/utils/fileMapping';
import { normalizeIdentityValue } from '@/utils/identityKeys';
import { baseSourceId, mergeProps, type UnifiedEdge, type UnifiedGraph, type UnifiedNode, type UnifySource } from '@/utils/unifyGraph';

/** One table that applies to nodes of a source's context. */
export interface EnrichmentTarget {
  sourceId: string;
  contextId: string;
  table: EnrichmentTable;
}

type Row = Record<string, string | null>;

const targetId = (t: EnrichmentTarget) => `${t.contextId}:${t.table.name}`;

/** The lookup key of `node` for `target`, or null when the node does not match it. */
export function enrichmentKey(node: UnifiedNode, target: EnrichmentTarget): string | null {
  if (!target.table.match_node_types.includes(node.node_type)) return null;
  const origin = node.__sources.find((o) => o.contextId === target.contextId);
  if (!origin) return null;
  const src = target.table.match_source;
  const raw = src === 'node_id' ? origin.nodeId : node.properties?.[src.name];
  return raw === null || raw === undefined || raw === '' ? null : String(raw);
}

/** Tables of the node's contexts that apply to its type, one per context and name. */
export function enrichmentTargets(
  node: UnifiedNode,
  contexts: Record<string, Pick<GraphContext, 'enrichment_tables'> | undefined>,
): EnrichmentTarget[] {
  const seen = new Map<string, EnrichmentTarget>();
  for (const o of node.__sources) {
    for (const table of contexts[o.contextId]?.enrichment_tables ?? []) {
      const target = { sourceId: baseSourceId(o.sourceId), contextId: o.contextId, table };
      if (!seen.has(targetId(target)) && enrichmentKey(node, target) !== null) seen.set(targetId(target), target);
    }
  }
  return [...seen.values()];
}

/** Every node of the graph the target applies to, with its key. */
export function keyedNodes(nodes: UnifiedNode[], target: EnrichmentTarget): { node: UnifiedNode; key: string }[] {
  const out: { node: UnifiedNode; key: string }[] = [];
  for (const node of nodes) {
    const key = enrichmentKey(node, target);
    if (key !== null) out.push({ node, key });
  }
  return out;
}

/**
 * "Promote to nodes": each distinct `promote.id_column` value becomes a node of
 * `promote.node_type`, linked from every node whose rows hold it. Returned as a
 * derived source (`derived:<sourceId>:<table>`) so it unifies like any source;
 * nodes and edges carry `__derived` in their properties.
 */
export function promoteToNodes(
  target: EnrichmentTarget,
  keyed: { node: UnifiedNode; key: string }[],
  rows: Record<string, Row[]>,
): UnifySource {
  const promote = target.table.promote!;
  const derived = `enrichment:${target.table.name}`;
  const source: UnifySource = { id: `derived:${target.sourceId}:${target.table.name}`, contextId: target.contextId, nodes: [], edges: [] };
  const promoted = new Set<string>();
  for (const { node, key } of keyed) {
    const values = new Set((rows[key] ?? []).map((r) => r[promote.id_column]).filter((v): v is string => !!v));
    if (!values.size) continue;
    const origin = node.__sources.find((o) => o.contextId === target.contextId)!;
    // The node itself, under its id in the context, so the edge unifies onto it.
    source.nodes.push({ node_id: origin.nodeId, node_type: node.node_type, properties: node.properties });
    for (const value of values) {
      const id = `${promote.node_type}:${value}`;
      if (!promoted.has(id)) {
        promoted.add(id);
        source.nodes.push({ node_id: id, node_type: promote.node_type, properties: { [promote.id_column]: value, __derived: derived } });
      }
      source.edges.push({
        edge_id: `${origin.nodeId}->${id}`,
        src: origin.nodeId,
        dst: id,
        relationship_type: promote.edge_type,
        properties: { __derived: derived },
      });
    }
  }
  return source;
}

// ---------------------------------------------------------------------------
// Enrichment files (BYOD-2): rows add properties to the nodes or edges already on
// the canvas, by key. Twin of api/graphlagoon/services/enrichment_files.py.
// ---------------------------------------------------------------------------

const WILDCARD = '*';
/** A cell that reads as a plain number becomes one; leading zeros keep it a string ("00123"). */
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export type FileRow = Record<string, unknown>;
export type FileRows = Record<string, FileRow[]>;
/** A table as stored: delimited text, or the JSON of a query result / promoted run. */
export type TableContent = string | { columns?: unknown[]; rows?: unknown[] };

/** A table cell as a property value: empty is missing, a plain number is a number. */
export function enrichmentCell(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  const text = value.trim();
  if (text === '') return null;
  return NUMBER.test(text) ? Number(text) : text;
}

/** A key (a row's or a node's) under the spec: normalized, then cut to the first `key_digits` digits. */
export function enrichmentKeyOf(value: unknown, spec: FileEnrichmentSpec): string | null {
  const key = normalizeIdentityValue(value, spec.normalize ?? 'none');
  if (key === null) return null;
  return spec.key_digits ? key.replace(/\D/g, '').slice(0, spec.key_digits) || null : key;
}

const byEndpoints = (spec: FileEnrichmentSpec) => spec.target === 'edges' && spec.edge_key?.by === 'endpoints';
const pair = (src: string, dst: string, type: string | null) => `${src}>${dst}${type !== null ? `>${type}` : ''}`;

/** `[columns, rows]` of an enrichment file: JSON tables as they are, text by `spec.input`. */
export function enrichmentTable(content: TableContent, spec: FileEnrichmentSpec): [string[], unknown[][]] {
  if (typeof content !== 'string') {
    const raw = content.rows ?? [];
    let columns = (content.columns ?? []).map(String);
    if (raw.length && !Array.isArray(raw[0])) {
      const dicts = raw as Record<string, unknown>[];
      if (!columns.length) columns = [...new Set(dicts.flatMap((r) => Object.keys(r)))].sort();
      return [columns, dicts.map((r) => columns.map((c) => r[c]))];
    }
    return [columns, raw as unknown[][]];
  }
  const delimiter = spec.input.delimiter || ',';
  const [columns, body] = columnsOf(
    { match: '*', delimiter, header: spec.input.header, columns: spec.input.columns, encoding: spec.input.encoding ?? undefined },
    lines(content),
  );
  return [columns, body.map((line) => parseLine(line, delimiter))];
}

/** Parses stored text: JSON tables are objects with `columns`/`rows`, anything else is delimited text. */
export function tableContentOf(text: string, contentType?: string | null): TableContent {
  if (contentType?.startsWith('application/json') || /^\s*\{/.test(text)) {
    try {
      return JSON.parse(text) as TableContent;
    } catch {
      /* not JSON after all: delimited text */
    }
  }
  return text;
}

/** The file's rows by key, each with only `spec.columns` (values through `enrichmentCell`). */
export function fileEnrichmentRows(content: TableContent, spec: FileEnrichmentSpec): FileRows {
  const [columns, rows] = enrichmentTable(content, spec);
  const at = new Map(columns.map((c, i) => [c, i]));
  const get = (row: unknown[], col?: string | null) => (col && at.has(col) ? row[at.get(col)!] : null);
  const out: FileRows = {};
  for (const row of rows) {
    let key: string | null;
    if (byEndpoints(spec)) {
      const k = spec.edge_key!;
      const src = enrichmentKeyOf(get(row, k.source_column), spec);
      const dst = enrichmentKeyOf(get(row, k.target_column), spec);
      if (src === null || dst === null) continue;
      key = pair(src, dst, k.type_column ? String(get(row, k.type_column) ?? '').trim() : null);
    } else {
      key = enrichmentKeyOf(get(row, spec.key_column), spec);
      if (key === null) continue;
    }
    (out[key] ??= []).push(Object.fromEntries(spec.columns.map((c) => [c, enrichmentCell(get(row, c))])));
  }
  return out;
}

export function typesMatch(types: string[] | undefined, value: string): boolean {
  return !types?.length || types.includes(WILDCARD) || types.includes(value);
}

/**
 * A node's candidate keys: its id (each original id, when merged) or the `match_source`
 * property; matching by id also tries the entity value of a node merged by identity key
 * (`Person:12345678901` → `12345678901`).
 */
function nodeKeys(spec: FileEnrichmentSpec, ids: string[], props: Record<string, unknown> | undefined, entityValue: string | null): string[] {
  const src = spec.match_source;
  const raws: unknown[] = src === 'node_id' || !src ? [...ids, entityValue] : [props?.[src.name]];
  return [...new Set(raws.map((r) => enrichmentKeyOf(r, spec)).filter((k): k is string => k !== null))];
}

function edgeKeys(spec: FileEnrichmentSpec, edgeId: string, type: string, srcKeys: string[], dstKeys: string[]): string[] {
  if (!byEndpoints(spec)) {
    const k = enrichmentKeyOf(edgeId, spec);
    return k === null ? [] : [k];
  }
  const t = spec.edge_key?.type_column ? type : null;
  const out: string[] = [];
  for (const s of srcKeys) for (const d of dstKeys) out.push(pair(s, d, t));
  for (const s of srcKeys) for (const d of dstKeys) out.push(pair(d, s, t)); // either direction
  return out;
}

function firstRows(rows: FileRows, keys: string[]): FileRow[] {
  for (const k of keys) if (rows[k]?.length) return rows[k];
  return [];
}

const entityValue = (n: UnifiedNode) => (n.__entity && n.node_id.startsWith(`${n.__entity}:`) ? n.node_id.slice(n.__entity.length + 1) : null);
const unifiedNodeKeys = (n: UnifiedNode, spec: FileEnrichmentSpec) =>
  nodeKeys(spec, n.__sources.map((o) => o.nodeId), n.properties, entityValue(n));

/** Every row of the file for this node (the inspector's table); empty when the file is about edges or another type. */
export function fileRowsOfNode(node: UnifiedNode, spec: FileEnrichmentSpec, rows: FileRows): FileRow[] {
  if ((spec.target ?? 'nodes') !== 'nodes' || !typesMatch(spec.match_node_types, node.node_type)) return [];
  return firstRows(rows, unifiedNodeKeys(node, spec));
}

/** Whether the file can apply to this node at all (its type, and a key it can read). */
export function fileEnrichmentKey(node: UnifiedNode, spec: FileEnrichmentSpec): string | null {
  if ((spec.target ?? 'nodes') !== 'nodes' || !typesMatch(spec.match_node_types, node.node_type)) return null;
  return unifiedNodeKeys(node, spec)[0] ?? null;
}

/**
 * Applies one file to a unified graph in place (after `applyAliases`): matching nodes or edges
 * get the first row's values through `mergeProps`. Properties are copied before writing, so a
 * source graph shared with other computeds is never touched. Returns how many matched.
 */
export function applyFileEnrichment(graph: UnifiedGraph, spec: FileEnrichmentSpec, rows: FileRows, sourceId: string): number {
  const overwrite = !!spec.overwrite;
  let matched = 0;
  const write = (target: UnifiedNode | UnifiedEdge, row: FileRow) => {
    target.properties = { ...(target.properties ?? {}) };
    if (target.__conflicts) target.__conflicts = Object.fromEntries(Object.entries(target.__conflicts).map(([k, v]) => [k, [...v]]));
    mergeProps(target, row, sourceId, overwrite);
    matched++;
  };
  if ((spec.target ?? 'nodes') === 'nodes') {
    for (const n of graph.nodes) {
      const [row] = fileRowsOfNode(n, spec, rows);
      if (row) write(n, row);
    }
    return matched;
  }
  const keysById = new Map(graph.nodes.map((n) => [n.node_id, unifiedNodeKeys(n, spec)]));
  for (const e of graph.edges) {
    if (!typesMatch(spec.match_edge_types, e.relationship_type)) continue;
    const prefix = `${e.__source}:`;
    const original = e.edge_id.startsWith(prefix) ? e.edge_id.slice(prefix.length) : e.edge_id;
    const [row] = firstRows(rows, edgeKeys(spec, original, e.relationship_type, keysById.get(e.src) ?? [], keysById.get(e.dst) ?? []));
    if (row) write(e, row);
  }
  return matched;
}

/** Plain nodes and edges (an exploration's graph): the same match, by `node_id` and `src`/`dst`. */
export interface PlainGraph {
  nodes: { node_id: string; node_type: string; properties?: Record<string, unknown> }[];
  edges: { edge_id: string; src: string; dst: string; relationship_type: string; properties?: Record<string, unknown> }[];
}

/**
 * What one file would set on a plain graph, without touching it: per node (or edge) id the
 * row to merge. The exploration overlay applies it; the "Your data" preview counts it.
 */
export function matchFileRows(graph: PlainGraph, spec: FileEnrichmentSpec, rows: FileRows): Map<string, FileRow> {
  const out = new Map<string, FileRow>();
  if ((spec.target ?? 'nodes') === 'nodes') {
    for (const n of graph.nodes) {
      if (!typesMatch(spec.match_node_types, n.node_type)) continue;
      const [row] = firstRows(rows, nodeKeys(spec, [n.node_id], n.properties, null));
      if (row) out.set(n.node_id, row);
    }
    return out;
  }
  const keysById = new Map(graph.nodes.map((n) => [n.node_id, nodeKeys(spec, [n.node_id], n.properties, null)]));
  for (const e of graph.edges) {
    if (!typesMatch(spec.match_edge_types, e.relationship_type)) continue;
    const [row] = firstRows(rows, edgeKeys(spec, e.edge_id, e.relationship_type, keysById.get(e.src) ?? [], keysById.get(e.dst) ?? []));
    if (row) out.set(e.edge_id, row);
  }
  return out;
}
