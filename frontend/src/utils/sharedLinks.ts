/**
 * Shared-attribute links (05 §4b): entities that share a phone, a device, an
 * e-mail… become `shares_<attr>` edges a person reviews. Pure and deterministic;
 * the Python twin is `api/graphlagoon/services/entity_resolution.py::shared_attribute_links`
 * (fixture `__tests__/fixtures/er/shared-attributes.json`). Entity resolution
 * (match suggestions) runs on the server only (`/analysis/er`).
 */

import { normalizeIdentityValue } from '@/utils/identityKeys';
import type { IdentityNormalize } from '@/types/graph';

export interface LinkNode {
  uid: string;
  type: string;
  properties?: Record<string, unknown> | null;
}

/**
 * How a property value is normalized before comparing, by attribute name (twin of
 * the Python map); anything else is lowercased, and `normalize` overrides per run.
 */
export const ATTRIBUTE_NORMALIZERS: Record<string, IdentityNormalize> = {
  phone: 'phone', mobile: 'phone', telephone: 'phone',
  email: 'email', 'e-mail': 'email',
  device_id: 'device_id', device: 'device_id',
  ip: 'ip', ip_address: 'ip',
  address: 'address', street: 'address',
  card: 'card', card_number: 'card',
  terminal: 'terminal_id', terminal_id: 'terminal_id', serial_number: 'terminal_id',
  account: 'account', account_number: 'account',
  document: 'digits', document_number: 'digits', national_id: 'digits', tax_id: 'digits', ssn: 'digits',
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
  /** The normalizer of an attribute when its name says nothing (`{ telefone: 'phone' }`). */
  normalize?: Record<string, IdentityNormalize>;
}

export interface SharedLinkEdge {
  id: string;
  src: string;
  dst: string;
  /** `shares_<attribute>` */
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
 * (`phone`) or from attribute nodes they connect to (a `Phone` node). Nothing
 * merges: the result is a `graph/derived` item of `shares_<attr>` edges.
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
  const how = Object.fromEntries(Object.entries(params.normalize ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

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
      const normalized = normalizeIdentityValue(v, how[lower] ?? ATTRIBUTE_NORMALIZERS[lower] ?? 'lower');
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
        type: `shares_${attribute}`,
        properties: { attribute, value, shared_by: count },
      });
    }
  }
  return { edges, pairs };
}
