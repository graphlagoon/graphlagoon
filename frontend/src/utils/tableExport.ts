/**
 * Serialize a raw tabular result (aligned `columns: string[]` + `rows:
 * (string|null)[][]`) as delimited text (CSV/TSV) — used to copy the Query
 * Console result to the clipboard as a spreadsheet-friendly TSV block.
 */

/** RFC-4180-style field escaping (works for both ',' and '\t' separators). */
function escapeField(value: string | null, sep: string): string {
  const s = value ?? '';
  if (s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

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
