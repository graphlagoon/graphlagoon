/**
 * Auto-match for "Your data → Enrich" (an exploration's layer): reads pasted or dropped
 * rows, then finds how they join the canvas without the user touching a control: which
 * column, against the node id or which node property, under which normalizer, and whether
 * two columns are the endpoints of the canvas's edges. Pure; the counts the modal shows
 * come from `matchFileRows`, the same function that applies the file.
 */
import { lines, parseLine } from './fileMapping';
import { fileEnrichmentRows, matchFileRows, type PlainGraph } from './enrichment';
import { KEY_NORMALIZERS, NORMALIZER_LABELS, normalizeIdentityValue } from './identityKeys';
import type { FileEnrichmentSpec } from '@/types/investigation';
import type { IdentityNormalize } from '@/types/graph';

export interface ReadTable {
  /** The text from the header line on (title lines above it dropped). */
  text: string;
  delimiter: string;
  header: string[];
  rows: string[][];
  /** Lines above the header that were dropped (a report title, a blank export line). */
  skipped: number;
}

const DELIMITERS = [';', '\t', ','];
const SAMPLE = 300;
const MAX_PROPS = 40;
/** `none` and `lower` first: the simplest normalizer that matches wins a tie. */
const NORMALIZERS: IdentityNormalize[] = ['none', 'lower', ...KEY_NORMALIZERS];

/**
 * A key under a normalizer, for guessing only: a normalizer that leaves fewer than 4
 * characters (`p1` → `1` as digits) meets anything, so it does not count as a match.
 */
function keyOf(value: unknown, n: IdentityNormalize): string | null {
  const k = normalizeIdentityValue(value, n);
  return k !== null && (n === 'none' || n === 'lower' || k.length >= 4) ? k : null;
}

/** Most common field count of `ws`, the larger one on a tie. */
function modeWidth(ws: number[]): [number, number] {
  const freq = new Map<number, number>();
  for (const w of ws) freq.set(w, (freq.get(w) ?? 0) + 1);
  let best: [number, number] = [1, 0];
  for (const [w, f] of freq) if (f > best[1] || (f === best[1] && w > best[0])) best = [w, f];
  return best;
}

/**
 * Delimited text as a table. The delimiter is the one that splits the first lines into
 * the same number of fields most often (a title line above the header does not fool it);
 * lines above the first one that has that many fields are dropped.
 */
export function readTable(raw: string): ReadTable {
  const all = lines(raw.replace(/^﻿/, '')).filter((l) => l.trim() !== '');
  const head = all.slice(0, 30);
  let delimiter = ',';
  let width = 1;
  let score = -1;
  for (const d of DELIMITERS) {
    const [w, f] = modeWidth(head.map((l) => parseLine(l, d).length));
    const s = w > 1 ? f : 0;
    if (s > score || (s === score && w > width)) [delimiter, width, score] = [d, w, s];
  }
  const start = Math.max(0, Math.min(10, all.findIndex((l) => parseLine(l, delimiter).length >= width)));
  const body = all.slice(start);
  const header = (body[0] !== undefined ? parseLine(body[0], delimiter) : []).map((c) => c.trim());
  return {
    text: body.join('\n'),
    delimiter,
    header,
    rows: body.slice(1).map((l) => parseLine(l, delimiter)),
    skipped: start,
  };
}

export interface MatchSuggestion {
  spec: FileEnrichmentSpec;
  /** Nodes (or edges) of the canvas a row reaches. */
  matched: number;
  /** Nodes (or edges) the spec could reach: of its types, or all. */
  total: number;
  /** Matched nodes per type (empty for edges). */
  byType: Record<string, number>;
}

type Source = 'node_id' | string;
const NODE_ID: Source = 'node_id';

function baseSpec(name: string, table: ReadTable, keyColumns: string[]): FileEnrichmentSpec {
  return {
    name,
    input: { delimiter: table.delimiter, header: true },
    target: 'nodes',
    key_column: keyColumns[0] ?? table.header[0] ?? null,
    columns: table.header.filter((c) => c && !keyColumns.includes(c)).slice(0, 30),
    match_node_types: [],
    match_source: 'node_id',
    normalize: 'none',
    overwrite: false,
  };
}

/** The spec the modal starts from when nothing matches: the first column as the key. */
export function fallbackSpec(name: string, table: ReadTable): FileEnrichmentSpec {
  return baseSpec(name, table, table.header.slice(0, 1));
}

/** Node property names whose values can be a key (text or number), the most common first. */
function keyProperties(graph: PlainGraph): string[] {
  const freq = new Map<string, number>();
  for (const n of graph.nodes) {
    for (const [k, v] of Object.entries(n.properties ?? {})) {
      if (typeof v === 'string' || typeof v === 'number') freq.set(k, (freq.get(k) ?? 0) + 1);
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_PROPS).map(([k]) => k);
}

interface Candidate {
  column: string;
  source: Source;
  normalize: IdentityNormalize;
  /** Distinct sample keys that met a node: an id-like join beats a shared category. */
  hits: number;
  rank: number;
}

/**
 * The ways the rows join the canvas, best first, each as a complete spec with its exact
 * count (at most `limit`). Empty when nothing matches.
 */
export function suggestEnrichmentMatches(graph: PlainGraph, table: ReadTable, name: string, limit = 4): MatchSuggestion[] {
  if (!table.header.length || !table.rows.length || !graph.nodes.length) return [];
  const sample = table.rows.slice(0, SAMPLE);
  const sources: Source[] = [NODE_ID, ...keyProperties(graph)];

  // Node keys per (source, normalizer), built once each.
  const nodeKeyCache = new Map<string, Set<string>>();
  const nodeKeys = (source: Source, n: IdentityNormalize): Set<string> => {
    const id = `${source}\u0000${n}`;
    let set = nodeKeyCache.get(id);
    if (!set) {
      set = new Set();
      for (const node of graph.nodes) {
        const k = keyOf(source === NODE_ID ? node.node_id : node.properties?.[source], n);
        if (k !== null) set.add(k);
      }
      nodeKeyCache.set(id, set);
    }
    return set;
  };

  const candidates: Candidate[] = [];
  let rank = 0;
  table.header.forEach((column, i) => {
    if (!column) return;
    for (const normalize of NORMALIZERS) {
      const keys = new Set<string>();
      for (const row of sample) {
        const k = keyOf(row[i], normalize);
        if (k !== null) keys.add(k);
      }
      if (!keys.size) continue;
      for (const source of sources) {
        const pool = nodeKeys(source, normalize);
        let hits = 0;
        for (const k of keys) if (pool.has(k)) hits++;
        if (hits) candidates.push({ column, source, normalize, hits, rank: rank++ });
      }
    }
  });

  // One candidate per (column, source): the simplest normalizer with the most hits.
  const best = new Map<string, Candidate>();
  for (const c of candidates) {
    const id = `${c.column}\u0000${c.source}`;
    const cur = best.get(id);
    if (!cur || c.hits > cur.hits) best.set(id, c);
  }
  const ranked = [...best.values()].sort((a, b) => b.hits - a.hits || a.rank - b.rank);

  const out: MatchSuggestion[] = [];
  const edge = edgeSuggestion(graph, table, name, ranked, sample);
  if (edge) out.push(edge);
  for (const c of ranked) {
    if (out.length >= limit) break;
    const spec = baseSpec(name, table, [c.column]);
    spec.normalize = c.normalize;
    spec.match_source = c.source === NODE_ID ? 'node_id' : { kind: 'prop', name: c.source };
    const s = measure(graph, table, spec);
    if (!s.matched) continue;
    const types = Object.entries(s.byType).sort((a, b) => b[1] - a[1]);
    const distinctTypes = new Set(graph.nodes.map((n) => n.node_type)).size;
    // A file about one type is kept to that type, so a later expand does not spread it.
    if (distinctTypes > 1 && types.length && types[0][1] >= 0.95 * s.matched) {
      spec.match_node_types = [types[0][0]];
      out.push(measure(graph, table, spec));
    } else {
      out.push(s);
    }
  }
  return out.slice(0, limit);
}

/** Two columns that are the endpoints of the canvas's edges (a channel per transfer). */
function edgeSuggestion(graph: PlainGraph, table: ReadTable, name: string, ranked: Candidate[], sample: string[][]): MatchSuggestion | null {
  if (!graph.edges.length) return null;
  const byId = ranked.filter((c) => c.source === NODE_ID).slice(0, 6);
  let best: { a: Candidate; b: Candidate; hits: number } | null = null;
  for (const a of byId) {
    for (const b of byId) {
      if (a.column >= b.column || a.normalize !== b.normalize) continue;
      const n = a.normalize;
      const pairs = new Set<string>();
      for (const e of graph.edges) {
        const s = keyOf(e.src, n);
        const d = keyOf(e.dst, n);
        if (s !== null && d !== null) pairs.add(`${s}>${d}`).add(`${d}>${s}`);
      }
      const ia = table.header.indexOf(a.column);
      const ib = table.header.indexOf(b.column);
      let both = 0;
      let hits = 0;
      for (const row of sample) {
        const s = keyOf(row[ia], n);
        const d = keyOf(row[ib], n);
        if (s === null || d === null) continue;
        both++;
        if (pairs.has(`${s}>${d}`)) hits++;
      }
      // Mostly edges of the canvas: the rows describe edges, not two lists of nodes.
      if (hits && hits >= 0.5 * both && (!best || hits > best.hits)) best = { a, b, hits };
    }
  }
  if (!best) return null;
  const [src, dst] = table.header.indexOf(best.a.column) < table.header.indexOf(best.b.column) ? [best.a, best.b] : [best.b, best.a];
  const spec = baseSpec(name, table, [src.column, dst.column]);
  spec.target = 'edges';
  spec.key_column = null;
  spec.normalize = src.normalize;
  spec.edge_key = { by: 'endpoints', source_column: src.column, target_column: dst.column, type_column: null };
  spec.match_edge_types = [];
  const s = measure(graph, table, spec);
  return s.matched ? s : null;
}

/** The exact count of a spec on the graph, with the same functions that apply it. */
export function measure(graph: PlainGraph, table: ReadTable, spec: FileEnrichmentSpec): MatchSuggestion {
  const matches = matchFileRows(graph, spec, fileEnrichmentRows(table.text, spec));
  const onNodes = (spec.target ?? 'nodes') === 'nodes';
  const byType: Record<string, number> = {};
  if (onNodes) {
    const type = new Map(graph.nodes.map((n) => [n.node_id, n.node_type]));
    for (const id of matches.keys()) {
      const t = type.get(id) ?? '';
      byType[t] = (byType[t] ?? 0) + 1;
    }
  }
  const types = onNodes ? spec.match_node_types : spec.match_edge_types;
  const inScope = (t: string) => !types?.length || types.includes('*') || types.includes(t);
  const total = onNodes ? graph.nodes.filter((n) => inScope(n.node_type)).length : graph.edges.filter((e) => inScope(e.relationship_type)).length;
  return { spec, matched: matches.size, total, byType };
}

/** "column doc = property tax_id, digits only": how a spec joins, in one line. */
export function describeMatch(spec: FileEnrichmentSpec): string {
  const norm = spec.normalize && spec.normalize !== 'none' ? `, ${NORMALIZER_LABELS[spec.normalize].toLowerCase()}` : '';
  const digits = spec.key_digits ? `, first ${spec.key_digits} digits` : '';
  if (spec.target === 'edges') {
    if (spec.edge_key?.by === 'endpoints') return `columns ${spec.edge_key.source_column} → ${spec.edge_key.target_column} = the edge's two ends${norm}${digits}`;
    return `column ${spec.key_column} = the edge id${norm}${digits}`;
  }
  const on = typeof spec.match_source === 'object' ? `property ${spec.match_source.name}` : 'the node id';
  return `column ${spec.key_column} = ${on}${norm}${digits}`;
}

/** "Company nodes", "nodes", "TRANSFER edges". */
export function scopeLabel(spec: FileEnrichmentSpec): string {
  const onNodes = (spec.target ?? 'nodes') === 'nodes';
  const types = (onNodes ? spec.match_node_types : spec.match_edge_types)?.filter((t) => t !== '*') ?? [];
  return `${types.length ? `${types.join(', ')} ` : ''}${onNodes ? 'nodes' : 'edges'}`;
}

export interface KeyGuideType {
  type: string;
  count: number;
  /** One real node of the type, for the example. */
  sample: { id: string; name: string | null };
  /** Properties that can be a key: text or number, (almost) one value per node. */
  keys: { name: string; example: string }[];
}

export interface KeyGuide {
  types: KeyGuideType[];
  /** One real edge, for the endpoints example. */
  edge: { src: string; dst: string; type: string } | null;
  /** The canvas has nodes but none carries a property (not loaded, or none in the context). */
  idsOnly: boolean;
}

/** Property names that say they identify something (`tax_id`, `email`, `doc_number`, `cnpj`). */
const ID_LIKE = /(^|_)(id|key|code|doc|document|cpf|cnpj|ssn|tax|email|e_?mail|phone|account|iban|number|no|registry|uuid)(_|$)/i;
const NAME_PROPS = ['name', 'display_name', 'full_name', 'legal_name', 'title', 'label'];

/**
 * What a row can join on this canvas, from its real nodes: per type (most nodes first)
 * a node to show, and the properties that identify a node. Drives the help of the Enrich tab.
 */
export function canvasKeyGuide(graph: PlainGraph, maxTypes = 4, maxKeys = 3): KeyGuide {
  const byType = new Map<string, PlainGraph['nodes']>();
  for (const n of graph.nodes) (byType.get(n.node_type) ?? byType.set(n.node_type, []).get(n.node_type)!).push(n);
  const types = [...byType.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxTypes)
    .map(([type, nodes]): KeyGuideType => {
      const values = new Map<string, Set<string>>();
      const seen = new Map<string, number>();
      for (const n of nodes) {
        for (const [k, v] of Object.entries(n.properties ?? {})) {
          if (typeof v !== 'string' && typeof v !== 'number') continue;
          const s = String(v).trim();
          if (!s) continue;
          (values.get(k) ?? values.set(k, new Set()).get(k)!).add(s);
          seen.set(k, (seen.get(k) ?? 0) + 1);
        }
      }
      const rank = (k: string) => (ID_LIKE.test(k) ? 0 : NAME_PROPS.includes(k) ? 2 : 1);
      const keys = [...values.entries()]
        .filter(([k, set]) => {
          const n = seen.get(k) ?? 0;
          // Present on most nodes and (almost) unique: an id, not a category.
          if (n < 0.8 * nodes.length || set.size < 0.9 * n) return false;
          // A short number (an age, a count) is unique by chance, never a key.
          if ([...set].every((v) => /^-?\d{1,3}(\.\d+)?$/.test(v))) return false;
          // On a handful of nodes anything is unique: trust the property's name instead.
          return nodes.length >= 10 || rank(k) !== 1;
        })
        .sort((a, b) => rank(a[0]) - rank(b[0]) || b[1].size - a[1].size)
        .slice(0, maxKeys)
        .map(([name, set]) => ({ name, example: [...set][0].slice(0, 40) }));
      const first = nodes[0];
      const nameKey = NAME_PROPS.find((k) => first.properties?.[k] !== undefined && first.properties?.[k] !== null);
      return { type, count: nodes.length, sample: { id: first.node_id, name: nameKey ? String(first.properties![nameKey]) : null }, keys };
    });
  const e = graph.edges[0];
  return {
    types,
    edge: e ? { src: e.src, dst: e.dst, type: e.relationship_type } : null,
    idsOnly: graph.nodes.length > 0 && graph.nodes.every((n) => !Object.keys(n.properties ?? {}).length),
  };
}
