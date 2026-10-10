/** Reading a table item's content in the browser (05 §3): JSON `{columns, rows}` or delimited text. */

export interface TableContent {
  columns: string[];
  rows: unknown[][];
}

export function parseTableContent(data: ArrayBuffer | string, contentType: string): TableContent {
  const text = typeof data === 'string' ? data : new TextDecoder('utf-8').decode(data);
  if (contentType.startsWith('application/json')) {
    const payload = JSON.parse(text) as { columns?: unknown[]; rows?: unknown[] };
    let columns = (payload.columns ?? []).map(String);
    let rows = (payload.rows ?? []) as unknown[];
    if (rows.length && !Array.isArray(rows[0])) {
      const objects = rows as Record<string, unknown>[];
      if (!columns.length) columns = [...new Set(objects.flatMap((r) => Object.keys(r)))];
      rows = objects.map((r) => columns.map((c) => r[c]));
    }
    return { columns, rows: rows as unknown[][] };
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { columns: [], rows: [] };
  const delimiter = [';', ',', '\t', '|'].reduce((best, d) => (lines[0].split(d).length > lines[0].split(best).length ? d : best), ';');
  const split = (l: string) => l.split(delimiter).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
  return { columns: split(lines[0]), rows: lines.slice(1).map(split) };
}

/** The first column every table has (case-insensitive), or null. */
export function commonColumn(tables: string[][]): string | null {
  const [first = [], ...rest] = tables;
  return first.find((c) => rest.every((t) => t.some((o) => o.toLowerCase() === c.toLowerCase()))) ?? null;
}
