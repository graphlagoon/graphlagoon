import { FilterMatchMode, FilterOperator } from '@primevue/core/api';

export const CATEGORICAL_THRESHOLD = 30;

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

/** Detect whether a column is numeric, date, categorical, or free-text. */
export function detectType<T>(items: T[], accessor: (item: T) => unknown): ColType {
  let numCount = 0, dateCount = 0, total = 0;
  const uniq = new Set<string>();
  let tooMany = false;
  for (const item of items) {
    const val = accessor(item);
    if (val == null || val === '') continue;
    total++;
    const n = Number(val);
    if (!isNaN(n) && isFinite(n) && String(val).trim() !== '') numCount++;
    if (looksLikeDate(val)) dateCount++;
    if (!tooMany) {
      uniq.add(String(val));
      if (uniq.size > CATEGORICAL_THRESHOLD) tooMany = true;
    }
  }
  if (total > 0 && dateCount / total >= 0.8) return 'date';
  if (total > 0 && numCount / total >= 0.8) return 'numeric';
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
    for (const k of propKeys) {
      const field = `prop_${k}`;
      const col = colMap.get(field);
      r[field] = coerceValue(n.properties?.[k] ?? null, col?.type ?? 'text');
    }
    return r;
  });
}
