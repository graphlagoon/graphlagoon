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

import { normalizeIdentityValue } from '@/utils/identityKeys';
import type { IdentityNormalize } from '@/types/graph';

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

// ---------------------------------------------------------------------------
// Shared attributes (05 §4b): Vínculos
// ---------------------------------------------------------------------------

export interface LinkNode {
  uid: string;
  type: string;
  properties?: Record<string, unknown> | null;
}

/** How a property value is normalized before comparing, by attribute name (twin of the Python map). */
export const ATTRIBUTE_NORMALIZERS: Record<string, IdentityNormalize> = {
  telefone: 'phone', phone: 'phone', celular: 'phone',
  email: 'email', 'e-mail': 'email',
  device_id: 'device_id', dispositivo: 'device_id', device: 'device_id',
  ip: 'ip',
  endereco: 'address', address: 'address', logradouro: 'address',
  cartao: 'card', card: 'card',
  terminal: 'terminal_id', terminal_id: 'terminal_id',
  cpf: 'cpf_cnpj', cnpj: 'cpf_cnpj', cpf_cnpj: 'cpf_cnpj', documento: 'cpf_cnpj',
  conta: 'account', account: 'account',
  chave_pix: 'pix_key', pix_key: 'pix_key',
};

export interface SharedLinksParams {
  /** Property names on the entities and/or node types of attribute nodes they connect to. */
  attributes: string[];
  /** A pair needs at least this many shared attributes to be linked (default 1). */
  minShared?: number;
  /** Values shared by more entities than this are too common to mean anything (a carrier IP). */
  maxEntities?: number;
  /** Entity node types to link; default: every node whose type is not an attribute type. */
  entityTypes?: string[];
}

export interface SharedLinkEdge {
  id: string;
  src: string;
  dst: string;
  /** `compartilha_<attribute>` */
  type: string;
  properties: { attribute: string; value: string; shared_by: number };
}

export interface SharedLinkPair {
  left: string;
  right: string;
  shared: string[];
}

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * Links entities that share attribute values, read from their own properties
 * (`telefone`) or from attribute nodes they connect to (a `Telefone` node). Pure and
 * deterministic; the Python twin is `entity_resolution.shared_attribute_links`
 * (fixture `__tests__/fixtures/er/shared-attributes.json`). Nothing merges: the
 * result is a `graph/derived` item of `compartilha_<attr>` edges a person reviews.
 */
export function sharedAttributeLinks(
  graph: { nodes: LinkNode[]; edges: { src: string; dst: string }[] },
  params: SharedLinksParams,
): { edges: SharedLinkEdge[]; pairs: SharedLinkPair[] } {
  const attributes = params.attributes.filter(Boolean);
  const minShared = Math.max(1, params.minShared ?? 1);
  const maxEntities = params.maxEntities ?? Number.POSITIVE_INFINITY;
  const attrTypes = new Set(attributes.map((a) => a.toLowerCase()));
  const byUid = new Map(graph.nodes.map((n) => [n.uid, n]));
  const entityTypes = params.entityTypes?.length ? new Set(params.entityTypes) : null;
  const isEntity = (n: LinkNode) => (entityTypes ? entityTypes.has(n.type) : !attrTypes.has(n.type.toLowerCase()));

  // entity → attribute node neighbours (both directions)
  const neighbours = new Map<string, LinkNode[]>();
  for (const e of graph.edges) {
    for (const [a, b] of [[e.src, e.dst], [e.dst, e.src]]) {
      const n = byUid.get(b);
      if (n && attrTypes.has(n.type.toLowerCase())) neighbours.set(a, [...(neighbours.get(a) ?? []), n]);
    }
  }

  const propKey = (props: Record<string, unknown>, name: string) =>
    Object.keys(props).find((k) => k.toLowerCase() === name.toLowerCase());

  const shared = new Map<string, { left: string; right: string; attrs: Map<string, { value: string; count: number }> }>();
  for (const attribute of attributes) {
    const lower = attribute.toLowerCase();
    const groups = new Map<string, Set<string>>();
    for (const n of graph.nodes) {
      if (!isEntity(n)) continue;
      const values = new Set<string>();
      const props = n.properties ?? {};
      const k = propKey(props, attribute);
      const v = k !== undefined ? props[k] : null;
      const normalized = normalizeIdentityValue(v, ATTRIBUTE_NORMALIZERS[lower] ?? 'lower');
      if (normalized !== null) values.add(normalized);
      for (const m of neighbours.get(n.uid) ?? []) if (m.type.toLowerCase() === lower) values.add(m.uid);
      for (const value of values) groups.set(value, (groups.get(value) ?? new Set()).add(n.uid));
    }
    for (const [value, members] of groups) {
      if (members.size < 2 || members.size > maxEntities) continue;
      const ids = [...members].sort(cmp);
      for (let i = 0; i < ids.length; i++) {
        for (const right of ids.slice(i + 1)) {
          const key = `${ids[i]}\u0000${right}`;
          const pair = shared.get(key) ?? { left: ids[i], right, attrs: new Map() };
          if (!pair.attrs.has(attribute)) pair.attrs.set(attribute, { value, count: members.size });
          shared.set(key, pair);
        }
      }
    }
  }

  const pairs: SharedLinkPair[] = [];
  const edges: SharedLinkEdge[] = [];
  for (const p of [...shared.values()].sort((a, b) => cmp(a.left, b.left) || cmp(a.right, b.right))) {
    if (p.attrs.size < minShared) continue;
    const attrs = [...p.attrs.keys()].sort(cmp);
    pairs.push({ left: p.left, right: p.right, shared: attrs });
    for (const attribute of attrs) {
      const { value, count } = p.attrs.get(attribute)!;
      edges.push({
        id: `link:${attribute}:${p.left}:${p.right}`,
        src: p.left,
        dst: p.right,
        type: `compartilha_${attribute}`,
        properties: { attribute, value, shared_by: count },
      });
    }
  }
  return { edges, pairs };
}
