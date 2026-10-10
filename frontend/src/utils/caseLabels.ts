/**
 * Readable names for case entities (F1, 05 §3 "Legibilidade"): a node is
 * named by `name | nome | razao_social`, else by its masked document, else by
 * `type · short id`. Never a raw UUID or a raw document.
 */
import type { Node } from '@/types/graph';

const NAME_KEYS = ['name', 'nome', 'razao_social', 'nome_fantasia', 'titular', 'title'];
const MASKED_KEYS = ['cpf_mascarado', 'cnpj_mascarado', 'documento_mascarado', 'cpf_cnpj_mascarado'];
const DOC_KEYS = ['cpf', 'cnpj', 'cpf_cnpj', 'documento', 'doc'];

type Props = Record<string, unknown> | null | undefined;

function pick(props: Props, keys: string[]): string | null {
  if (!props) return null;
  const lower = new Map(Object.keys(props).map((k) => [k.toLowerCase(), k]));
  for (const key of keys) {
    const real = lower.get(key);
    const v = real !== undefined ? props[real] : undefined;
    if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/** `***.456.789-**` / `**.345.678/0001-**`; anything else keeps only its last 4 characters. */
export function maskDocument(doc: string): string {
  const d = doc.replace(/\D/g, '');
  if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  if (d.length === 14) return `**.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-**`;
  return doc.length > 4 ? `…${doc.slice(-4)}` : doc;
}

/** The id without the `@context` suffix or `Type:` prefix of unified ids, cut to 12 chars. */
export function shortId(id: string): string {
  const bare = id.split('@')[0];
  const key = bare.includes(':') ? bare.slice(bare.indexOf(':') + 1) : bare;
  return key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-3)}` : key;
}

export function caseNodeLabel(node: Pick<Node, 'node_id' | 'node_type' | 'properties'>): string {
  const props = node.properties as Props;
  const name = pick(props, NAME_KEYS);
  if (name) return name;
  const masked = pick(props, MASKED_KEYS);
  if (masked) return masked;
  const doc = pick(props, DOC_KEYS);
  if (doc) return maskDocument(doc);
  return `${node.node_type || 'node'} · ${shortId(node.node_id)}`;
}

/** Property keys the inspector hides: a raw document whose masked sibling is present. */
export function hiddenRawDocumentKeys(props: Props): Set<string> {
  const hidden = new Set<string>();
  if (!props) return hidden;
  for (const key of Object.keys(props)) {
    const base = key.toLowerCase();
    if (DOC_KEYS.includes(base) && Object.keys(props).some((k) => k.toLowerCase() === `${base}_mascarado`)) {
      hidden.add(key);
    }
  }
  return hidden;
}
