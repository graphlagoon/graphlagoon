/**
 * Readable names for case entities (F1, 05 §3 "Legibilidade"): a node is
 * named by the case's label template for its type (`{name} · {document}`),
 * else by a name-like property, else by `type · short id`. Never a raw UUID.
 */
import type { Node } from '@/types/graph';

const NAME_KEYS = ['name', 'display_name', 'full_name', 'legal_name', 'title', 'label'];

type Props = Record<string, unknown> | null | undefined;

export interface LabelOptions {
  /** `settings.label_templates`: node type → template with `{prop}` placeholders. */
  templates?: Record<string, string> | null;
}

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

/** The id without the `@context` suffix or `Type:` prefix of unified ids, cut to 12 chars. */
export function shortId(id: string): string {
  const bare = id.split('@')[0];
  const key = bare.includes(':') ? bare.slice(bare.indexOf(':') + 1) : bare;
  return key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-3)}` : key;
}

/** `{prop}` placeholders filled from the properties (`{id}` and `{type}` too). */
export function applyLabelTemplate(template: string, node: Pick<Node, 'node_id' | 'node_type' | 'properties'>): string {
  const props = (node.properties ?? {}) as Record<string, unknown>;
  const lower = new Map(Object.keys(props).map((k) => [k.toLowerCase(), k]));
  const out = template.replace(/\{([^}]+)\}/g, (_, raw: string) => {
    const key = raw.trim();
    if (key === 'node_id' || key === 'id') return shortId(node.node_id);
    if (key === 'node_type' || key === 'type') return node.node_type;
    const real = lower.get(key.toLowerCase());
    const v = real !== undefined ? props[real] : undefined;
    return v === null || v === undefined ? '' : String(v).trim();
  });
  return out.replace(/\s*[·\-|,]\s*(?=[·\-|,]|$)/g, '').trim();
}

export function caseNodeLabel(node: Pick<Node, 'node_id' | 'node_type' | 'properties'>, options: LabelOptions = {}): string {
  const template = options.templates?.[node.node_type];
  if (template) {
    const text = applyLabelTemplate(template, node);
    if (text) return text;
  }
  return pick(node.properties as Props, NAME_KEYS) ?? `${node.node_type || 'node'} · ${shortId(node.node_id)}`;
}
