/**
 * Markdown for case notes, documents and reports (UX-1), with no dependency and no raw HTML:
 * every character is escaped first and only this subset becomes markup — headings, paragraphs
 * (a line break is kept), lists, quotes, rules, fenced and inline code, bold, italic, pipe tables
 * and links. A link only becomes one for `http(s):` and `mailto:`; anything else stays text.
 * The output is the only HTML of a case the app puts in the page (`v-html`), so keep it that way:
 * new syntax goes through `escape` and `inline`, never around them.
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s]+$/i;

/** Inline syntax over already-escaped text. */
function inline(escaped: string): string {
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = escaped.replace(/`([^`]+)`/g, (_, code: string) => hold(`<code>${code}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text: string, url: string) =>
    SAFE_URL.test(url) ? hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`) : whole,
  );
  s = s.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, (url) => hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => slots[Number(i)]);
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const isTableRule = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

export function renderMarkdown(source: string): string {
  const lines = (source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      // Inside a page that has its own headings: a document's # is a section, not the page title.
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inline(escapeHtml(heading[2].replace(/\s+#+\s*$/, '')))}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, j) => `<td>${inline(escapeHtml(r[j] ?? ''))}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }
    const list = line.match(/^\s*([-*+]|\d+[.)])\s+/);
    if (list) {
      const ordered = /\d/.test(list[1]);
      const marker = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      const entries: string[] = [];
      while (i < lines.length && marker.test(lines[i])) entries.push(lines[i++].replace(marker, ''));
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${entries.map((e) => `<li>${inline(escapeHtml(e))}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1]))
    ) {
      para.push(lines[i++]);
    }
    out.push(`<p>${para.map((p) => inline(escapeHtml(p))).join('<br>')}</p>`);
  }
  return out.join('\n');
}
