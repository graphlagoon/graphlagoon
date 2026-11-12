/**
 * A context's authorized tables (`enrichment_tables`) as YAML: what the context form imports
 * and exports, and what the "Ask an AI" prompt asks for. Same fields as the API (JSON is valid
 * YAML too). Pure; the server re-validates everything on save.
 */
import yaml from 'js-yaml';
import type { EnrichmentQuery, EnrichmentTable } from '@/types/graph';

const NAME = /^[a-z][a-z0-9_]{0,40}$/;
const IDENT = /^`?[\w-]+`?$/;
const RESERVED = new Set(['graph_edges', 'graph_nodes']);

export interface ParsedEnrichmentTables {
  tables: EnrichmentTable[];
  errors: string[];
}

function slug(text: string): string {
  const s = text.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+|_+$/g, '');
  return s.slice(0, 41) || 'table';
}

const strings = (v: unknown): string[] | null =>
  v === undefined || v === null
    ? []
    : typeof v === 'string'
      ? v.split(',').map((x) => x.trim()).filter(Boolean)
      : Array.isArray(v) && v.every((x) => typeof x === 'string')
        ? (v as string[]).map((x) => x.trim()).filter(Boolean)
        : null;

/** One entry, or the reason it is refused (`where` names it in the message). */
function entryOf(raw: unknown, where: string): EnrichmentTable | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${where}: expected a mapping with name, label and table`;
  const r = raw as Record<string, unknown>;
  const table = typeof r.table === 'string' ? r.table.trim() : '';
  const parts = table.split('.');
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => IDENT.test(p))) {
    return `${where}: table must be catalog.schema.table (got ${JSON.stringify(r.table ?? '')})`;
  }
  if (RESERVED.has(parts[parts.length - 1].replace(/`/g, '').toLowerCase())) return `${where}: ${table} uses a reserved name`;
  const label = (typeof r.label === 'string' && r.label.trim()) || table;
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : slug(label);
  if (!NAME.test(name)) return `${where}: name "${name}" must be lowercase letters, digits and _ (starting with a letter)`;
  const entry: EnrichmentTable = { name, label, table };

  const keyColumn = typeof r.key_column === 'string' ? r.key_column.trim() : '';
  const types = strings(r.match_node_types);
  const columns = strings(r.columns);
  if (types === null || columns === null) return `${where}: match_node_types and columns are lists of names`;
  if (keyColumn) {
    if (!types.length || !columns.length) return `${where}: a lookup (key_column) needs match_node_types and columns`;
    if (![keyColumn, ...columns].every((c) => IDENT.test(c))) return `${where}: column names may hold letters, digits, _ and -`;
    const src = r.match_source;
    entry.key_column = keyColumn;
    entry.match_node_types = types;
    entry.match_source =
      src && typeof src === 'object' && typeof (src as { name?: unknown }).name === 'string'
        ? { kind: 'prop', name: (src as { name: string }).name }
        : 'node_id';
    entry.cardinality = r.cardinality === 'many' ? 'many' : 'one';
    entry.columns = columns;
    const p = r.promote as Record<string, unknown> | null | undefined;
    entry.promote =
      p && typeof p.node_type === 'string' && typeof p.id_column === 'string'
        ? { node_type: p.node_type, id_column: p.id_column, edge_type: typeof p.edge_type === 'string' ? p.edge_type : 'RELATED_TO' }
        : null;
    if (entry.promote && !columns.includes(entry.promote.id_column)) return `${where}: promote.id_column must be one of the columns`;
  } else if (types.length || columns.length || r.promote) {
    return `${where}: match_node_types, columns and promote need a key_column`;
  }

  if (r.query !== undefined && r.query !== null) {
    // A bare string is the SQL; a mapping holds the SQL and its settings.
    const q: Record<string, unknown> = typeof r.query === 'string' ? { sql: r.query } : (r.query as Record<string, unknown>);
    const sql = typeof q.sql === 'string' ? q.sql.trim() : '';
    if (!sql) return `${where}: query.sql is empty`;
    if (q.run !== undefined && q.run !== 'auto' && q.run !== 'manual') return `${where}: query.run is auto or manual`;
    if (q.target !== undefined && q.target !== 'edges' && q.target !== 'nodes') return `${where}: query.target is edges or nodes`;
    const query: EnrichmentQuery = {
      sql,
      target: q.target === 'nodes' ? 'nodes' : 'edges',
      run: q.run === 'manual' ? 'manual' : 'auto',
      overwrite: q.overwrite === true,
      node_props: q.node_props === true,
    };
    entry.query = query;
  }
  return entry;
}

/** `enrichment_tables: [...]`, a bare list, or one entry. Names must be unique. */
export function parseEnrichmentTablesYaml(text: string): ParsedEnrichmentTables {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (e) {
    return { tables: [], errors: [`Not valid YAML: ${(e as Error).message.split('\n')[0]}`] };
  }
  const list =
    doc && typeof doc === 'object' && !Array.isArray(doc) && 'enrichment_tables' in doc
      ? (doc as { enrichment_tables: unknown }).enrichment_tables
      : doc && typeof doc === 'object' && !Array.isArray(doc)
        ? [doc]
        : doc;
  if (!Array.isArray(list) || !list.length) {
    return { tables: [], errors: ['Expected a list of tables under enrichment_tables:'] };
  }
  const tables: EnrichmentTable[] = [];
  const errors: string[] = [];
  list.forEach((raw, i) => {
    const out = entryOf(raw, `Table ${i + 1}${raw && typeof raw === 'object' && 'name' in raw ? ` (${String((raw as { name: unknown }).name)})` : ''}`);
    if (typeof out === 'string') errors.push(out);
    else if (tables.some((t) => t.name === out.name)) errors.push(`Table ${i + 1}: the name "${out.name}" is used twice`);
    else tables.push(out);
  });
  return { tables, errors };
}

/** The entries as YAML, SQL as a block, in the API's field names. */
export function enrichmentTablesToYaml(tables: EnrichmentTable[]): string {
  const clean = tables.map((t) => {
    const out: Record<string, unknown> = { name: t.name, label: t.label, table: t.table };
    if (t.key_column) {
      Object.assign(out, {
        key_column: t.key_column,
        match_node_types: t.match_node_types ?? [],
        match_source: t.match_source ?? 'node_id',
        cardinality: t.cardinality ?? 'one',
        columns: t.columns ?? [],
      });
      if (t.promote) out.promote = t.promote;
    }
    if (t.query?.sql) {
      out.query = { target: t.query.target ?? 'edges', run: t.query.run ?? 'manual', overwrite: !!t.query.overwrite, node_props: !!t.query.node_props, sql: `${t.query.sql.trim()}\n` };
    }
    return out;
  });
  return yaml.dump({ enrichment_tables: clean }, { lineWidth: 120, noRefs: true });
}

/** Imported entries replace the ones with the same name; the others are added after. */
export function mergeEnrichmentTables(
  current: EnrichmentTable[],
  imported: EnrichmentTable[],
): { tables: EnrichmentTable[]; added: number; replaced: number } {
  const byName = new Map(imported.map((t) => [t.name, t]));
  let replaced = 0;
  const tables = current.map((t) => {
    const next = byName.get(t.name);
    if (!next) return t;
    replaced++;
    byName.delete(t.name);
    return next;
  });
  return { tables: [...tables, ...byName.values()], added: byName.size, replaced };
}
