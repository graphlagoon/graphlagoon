/**
 * File mapping spec interpreter (03-arquitetura §4), for the preview.
 *
 * Twin of the authoritative `api/graphlagoon/services/file_mapping.py`: the
 * same spec over the same files must give the same graph and report. Both run
 * the golden fixtures in `src/__tests__/fixtures/fileMapping/`; change the two
 * together. The shared semantics are documented in the Python module.
 */
import type { Edge, GraphResponse, Node } from '@/types/graph';
import type { IdentityNormalize } from '@/types/graph';
import { normalizeIdentityValue } from '@/utils/identityKeys';

type Ref = string;
export interface ValueExpr {
  col?: Ref;
  concat?: Ref[];
  template?: string;
  sep?: string;
  convert?: string | string[];
  map?: string;
  normalize?: IdentityNormalize;
}
export type Expr = Ref | ValueExpr;
export type When =
  { eq: [Ref, string] } | { ne: [Ref, string] } | { in: [Ref, string[]] } | { empty: Ref } | { not_empty: Ref };

export interface MappingInput {
  match: string;
  delimiter?: string;
  encoding?: string;
  header?: boolean;
  columns?: string[];
}
export interface NodeMapping {
  key: string;
  type: string;
  from: string;
  id: Expr;
  when?: When;
  props?: Record<string, Expr>;
}
export interface EdgeMapping {
  from: string;
  id?: Expr;
  type: string | ValueExpr;
  direction?: 'in' | 'out' | ({ col: Ref } & Record<string, string>);
  endpoints: { self: string; other: string | string[] };
  when?: When;
  props?: Record<string, Expr>;
}
export interface MappingSpec {
  version: 1;
  name?: string;
  inputs: Record<string, MappingInput>;
  joins?: { left: Ref; right: Ref; as: string }[];
  nodes: NodeMapping[];
  edges?: EdgeMapping[];
  edge_semantics?: {
    amount_prop?: string;
    amount_unit?: string;
    time_prop?: string;
    currency?: string;
  };
  tables?: Record<string, Record<string, string>>;
}

export interface MappingReport {
  rows_read: number;
  rows_discarded: number;
  /** The first MAX_DISCARDED discarded rows, 1-based within their scope. */
  discarded: { from: string; row: number; reason: string }[];
  unknown_nodes: number;
  /** Edge rows whose own endpoint exists; without_counterpart of them lack the other. */
  edge_rows: number;
  without_counterpart: number;
  missing_inputs: string[];
  missing_columns: string[];
}

export interface MappingResult {
  graph: GraphResponse;
  report: MappingReport;
}

export class MappingError extends Error {}
class RowError extends Error {}

const CONVERTERS = ['cents', 'decimal_br', 'trim', 'upper', 'digits'];
const NORMALIZERS = ['cpf_cnpj', 'account', 'phone', 'email', 'lower', 'none'];
const WHEN_OPS = ['eq', 'ne', 'in', 'empty', 'not_empty'];
const MAX_DISCARDED = 20;

const REF = /^[A-Za-z_]\w*\.[^.\s{}]+$/;
const PLACEHOLDER = /\{([^}]+)\}/g;
const CENTS = /^-?\d+$/;
const DECIMAL_BR = /^-?(\d{1,3}(\.\d{3})*|\d+)(,\d+)?$/;

type Obj = Record<string, unknown>;
type Row = Record<string, string>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const alias = (ref: string) => ref.split('.')[0];
const asList = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// ---------------------------------------------------------------------------
// Validation: unknown keys and operators are errors, never ignored.
// ---------------------------------------------------------------------------

function keys(obj: unknown, where: string, allowed: string[], required: string[] = []): Obj {
  if (!isObj(obj)) throw new MappingError(`${where}: expected an object`);
  const extra = Object.keys(obj)
    .filter((k) => !allowed.includes(k))
    .sort();
  if (extra.length) throw new MappingError(`${where}: unknown key '${extra[0]}'`);
  for (const k of required) if (!(k in obj)) throw new MappingError(`${where}: missing '${k}'`);
  return obj;
}

function ref(value: unknown, where: string, refs: Set<string>): void {
  if (typeof value !== 'string' || !REF.test(value)) {
    throw new MappingError(`${where}: expected a column reference 'alias.COLUMN'`);
  }
  refs.add(value);
}

function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

function validateExpr(expr: unknown, where: string, spec: MappingSpec, refs: Set<string>): void {
  if (typeof expr === 'string') return ref(expr, where, refs);
  const e = keys(expr, where, ['col', 'concat', 'template', 'sep', 'convert', 'map', 'normalize']);
  const bases = ['col', 'concat', 'template'].filter((k) => k in e);
  if (bases.length !== 1) throw new MappingError(`${where}: give exactly one of col, concat, template`);
  if ('col' in e) ref(e.col, where, refs);
  if ('concat' in e) {
    if (!Array.isArray(e.concat) || !e.concat.length)
      throw new MappingError(`${where}: concat needs a list of columns`);
    for (const r of e.concat) ref(r, where, refs);
  } else if ('sep' in e) {
    throw new MappingError(`${where}: sep only goes with concat`);
  }
  if ('template' in e) {
    if (typeof e.template !== 'string') throw new MappingError(`${where}: template must be a string`);
    for (const r of placeholders(e.template)) ref(r, where, refs);
  }
  for (const c of asList(e.convert as string | string[] | undefined)) {
    if (!CONVERTERS.includes(c) && !(typeof c === 'string' && c.startsWith('date:'))) {
      throw new MappingError(`${where}: unknown convert '${c}'`);
    }
    if (c.startsWith('date:') && !['dd', 'mm', 'yyyy'].every((t) => c.includes(t))) {
      throw new MappingError(`${where}: date format needs dd, mm and yyyy`);
    }
  }
  if ('map' in e && !(String(e.map) in (spec.tables ?? {}))) {
    throw new MappingError(`${where}: unknown table '${String(e.map)}'`);
  }
  if ('normalize' in e && !NORMALIZERS.includes(e.normalize as string)) {
    throw new MappingError(`${where}: unknown normalize '${String(e.normalize)}'`);
  }
}

function validateWhen(when: unknown, where: string, refs: Set<string>): void {
  const w = keys(when, where, WHEN_OPS);
  const entries = Object.entries(w);
  if (entries.length !== 1) throw new MappingError(`${where}: give exactly one operator`);
  const [op, arg] = entries[0];
  if (op === 'empty' || op === 'not_empty') return ref(arg, where, refs);
  if (!Array.isArray(arg) || arg.length !== 2) throw new MappingError(`${where}: ${op} takes [column, value]`);
  ref(arg[0], where, refs);
  const ok =
    op === 'in'
      ? Array.isArray(arg[1]) && arg[1].every((v: unknown) => typeof v === 'string')
      : typeof arg[1] === 'string';
  if (!ok) throw new MappingError(`${where}: ${op} compares with string values`);
}

function validateProps(props: unknown, where: string, spec: MappingSpec, refs: Set<string>): void {
  if (!isObj(props)) throw new MappingError(`${where}: expected an object`);
  for (const [name, expr] of Object.entries(props)) validateExpr(expr, `${where}.${name}`, spec, refs);
}

/** Throws MappingError; returns the column refs the spec reads. */
export function validateSpec(spec: unknown): Set<string> {
  const refs = new Set<string>();
  const s = keys(
    spec,
    'spec',
    ['version', 'name', 'inputs', 'joins', 'nodes', 'edges', 'edge_semantics', 'tables'],
    ['version', 'inputs', 'nodes'],
  ) as unknown as MappingSpec;
  if (s.version !== 1) throw new MappingError('spec: version must be 1');
  if (!isObj(s.inputs) || !Object.keys(s.inputs).length) throw new MappingError('inputs: declare at least one input');
  for (const [name, inp] of Object.entries(s.inputs)) {
    const where = `inputs.${name}`;
    keys(inp, where, ['match', 'delimiter', 'encoding', 'header', 'columns'], ['match']);
    if (inp.header === false && !inp.columns?.length) throw new MappingError(`${where}: header false needs columns`);
  }
  const tables = s.tables ?? {};
  if (!isObj(tables) || !Object.values(tables).every(isObj)) {
    throw new MappingError('tables: expected {name: {value: label}}');
  }
  const scopes = new Set(Object.keys(s.inputs));
  (s.joins ?? []).forEach((join, i) => {
    const where = `joins[${i}]`;
    keys(join, where, ['left', 'right', 'as'], ['left', 'right', 'as']);
    ref(join.left, where, refs);
    ref(join.right, where, refs);
    for (const side of ['left', 'right'] as const) {
      if (!(alias(join[side]) in s.inputs)) throw new MappingError(`${where}: ${side} must name an input`);
    }
    scopes.add(join.as);
  });
  const nodeKeys = new Set<string>();
  s.nodes.forEach((node, i) => {
    const where = `nodes[${i}]`;
    keys(node, where, ['key', 'type', 'from', 'id', 'when', 'props'], ['key', 'type', 'from', 'id']);
    if (typeof node.type !== 'string') throw new MappingError(`${where}: type must be a string`);
    if (!scopes.has(node.from)) throw new MappingError(`${where}: unknown from '${node.from}'`);
    validateExpr(node.id, `${where}.id`, s, refs);
    if ('when' in node) validateWhen(node.when, `${where}.when`, refs);
    validateProps(node.props ?? {}, `${where}.props`, s, refs);
    nodeKeys.add(node.key);
  });
  (s.edges ?? []).forEach((edge, i) => {
    const where = `edges[${i}]`;
    keys(edge, where, ['from', 'id', 'type', 'direction', 'endpoints', 'when', 'props'], ['from', 'type', 'endpoints']);
    if (!scopes.has(edge.from)) throw new MappingError(`${where}: unknown from '${edge.from}'`);
    if ('id' in edge) validateExpr(edge.id, `${where}.id`, s, refs);
    if (typeof edge.type !== 'string') validateExpr(edge.type, `${where}.type`, s, refs);
    const direction = edge.direction ?? 'out';
    if (isObj(direction)) {
      ref(direction.col, `${where}.direction`, refs);
      if (!Object.entries(direction).every(([k, v]) => k === 'col' || v === 'in' || v === 'out')) {
        throw new MappingError(`${where}.direction: values must be in or out`);
      }
    } else if (direction !== 'in' && direction !== 'out') {
      throw new MappingError(`${where}.direction: must be in, out or {col, …}`);
    }
    const ends = keys(edge.endpoints, `${where}.endpoints`, ['self', 'other'], ['self', 'other']);
    for (const k of [ends.self, ...asList(ends.other as string | string[])]) {
      if (!nodeKeys.has(k as string)) throw new MappingError(`${where}.endpoints: unknown node key '${String(k)}'`);
    }
    if ('when' in edge) validateWhen(edge.when, `${where}.when`, refs);
    validateProps(edge.props ?? {}, `${where}.props`, s, refs);
  });
  if ('edge_semantics' in s) {
    keys(s.edge_semantics, 'edge_semantics', ['amount_prop', 'amount_unit', 'time_prop', 'currency']);
  }
  for (const r of refs) if (!(alias(r) in s.inputs)) throw new MappingError(`'${r}': unknown input alias`);
  return refs;
}

// ---------------------------------------------------------------------------
// Reading files
// ---------------------------------------------------------------------------

/** One delimited line; double quotes with "" escapes; cells trimmed. */
export function parseLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  const n = line.length;
  let i = 0;
  for (;;) {
    let end: number;
    if (i < n && line[i] === '"') {
      i += 1;
      let buf = '';
      while (i < n) {
        if (line[i] === '"') {
          if (i + 1 < n && line[i + 1] === '"') {
            buf += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        buf += line[i];
        i += 1;
      }
      end = line.indexOf(delimiter, i);
      if (end < 0) end = n;
      cells.push(buf.trim());
    } else {
      end = line.indexOf(delimiter, i);
      if (end < 0) end = n;
      cells.push(line.slice(i, end).trim());
    }
    if (end >= n) return cells;
    i = end + delimiter.length;
  }
}

export function lines(text: string): string[] {
  return text
    .replace(/^﻿+/, '')
    .split(/\r?\n/)
    .filter((l) => l !== '');
}

/** Case-insensitive; only * and ? are special. */
export function glob(pattern: string, name: string): boolean {
  const regex = [...pattern]
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')))
    .join('');
  return new RegExp(`^(?:${regex})$`, 'is').test(name);
}

export function matchFile(inp: MappingInput, names: string[]): string | null {
  return [...names].sort().find((n) => glob(inp.match, n)) ?? null;
}

export function columnsOf(inp: MappingInput, all: string[]): [string[], string[]] {
  if (inp.header === false) return [[...(inp.columns ?? [])], all];
  if (!all.length) return [[], []];
  return [parseLine(all[0], inp.delimiter ?? ','), all.slice(1)];
}

// ---------------------------------------------------------------------------
// Interpretation
// ---------------------------------------------------------------------------

type Value = string | number | null;

function convert(value: Value, conv: string): Value {
  if (value === null) return null;
  const s = String(value);
  if (conv === 'trim') return s.trim();
  if (conv === 'upper') return s.toUpperCase();
  if (conv === 'digits') return s.replace(/\D/g, '');
  if (s === '') return null;
  if (conv === 'cents') {
    if (!CENTS.test(s)) throw new RowError(`invalid cents: "${s}"`);
    return parseInt(s, 10) / 100;
  }
  if (conv === 'decimal_br') {
    if (!DECIMAL_BR.test(s)) throw new RowError(`invalid decimal_br: "${s}"`);
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  }
  const fmt = conv.slice('date:'.length);
  if (s.length !== fmt.length) throw new RowError(`invalid ${conv}: "${s}"`);
  const parts: Record<string, string> = {};
  for (const token of ['dd', 'mm', 'yyyy']) {
    const at = fmt.indexOf(token);
    parts[token] = s.slice(at, at + token.length);
  }
  let literal = fmt;
  for (const token of ['yyyy', 'dd', 'mm']) literal = literal.replace(token, '\0'.repeat(token.length));
  const ok =
    [...literal].every((c, i) => c === '\0' || c === s[i]) && Object.values(parts).every((p) => /^\d+$/.test(p));
  const month = parseInt(parts.mm, 10);
  const day = parseInt(parts.dd, 10);
  if (!ok || month < 1 || month > 12 || day < 1 || day > 31) throw new RowError(`invalid ${conv}: "${s}"`);
  return `${parts.yyyy}-${parts.mm}-${parts.dd}`;
}

function get(row: Row, r: string): string | null {
  return Object.prototype.hasOwnProperty.call(row, r) ? row[r] : null;
}

function evaluate(expr: Expr, row: Row, tables: Record<string, Record<string, string>>): Value {
  if (typeof expr === 'string') return get(row, expr);
  let value: Value;
  if (expr.col !== undefined) {
    value = get(row, expr.col);
  } else if (expr.concat !== undefined) {
    const values = expr.concat.map((r) => get(row, r));
    value = values.includes(null) ? null : values.join(expr.sep ?? '-');
  } else {
    let missing = false;
    value = (expr.template ?? '').replace(PLACEHOLDER, (_, r: string) => {
      const v = get(row, r);
      if (v === null) missing = true;
      return v ?? '';
    });
    if (missing) value = null;
  }
  for (const c of asList(expr.convert)) value = convert(value, c);
  if (expr.map !== undefined && value !== null) {
    const table = tables[expr.map];
    const key = String(value);
    if (Object.prototype.hasOwnProperty.call(table, key)) value = table[key];
  }
  if (expr.normalize !== undefined && value !== null) value = normalizeIdentityValue(value, expr.normalize);
  return value;
}

function passes(when: When | undefined, row: Row): boolean {
  if (!when) return true;
  const [op, arg] = Object.entries(when)[0] as [string, unknown];
  if (op === 'empty' || op === 'not_empty') {
    const v = get(row, arg as string);
    const empty = v === null || v === '';
    return op === 'empty' ? empty : !empty;
  }
  const [r, target] = arg as [string, string | string[]];
  const value = get(row, r);
  if (op === 'eq') return value !== null && value === target;
  if (op === 'ne') return value === null || value !== target;
  return value !== null && (target as string[]).includes(value);
}

function evalProps(props: Record<string, Expr> | undefined, row: Row, tables: Record<string, Record<string, string>>) {
  const out: Record<string, unknown> = {};
  for (const [name, expr] of Object.entries(props ?? {})) {
    const value = evaluate(expr, row, tables);
    if (value !== null) out[name] = value;
  }
  return out;
}

/** `files`: decoded text by file name. Throws MappingError on an invalid spec. */
export function interpretMapping(spec: MappingSpec, files: Record<string, string>): MappingResult {
  const refs = validateSpec(spec);
  const tables = spec.tables ?? {};
  const report: MappingReport = {
    rows_read: 0,
    rows_discarded: 0,
    discarded: [],
    unknown_nodes: 0,
    edge_rows: 0,
    without_counterpart: 0,
    missing_inputs: [],
    missing_columns: [],
  };

  const rowsOf: Record<string, Row[]> = {};
  for (const [name, inp] of Object.entries(spec.inputs)) {
    const file = matchFile(inp, Object.keys(files));
    if (file === null) {
      report.missing_inputs.push(name);
      rowsOf[name] = [];
      continue;
    }
    const [columns, data] = columnsOf(inp, lines(files[file]));
    rowsOf[name] = data.map((line) => {
      const cells = parseLine(line, inp.delimiter ?? ',');
      const row: Row = {};
      columns.forEach((c, i) => (row[`${name}.${c}`] = i < cells.length ? cells[i] : ''));
      return row;
    });
    const have = new Set(columns.map((c) => `${name}.${c}`));
    for (const r of refs) if (alias(r) === name && !have.has(r)) report.missing_columns.push(r);
  }
  report.missing_columns.sort();

  for (const join of spec.joins ?? []) {
    const index = new Map<string, Row[]>();
    for (const r of rowsOf[alias(join.right)]) {
      const v = get(r, join.right);
      if (v !== null) index.set(v, [...(index.get(v) ?? []), r]);
    }
    rowsOf[join.as] = rowsOf[alias(join.left)].flatMap((left) => {
      const v = get(left, join.left);
      const matches = v === null ? undefined : index.get(v);
      return matches?.length ? matches.map((r) => ({ ...left, ...r })) : [{ ...left }];
    });
  }

  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  const scopes: string[] = [];
  for (const d of [...spec.nodes, ...(spec.edges ?? [])]) if (!scopes.includes(d.from)) scopes.push(d.from);

  for (const scope of scopes) {
    const nodeDefs = spec.nodes.filter((n) => n.from === scope);
    const scopeEdges = (spec.edges ?? []).map((e, i) => [i, e] as const).filter(([, e]) => e.from === scope);
    rowsOf[scope].forEach((row, index) => {
      const rowNumber = index + 1;
      report.rows_read += 1;
      const rowNodes: Record<string, Node & { properties: Record<string, unknown> }> = {};
      const rowEdges: Edge[] = [];
      let edgeRows = 0;
      let orphans = 0;
      try {
        for (const nd of nodeDefs) {
          if (!passes(nd.when, row)) continue;
          const id = evaluate(nd.id, row, tables);
          if (id === null || id === '') continue;
          rowNodes[nd.key] = {
            node_id: String(id),
            node_type: nd.type,
            properties: evalProps(nd.props, row, tables),
          };
        }
        for (const [i, ed] of scopeEdges) {
          if (!passes(ed.when, row)) continue;
          const me = rowNodes[ed.endpoints.self];
          if (!me) continue;
          edgeRows += 1;
          const otherKey = asList(ed.endpoints.other).find((k) => k in rowNodes);
          if (otherKey === undefined) {
            orphans += 1;
            continue;
          }
          const other = rowNodes[otherKey];
          let direction = ed.direction ?? 'out';
          if (isObj(direction)) {
            const value = get(row, direction.col);
            if (value === null || value === 'col' || !Object.prototype.hasOwnProperty.call(direction, value)) {
              throw new RowError(`unexpected direction: "${value === null ? 'None' : value}"`);
            }
            direction = direction[value] as 'in' | 'out';
          }
          const type = typeof ed.type === 'string' ? ed.type : evaluate(ed.type, row, tables);
          const id = ed.id !== undefined ? evaluate(ed.id, row, tables) : null;
          const [src, dst] = direction === 'out' ? [me, other] : [other, me];
          rowEdges.push({
            edge_id: id !== null && id !== '' ? String(id) : `${i}:${scope}:${rowNumber}`,
            src: src.node_id,
            dst: dst.node_id,
            relationship_type: type !== null ? String(type) : '',
            properties: evalProps(ed.props, row, tables),
          });
        }
      } catch (e) {
        if (!(e instanceof RowError)) throw e;
        report.rows_discarded += 1;
        if (report.discarded.length < MAX_DISCARDED)
          report.discarded.push({
            from: scope,
            row: rowNumber,
            reason: e.message,
          });
        return;
      }
      for (const node of Object.values(rowNodes)) {
        const found = nodes.get(node.node_id);
        if (!found) {
          nodes.set(node.node_id, node);
          continue;
        }
        const props = found.properties as Record<string, unknown>;
        for (const [k, v] of Object.entries(node.properties)) if (!(k in props)) props[k] = v;
      }
      for (const edge of rowEdges) if (!edges.has(edge.edge_id)) edges.set(edge.edge_id, edge);
      report.edge_rows += edgeRows;
      report.without_counterpart += orphans;
    });
  }

  report.unknown_nodes = [...nodes.values()].filter((n) => n.node_type === 'Desconhecido').length;
  return {
    graph: {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      truncated: false,
    },
    report,
  };
}

/**
 * Names of the presets whose every input matches a file by name and by header
 * (the columns it reads), or by column count when the layout has no header.
 */
export function suggestPresets(files: Record<string, string>, presets: Record<string, MappingSpec>): string[] {
  return Object.entries(presets)
    .filter(([, spec]) => {
      const refs = validateSpec(spec);
      return Object.entries(spec.inputs).every(([name, inp]) => {
        const file = matchFile(inp, Object.keys(files));
        const all = file === null ? [] : lines(files[file]);
        if (!all.length) return false;
        const first = parseLine(all[0], inp.delimiter ?? ',');
        if (inp.header === false) return first.length === (inp.columns ?? []).length;
        const header = new Set(first);
        return [...refs].filter((r) => alias(r) === name).every((r) => header.has(r.slice(name.length + 1)));
      });
    })
    .map(([name]) => name);
}
