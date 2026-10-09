/**
 * File import assistant (T4, F2.5): what the wizard shows about a mapping spec
 * before the server generates the graph. Pure; the preview graph itself comes
 * from `interpretMapping` (fileMapping.ts).
 */
import type { IdentityKey } from '@/types/graph';
import {
  columnsOf,
  glob,
  lines,
  matchFile,
  parseLine,
  type Expr,
  type MappingSpec,
  type ValueExpr,
} from '@/utils/fileMapping';

/** One row of the mapping table: column(s) → what it becomes → conversion. */
export interface MappingRow {
  columns: string;
  example: string;
  becomes: string;
  conversion: string;
  /** Rows the investigator should look at twice (e.g. "Desconhecido" nodes). */
  highlight: boolean;
}

const asExpr = (e: Expr): ValueExpr => (typeof e === 'string' ? { col: e } : e);

function exprColumns(e: Expr): string[] {
  const x = asExpr(e);
  if (x.col) return [x.col];
  if (x.concat) return x.concat;
  return [...(x.template ?? '').matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

function conversionOf(e: Expr): string {
  const x = asExpr(e);
  const parts: string[] = [];
  if (x.concat) parts.push(`key = ${x.concat.map((c) => c.split('.')[1]).join(' + ')}`);
  if (x.template) parts.push(`template ${x.template}`);
  for (const c of x.convert === undefined ? [] : Array.isArray(x.convert) ? x.convert : [x.convert]) parts.push(c);
  if (x.map) parts.push(`table ${x.map}`);
  if (x.normalize && x.normalize !== 'none') parts.push(`normalize ${x.normalize}`);
  return parts.join(' · ') || 'none';
}

/** The first data row of every input, by `alias.COL`, for the "example" column. */
export function firstRows(spec: MappingSpec, files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [alias, inp] of Object.entries(spec.inputs)) {
    const name = matchFile(inp, Object.keys(files));
    if (!name) continue;
    const [columns, data] = columnsOf(inp, lines(files[name]));
    const cells = data.length ? parseLine(data[0], inp.delimiter ?? ',') : [];
    columns.forEach((c, i) => (out[`${alias}.${c}`] = cells[i] ?? ''));
  }
  return out;
}

function whenText(when: unknown): string {
  if (!when || typeof when !== 'object') return '';
  const [op, args] = Object.entries(when as Record<string, unknown>)[0];
  const [col, value] = Array.isArray(args) ? args : [args, ''];
  const sym: Record<string, string> = { eq: '=', ne: '≠', in: 'in', empty: 'is empty', not_empty: 'is not empty' };
  return ` when ${String(col).split('.')[1]} ${sym[op] ?? op} ${Array.isArray(value) ? value.join(', ') : value}`.trimEnd();
}

/** The mapping table of T4, derived from the spec (the spec stays the source of truth). */
export function mappingRows(spec: MappingSpec, files: Record<string, string>): MappingRow[] {
  const sample = firstRows(spec, files);
  const row = (e: Expr, becomes: string, highlight = false): MappingRow => {
    const cols = exprColumns(e);
    return {
      columns: cols.join(' + '),
      example: cols.map((c) => sample[c] ?? '').filter(Boolean).join(' · '),
      becomes,
      conversion: conversionOf(e),
      highlight,
    };
  };
  const rows: MappingRow[] = [];
  for (const n of spec.nodes) {
    rows.push(row(n.id, `${n.type} node${whenText(n.when)}`, n.type === 'Desconhecido'));
    for (const [prop, e] of Object.entries(n.props ?? {})) rows.push(row(e, `${n.type}.${prop}`));
  }
  for (const e of spec.edges ?? []) {
    if (e.id) rows.push(row(e.id, 'edge id'));
    if (typeof e.type === 'string') rows.push({ columns: '—', example: '', becomes: 'relationship type', conversion: e.type, highlight: false });
    else rows.push(row(e.type, 'relationship type'));
    if (e.direction && typeof e.direction === 'object') {
      const { col, ...map } = e.direction;
      rows.push({
        columns: col,
        example: sample[col] ?? '',
        becomes: 'edge direction',
        conversion: Object.entries(map).map(([k, v]) => `${k} = ${v === 'in' ? 'into' : 'out of'} ${e.endpoints.self}`).join(', '),
        highlight: false,
      });
    }
    for (const [prop, x] of Object.entries(e.props ?? {})) rows.push(row(x, `edge ${prop}`));
  }
  return rows;
}

const KEY_NORMALIZERS = ['cpf_cnpj', 'account', 'phone', 'email'];

/** Mirror of `derived_identity_keys` (services/investigation_files.py). */
export function derivedIdentityKeys(spec: MappingSpec): IdentityKey[] {
  const keys = new Map<string, IdentityKey>();
  for (const n of spec.nodes) {
    const how = typeof n.id === 'object' ? n.id.normalize : undefined;
    if (how && KEY_NORMALIZERS.includes(how) && !keys.has(n.type)) {
      keys.set(n.type, { node_type: n.type, entity: n.type, source: 'node_id', normalize: how });
    }
  }
  return [...keys.values()];
}

/** The encoding of the first input whose glob matches the file name (SIMBA: latin-1). */
export function encodingFor(spec: MappingSpec | null, filename: string): string {
  const inp = Object.values(spec?.inputs ?? {}).find((i) => glob(i.match, filename));
  return decoderLabel(inp?.encoding);
}

/** A spec encoding as a TextDecoder label; unknown ones fall back to UTF-8. */
export function decoderLabel(encoding: string | null | undefined): string {
  // The spec says "latin-1" (Python's name); TextDecoder knows it as "latin1".
  const label = (encoding ?? 'utf-8').toLowerCase().replace(/^latin-1$/, 'latin1');
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return 'utf-8';
  }
}

/** Most frequent of `;`, TAB and `,` in the first line. */
export function guessDelimiter(text: string): string {
  const first = lines(text)[0] ?? '';
  const count = (d: string) => first.split(d).length - 1;
  return [';', '\t', ','].reduce((best, d) => (count(d) > count(best) ? d : best), ',');
}

/**
 * Starting point for a file no preset matches: the first two columns become
 * nodes linked by one edge. The investigator edits the JSON from there.
 */
export function genericSpec(filename: string, text: string): MappingSpec {
  const delimiter = guessDelimiter(text);
  const header = parseLine(lines(text)[0] ?? '', delimiter);
  const [a = 'origem', b = 'destino', ...rest] = header;
  return {
    version: 1,
    name: filename,
    inputs: { t: { match: filename, delimiter, header: true } },
    nodes: [
      { key: 'a', type: 'Node', from: 't', id: `t.${a}` },
      { key: 'b', type: 'Node', from: 't', id: `t.${b}` },
    ],
    edges: [
      {
        from: 't',
        type: 'RELATED_TO',
        endpoints: { self: 'a', other: 'b' },
        props: Object.fromEntries(rest.slice(0, 10).map((c) => [c.toLowerCase(), `t.${c}`])),
      },
    ],
  };
}
