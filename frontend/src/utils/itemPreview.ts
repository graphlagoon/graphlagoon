/**
 * What the browser can show of a case item's bytes, whatever its kind: a table
 * (JSON `{columns, rows}`, an array of records, CSV/TSV), text (markdown, plain,
 * JSON that is not tabular), an image, a PDF or HTML. Anything else is
 * `none`, and the inspector offers the download instead.
 */
import { parseTableContent } from '@/utils/caseTables';
import type { CaseItem } from '@/types/investigation';

export const PREVIEW_MAX_ROWS = 200;
export const PREVIEW_MAX_CHARS = 200_000;
/** Above this, the inspector does not fetch the bytes to preview: download only. */
export const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

export type ItemPreview =
  | { kind: 'table'; columns: string[]; rows: unknown[][]; total: number }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'image' | 'pdf' }
  | { kind: 'html'; html: string }
  | { kind: 'none' };

export function buildPreview(data: ArrayBuffer, contentType: string | null | undefined): ItemPreview {
  const type = (contentType ?? '').toLowerCase();
  if (type.startsWith('image/')) return { kind: 'image' };
  if (type === 'application/pdf') return { kind: 'pdf' };
  const text = decodeText(data, type);
  if (text === null) return { kind: 'none' };
  if (type.startsWith('text/html')) return { kind: 'html', html: text };
  if (/^text\/(csv|tab-separated-values)/.test(type) || (type.startsWith('text/plain') && looksTabSeparated(text))) {
    return table(parseTableContent(text, type));
  }
  if (!type || type.startsWith('application/json')) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return textPreview(text);
    }
    if (Array.isArray(json) && json.length && json.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
      return table(parseTableContent(JSON.stringify({ rows: json }), 'application/json'));
    }
    if (json && typeof json === 'object' && Array.isArray((json as { rows?: unknown }).rows)) {
      return table(parseTableContent(text, 'application/json'));
    }
    return textPreview(JSON.stringify(json, null, 2));
  }
  return textPreview(text);
}

/** The name a download gets: the uploaded file name, else the title with an extension for its type. */
export function itemFileName(item: CaseItem): string {
  if (item.provenance?.filename) return item.provenance.filename;
  const type = item.latest?.content_type ?? '';
  const ext = Object.entries(EXTENSIONS).find(([prefix]) => type.startsWith(prefix))?.[1] ?? 'bin';
  return `${item.title}.${ext}`;
}

const EXTENSIONS: Record<string, string> = {
  'application/json': 'json',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'text/html': 'html',
  'text/plain': 'txt',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
};

/** UTF-8, or Windows-1252 for a declared text type (SIMBA and bank exports); null for binary. */
function decodeText(data: ArrayBuffer, type: string): string | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    if (!type.startsWith('text/')) return null;
    text = new TextDecoder('windows-1252').decode(data);
  }
  return text.includes('\u0000') ? null : text;
}

function looksTabSeparated(text: string): boolean {
  const lines = text.split(/\r?\n/, 20).filter((l) => l.trim());
  if (lines.length < 2) return false;
  const tabs = lines[0].split('\t').length;
  return tabs > 1 && lines.every((l) => l.split('\t').length === tabs);
}

function table({ columns, rows }: { columns: string[]; rows: unknown[][] }): ItemPreview {
  return { kind: 'table', columns, rows: rows.slice(0, PREVIEW_MAX_ROWS), total: rows.length };
}

function textPreview(text: string): ItemPreview {
  return { kind: 'text', text: text.slice(0, PREVIEW_MAX_CHARS), truncated: text.length > PREVIEW_MAX_CHARS };
}
