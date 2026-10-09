/**
 * Entity resolution (investigations, 03 §6.2): match suggestions between entities
 * of the unified case graph. Pure; `workers/erWorker.ts` runs it off the main
 * thread and `api/graphlagoon/services/entity_resolution.py` is the server port
 * (both checked against `__tests__/fixtures/er/matches.json`).
 *
 * Only pair (b) is a suggestion: the 6 central CPF digits equal and at least one
 * side masked. A full document is already an identity key, and nothing here ever
 * merges: a person accepts each match.
 */

export const ER_THRESHOLD = 0.85;
const STOPWORDS = new Set(['DE', 'DA', 'DO', 'DOS', 'DAS', 'E']);
const MASK = /[*•xX]/;

export interface ErNode {
  uid: string;
  properties?: Record<string, unknown> | null;
}

export interface ErReason {
  term: 'name' | 'cpf_middle6' | 'cep5';
  weight: number;
  value: number;
  left?: string;
  right?: string;
  masked?: boolean;
}

export interface MatchSuggestion {
  left: { uid: string };
  right: { uid: string };
  score: number;
  reasons: ErReason[];
}

const round4 = (x: number) => Math.floor(x * 1e4 + 0.5) / 1e4;

export function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function normalizeName(value: unknown): string {
  const text = stripAccents(String(value ?? '')).toUpperCase();
  return text
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w))
    .join(' ');
}

/** [the 6 central CPF digits, masked?] or null. A CNPJ ("/" or 14 digits) is out. */
export function middleSix(value: unknown): [string, boolean] | null {
  const raw = String(value ?? '');
  if (raw.includes('/')) return null;
  const digits = raw.replace(/\D/g, '');
  if (MASK.test(raw)) return digits.length === 6 ? [digits, true] : null;
  return digits.length === 11 ? [digits.slice(3, 9), false] : null;
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a ? 1 : 0;
  if (!a || !b) return 0;
  const window = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
  const aHit = new Array<boolean>(a.length).fill(false);
  const bHit = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j++) {
      if (!bHit[j] && b[j] === a[i]) {
        aHit[i] = bHit[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  const aSeq = [...a].filter((_, i) => aHit[i]);
  const bSeq = [...b].filter((_, i) => bHit[i]);
  const transpositions = aSeq.filter((c, i) => c !== bSeq[i]).length / 2;
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length) && a[i] === b[i]; i++) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function prop(props: Record<string, unknown>, test: (k: string) => boolean): unknown {
  for (const [k, v] of Object.entries(props)) {
    if (v !== null && v !== undefined && v !== '' && test(stripAccents(k).toLowerCase())) return v;
  }
  return null;
}

/** The document, name and CEP the score reads (also used to highlight them in T8). */
export function erFields(props: Record<string, unknown>) {
  return {
    doc: prop(props, (k) => k.includes('cpf') || ['documento', 'document', 'doc'].includes(k)),
    name: prop(props, (k) => k.includes('nome') || k === 'name' || k === 'razao_social'),
    cep: prop(props, (k) => k.includes('cep') || k.includes('zip')),
  };
}

interface Features { uid: string; six: string; masked: boolean; name: string; cep5: string | null }

function features(node: ErNode): Features | null {
  const f = erFields(node.properties ?? {});
  const six = middleSix(f.doc);
  if (!six) return null;
  const cep = String(f.cep ?? '').replace(/\D/g, '');
  return { uid: node.uid, six: six[0], masked: six[1], name: normalizeName(f.name), cep5: cep.length >= 5 ? cep.slice(0, 5) : null };
}

export function suggestMatches(nodes: ErNode[]): MatchSuggestion[] {
  const blocks = new Map<string, Features[]>();
  for (const n of nodes) {
    const f = features(n);
    if (f) blocks.set(f.six, [...(blocks.get(f.six) ?? []), f]);
  }
  const out: MatchSuggestion[] = [];
  for (const block of blocks.values()) {
    for (let i = 0; i < block.length; i++) {
      for (const b of block.slice(i + 1)) {
        const a = block[i];
        if (a.uid === b.uid || !(a.masked || b.masked)) continue;
        const jw = round4(jaroWinkler(a.name, b.name));
        const sameCep = a.cep5 && a.cep5 === b.cep5 ? 1 : 0;
        const score = round4(0.5 * jw + 0.3 + 0.2 * sameCep);
        if (score < ER_THRESHOLD) continue;
        out.push({
          left: { uid: a.uid },
          right: { uid: b.uid },
          score,
          reasons: [
            { term: 'name', weight: 0.5, value: jw, left: a.name, right: b.name },
            { term: 'cpf_middle6', weight: 0.3, value: 1, masked: true },
            { term: 'cep5', weight: 0.2, value: sameCep },
          ],
        });
      }
    }
  }
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return out.sort((x, y) => y.score - x.score || cmp(x.left.uid, y.left.uid) || cmp(x.right.uid, y.right.uid));
}
