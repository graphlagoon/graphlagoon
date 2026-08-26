/**
 * Safe URL building + opening for configurable context-menu actions.
 *
 * A URL template is a labelFormatter template whose static text is the URL
 * skeleton and whose placeholders come from the clicked item. Safety rules:
 *
 * - The template must literally start with http:// or https:// (checked at
 *   edit time AND here), so an interpolated value can never pick the scheme.
 * - Every interpolated value is URL-encoded (encodeURIComponent) BEFORE the
 *   template renders, so `&?#/` in a property cannot restructure the URL.
 * - Referenced properties that resolve empty abort the build (never open a
 *   partial URL) — callers surface `missing` in a toast.
 * - The final string must parse with `new URL` and carry an allowlisted
 *   protocol (http/https). javascript:, data:, file:, etc. are rejected.
 * - New tabs open with `noopener,noreferrer`.
 */
import type { Node, Edge } from '@/types/graph';
import {
  formatLabel,
  extractTemplateProperties,
  resolveItemValue,
} from './labelFormatter';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const URL_PREFIX_RE = /^https?:\/\//i;

export type BuildUrlResult =
  | { ok: true; url: string }
  | { ok: false; missing: string[] }
  | { ok: false; error: string; missing?: undefined };

/** Edit-time template check (the modal blocks saving on a non-empty result). */
export function validateUrlTemplate(template: string): string | null {
  if (!URL_PREFIX_RE.test(template.trim())) {
    return 'URL template must start with http:// or https://';
  }
  return null;
}

function encodeItemForUrl(targetType: 'node' | 'edge', item: Node | Edge): Node | Edge {
  const encodedProperties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item.properties ?? {})) {
    encodedProperties[key] =
      value == null ? value : encodeURIComponent(String(value));
  }
  if (targetType === 'node') {
    const node = item as Node;
    return {
      ...node,
      node_id: encodeURIComponent(node.node_id ?? ''),
      node_type: encodeURIComponent(node.node_type ?? ''),
      properties: encodedProperties,
    };
  }
  const edge = item as Edge;
  return {
    ...edge,
    edge_id: encodeURIComponent(edge.edge_id ?? ''),
    src: encodeURIComponent(edge.src ?? ''),
    dst: encodeURIComponent(edge.dst ?? ''),
    relationship_type: encodeURIComponent(edge.relationship_type ?? ''),
    properties: encodedProperties,
  };
}

export function buildUrlFromTemplate(
  template: string,
  targetType: 'node' | 'edge',
  item: Node | Edge,
): BuildUrlResult {
  const prefixError = validateUrlTemplate(template);
  if (prefixError) return { ok: false, error: prefixError };

  // Referenced raw properties that resolve empty (missing OR not yet loaded
  // by the progressive property loader) abort the build. This is the primary
  // guard; formatLabel's `[name]` sentinel would otherwise leak into the URL.
  const missing = extractTemplateProperties(template).filter(
    (property) => resolveItemValue(targetType, item, property) === '',
  );
  if (missing.length > 0) return { ok: false, missing };

  const url = formatLabel(template, targetType, encodeItemForUrl(targetType, item));

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `Not a valid URL: ${url}` };
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, error: `Blocked URL protocol: ${parsed.protocol}` };
  }
  return { ok: true, url };
}

export function openUrl(url: string, openIn: 'new-tab' | 'same-tab'): void {
  if (openIn === 'new-tab') {
    window.open(url, '_blank', 'noopener,noreferrer');
  } else {
    window.location.assign(url);
  }
}
