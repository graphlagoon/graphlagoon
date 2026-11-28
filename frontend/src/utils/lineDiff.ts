/**
 * What changed between two versions of a text (a brief, a note, a markdown document),
 * line by line: the longest common subsequence keeps what stayed, the rest is removed
 * or added. Enough to review an agent's rewrite without reading the whole text again.
 */
export interface DiffLine {
  op: 'same' | 'add' | 'del';
  text: string;
}

/** Above this many line pairs the table is not worth building: everything old out, everything new in. */
const MAX_CELLS = 4_000_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Common head and tail cost nothing and are most of a small edit.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const same = (lines: string[]): DiffLine[] => lines.map((text) => ({ op: 'same', text }));
  return [...same(a.slice(0, head)), ...middle(am, bm), ...same(a.slice(a.length - tail))];
}

function middle(a: string[], b: string[]): DiffLine[] {
  const del = (lines: string[]): DiffLine[] => lines.map((text) => ({ op: 'del', text }));
  const add = (lines: string[]): DiffLine[] => lines.map((text) => ({ op: 'add', text }));
  if (!a.length || !b.length || a.length * b.length > MAX_CELLS) return [...del(a), ...add(b)];
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) out.push({ op: 'same', text: a[i++] }), j++;
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) out.push({ op: 'del', text: a[i++] });
    else out.push({ op: 'add', text: b[j++] });
  }
  return [...out, ...del(a.slice(i)), ...add(b.slice(j))];
}

export function diffCounts(lines: DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.op === 'add').length, removed: lines.filter((l) => l.op === 'del').length };
}
