import { FilterMatchMode, FilterOperator } from '@primevue/core/api';
import { buildSearchText, SEARCH_FIELD } from '@/utils/searchText';

export const CATEGORICAL_THRESHOLD = 30;

/**
 * Upper bound on how many non-null values a single column's *expensive*
 * type checks (`Number()` coercion + date-regex + `new Date()`) scan.
 *
 * On very large graphs (200k+ nodes/edges) running these per-value over the
 * whole dataset — for every property column — blocks the main thread for
 * seconds and freezes the tab. Sampling caps that cost at O(columns × SAMPLE)
 * instead of O(columns × n).
 *
 * Only numeric/date inference is sampled. Categorical detection and its option
 * list stay a full scan (cheap: bounded `Set` with early-exit at the threshold),
 * so a MultiSelect filter never misses a value beyond the sample.
 */
export const TYPE_SAMPLE_CAP = 5000;

export type ColType = 'text' | 'numeric' | 'categorical' | 'date';

export interface CatOption {
  label: string;
  value: string | null;
}

export interface ColMeta {
  field: string;
  header: string;
  type: ColType;
  options?: CatOption[];
}

/** ISO-like date pattern: 2024-01-15, 2024-01-15T10:30:00, etc. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Check if a value looks like a date/timestamp string. */
export function looksLikeDate(val: unknown): boolean {
  if (val instanceof Date) return !isNaN(val.getTime());
  if (typeof val !== 'string') return false;
  return DATE_RE.test(val.trim()) && !isNaN(new Date(val).getTime());
}

/** Detect whether a column is numeric, date, categorical, or free-text.
 *
 * Categorical detection scans every value (cheap, early-exits once the unique
 * count passes the threshold). The expensive numeric/date checks are evaluated
 * only over the first `TYPE_SAMPLE_CAP` non-null values so the cost stays
 * bounded on huge datasets. Ratios use `sampled` (the sampled denominator),
 * not `total`, so the 80% thresholds stay meaningful. */
export function detectType<T>(items: T[], accessor: (item: T) => unknown): ColType {
  let numCount = 0, dateCount = 0, sampled = 0;
  const uniq = new Set<string>();
  let tooMany = false;
  for (const item of items) {
    const val = accessor(item);
    if (val == null || val === '') continue;
    // Categorical tracking over ALL values — cheap and early-exiting, so the
    // option list is never truncated by sampling.
    if (!tooMany) {
      uniq.add(String(val));
      if (uniq.size > CATEGORICAL_THRESHOLD) tooMany = true;
    }
    // Expensive numeric/date checks: sample only.
    if (sampled < TYPE_SAMPLE_CAP) {
      sampled++;
      const n = Number(val);
      if (!isNaN(n) && isFinite(n) && String(val).trim() !== '') numCount++;
      if (looksLikeDate(val)) dateCount++;
    } else if (tooMany) {
      // Sample is full and the column is already high-cardinality — neither
      // remaining check can change the outcome, so stop early.
      break;
    }
  }
  if (sampled > 0 && dateCount / sampled >= 0.8) return 'date';
  if (sampled > 0 && numCount / sampled >= 0.8) return 'numeric';
  if (!tooMany && uniq.size > 0) return 'categorical';
  return 'text';
}

/** Collect unique values for a categorical column, including an (empty) option for null/blank. */
export function collectOptions<T>(items: T[], accessor: (item: T) => unknown): CatOption[] {
  const vals = new Set<string>();
  let hasEmpty = false;
  for (const item of items) {
    const v = accessor(item);
    if (v == null || v === '') { hasEmpty = true; continue; }
    vals.add(String(v));
  }
  const opts: CatOption[] = Array.from(vals).sort().map(v => ({ label: v, value: v }));
  if (hasEmpty) opts.push({ label: '(empty)', value: null });
  return opts;
}

export function buildColMeta(field: string, header: string, type: ColType, options?: CatOption[]): ColMeta {
  return { field, header, type, options };
}

/** Build PrimeVue filter model from column metadata (menu mode: operator + constraints). */
export function initFilters(cols: ColMeta[]) {
  const f: Record<string, any> = {
    global: { value: null, matchMode: FilterMatchMode.CONTAINS },
  };
  for (const c of cols) {
    if (c.type === 'date') {
      f[c.field] = { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.DATE_IS }] };
    } else if (c.type === 'numeric') {
      f[c.field] = { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.EQUALS }] };
    } else if (c.type === 'categorical') {
      f[c.field] = { value: null, matchMode: FilterMatchMode.IN };
    } else {
      f[c.field] = { operator: FilterOperator.AND, constraints: [{ value: null, matchMode: FilterMatchMode.STARTS_WITH }] };
    }
  }
  return f;
}

/** Build PrimeVue filter model from column metadata (row mode: simple value + matchMode). */
export function initRowFilters(cols: ColMeta[]) {
  const f: Record<string, any> = {
    global: { value: null, matchMode: FilterMatchMode.CONTAINS },
  };
  for (const c of cols) {
    if (c.type === 'date') {
      f[c.field] = { value: null, matchMode: FilterMatchMode.DATE_IS };
    } else if (c.type === 'numeric') {
      f[c.field] = { value: null, matchMode: FilterMatchMode.EQUALS };
    } else if (c.type === 'categorical') {
      f[c.field] = { value: null, matchMode: FilterMatchMode.IN };
    } else {
      f[c.field] = { value: null, matchMode: FilterMatchMode.CONTAINS };
    }
  }
  return f;
}

/** Build column metadata for a set of nodes, detecting property types automatically. */
export function buildNodeColumns<T extends { node_id: string; node_type: string; properties?: Record<string, unknown> }>(
  nodes: T[],
  propKeys: string[],
): ColMeta[] {
  const cols: ColMeta[] = [
    buildColMeta('node_id', 'ID', 'text'),
    buildColMeta('node_type', 'Type', 'categorical', collectOptions(nodes, n => n.node_type)),
  ];
  for (const k of propKeys) {
    const t = detectType(nodes, n => n.properties?.[k]);
    const opts = t === 'categorical' ? collectOptions(nodes, n => n.properties?.[k]) : undefined;
    cols.push(buildColMeta(`prop_${k}`, k, t, opts));
  }
  return cols;
}

/** Convert a value to Date if the column is a date type, otherwise return as-is. */
export function coerceValue(val: unknown, type: ColType): unknown {
  if (val == null) return null;
  if (type === 'date') {
    if (val instanceof Date) return val;
    const d = new Date(val as string);
    return isNaN(d.getTime()) ? null : d;
  }
  return val;
}

/** Flatten nodes into rows with properties as top-level `prop_*` fields. */
export function flattenNodeRows<T extends { node_id: string; node_type: string; properties?: Record<string, unknown> }>(
  nodes: T[],
  propKeys: string[],
  cols?: ColMeta[],
): Record<string, unknown>[] {
  const colMap = new Map(cols?.map(c => [c.field, c]) ?? []);
  return nodes.map(n => {
    const r: Record<string, unknown> = { node_id: n.node_id, node_type: n.node_type };
    const searchVals: unknown[] = [n.node_id, n.node_type];
    for (const k of propKeys) {
      const field = `prop_${k}`;
      const col = colMap.get(field);
      const val = coerceValue(n.properties?.[k] ?? null, col?.type ?? 'text');
      r[field] = val;
      searchVals.push(val);
    }
    r[SEARCH_FIELD] = buildSearchText(searchVals);
    return r;
  });
}

/** Coerce a single raw cell (backend sends everything as strings) to the type
 * detected for its column, so PrimeVue sorts/filters numerically and by date. */
function coerceCell(val: unknown, type: ColType): unknown {
  if (val == null) return null;
  if (type === 'numeric') {
    if (val === '') return null;
    const n = Number(val);
    return isNaN(n) ? val : n;
  }
  if (type === 'date') return coerceValue(val, 'date');
  return val; // text / categorical keep their string form
}

/**
 * Build column metadata from a raw (columns, rows) tabular result — used for
 * arbitrary query results whose shape is unknown ahead of time.
 *
 * Field keys are synthetic (`col_<i>`) so raw column names containing dots,
 * spaces, or duplicates never break PrimeVue's field resolution; the original
 * name is preserved as the display header. Types are detected from row values.
 */
export function buildGenericColumns(columns: string[], rows: unknown[][]): ColMeta[] {
  return columns.map((name, i) => {
    const type = detectType(rows, r => r[i]);
    const options = type === 'categorical' ? collectOptions(rows, r => r[i]) : undefined;
    return buildColMeta(`col_${i}`, name, type, options);
  });
}

/**
 * Turn raw tabular rows (arrays aligned to `columns`) into keyed row objects
 * (`{ col_0, col_1, ... }`) with each value coerced per its detected column
 * type. Pass the `ColMeta[]` from `buildGenericColumns` so field keys and types
 * stay in sync.
 */
export function buildGenericRows(
  rows: unknown[][],
  cols: ColMeta[],
): Record<string, unknown>[] {
  return rows.map(r => {
    const obj: Record<string, unknown> = {};
    const searchVals: unknown[] = [];
    for (let i = 0; i < cols.length; i++) {
      const val = coerceCell(r[i], cols[i].type);
      obj[cols[i].field] = val;
      searchVals.push(val);
    }
    obj[SEARCH_FIELD] = buildSearchText(searchVals);
    return obj;
  });
}
