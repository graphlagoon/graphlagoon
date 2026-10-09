/**
 * Serialize a raw tabular result (aligned `columns: string[]` + `rows:
 * (string|null)[][]`) as delimited text (CSV/TSV) — used to copy the Query
 * Console result to the clipboard as a spreadsheet-friendly TSV block.
 * Cells are formula-neutralized (see `csvSafe.ts`, security assessment M4).
 */

import { escapeDelimitedField as escapeField } from './csvSafe';

/** Serialize a raw result as delimited text (header row + data). */
export function toDelimited(
  columns: string[],
  rows: (string | null)[][],
  sep: string,
): string {
  const header = columns.map(c => escapeField(c, sep)).join(sep);
  if (rows.length === 0) return header;
  const body = rows.map(r => r.map(v => escapeField(v, sep)).join(sep)).join('\n');
  return `${header}\n${body}`;
}
