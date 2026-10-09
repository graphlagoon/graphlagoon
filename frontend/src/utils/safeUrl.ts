/**
 * Safe URL building + opening for configurable context-menu actions.
 *
 * A URL template is a labelFormatter template whose static text is the URL
 * skeleton and whose placeholders come from the clicked item. Two families of
 * URL are accepted:
 *
 * - **Web links** — `http://` / `https://`, opened in a tab.
 * - **App links** — any other URL scheme (`vscode://`, `claude-cli://`,
 *   `obsidian://`, `mailto:`, …), handed to the operating system, which
 *   launches whatever app registered that scheme. The browser asks the user
 *   before launching. The template author (who has write access to the
 *   context) is trusted to pick the app; the graph DATA never is.
 *
 * Safety rules:
 *
 * - The template must literally start with its scheme (checked at edit time
 *   AND here), so an interpolated value can never pick the scheme.
 * - Schemes the browser handles itself — `javascript:`, `data:`, `file:`, … —
 *   are never accepted: they do not open an app, they run or render inside
 *   this page (a stored XSS against every reader of the context).
 * - Every interpolated value is URL-encoded (encodeURIComponent) BEFORE the
 *   template renders, so `&?#/:` in a property cannot restructure the URL.
 * - Referenced properties that resolve empty abort the build (never open a
 *   partial URL) — callers surface `missing` in a toast. Metric refs
 *   (`{metric:x}`, `{if:metric:x...}`) get the same guard, reported as
 *   `metric:<ref>` in `missing`.
 * - Metric values come from the resolver, not from item.properties, so they
 *   bypass encodeItemForUrl. They are URL-encoded inside a resolver wrapper
 *   instead — the ONLY allowed injection point for metric values into a URL.
 *   Like properties, modifiers run on the already-encoded string.
 * - The final string must parse with `new URL` and its protocol must pass the
 *   same scheme check again.
 * - Web links in a new tab open with `noopener,noreferrer`; app links always
 *   go through `location.assign`, which hands off to the OS without leaving
 *   the page (window.open would strand an empty tab).
 */
import type { Node, Edge } from '@/types/graph';
import {
  formatLabel,
  extractTemplateProperties,
  extractTemplateMetrics,
  resolveItemValue,
  resolveItemMetricValue,
  type MetricResolver,
} from './labelFormatter';

const WEB_SCHEMES = new Set(['http', 'https']);
/**
 * Schemes the browser resolves itself instead of handing to an app: they run
 * script in this origin, render attacker-controlled content inline, or read
 * local files. Never valid for an action, whoever wrote the template.
 */
const IN_BROWSER_SCHEMES = new Set([
  'javascript',
  'vbscript',
  'data',
  'blob',
  'file',
  'filesystem',
  'about',
  'view-source',
]);
/** RFC 3986 scheme. `{` is not in the class, so a placeholder can never form part of it. */
const SCHEME_PREFIX_RE = /^([a-z][a-z0-9+.-]*):/i;

export type BuildUrlResult =
  | { ok: true; url: string }
  | { ok: false; missing: string[] }
  | { ok: false; error: string; missing?: undefined };

/** Lowercased literal scheme a template/URL starts with, or null if it starts with anything else. */
export function urlScheme(template: string): string | null {
  const match = SCHEME_PREFIX_RE.exec(template.trim());
  return match ? match[1].toLowerCase() : null;
}

/** True for an app link (any accepted scheme other than http/https). */
export function isAppUrl(urlOrTemplate: string): boolean {
  const scheme = urlScheme(urlOrTemplate);
  return scheme !== null && !WEB_SCHEMES.has(scheme) && !IN_BROWSER_SCHEMES.has(scheme);
}

/** Edit-time template check (the modal blocks saving on a non-empty result). */
export function validateUrlTemplate(template: string): string | null {
  const trimmed = template.trim();
  const scheme = urlScheme(trimmed);
  if (scheme === null) {
    return 'URL template must start with a scheme: https:// for a web page, or an app scheme such as vscode://';
  }
  if (IN_BROWSER_SCHEMES.has(scheme)) {
    return `${scheme}: URLs are not allowed — use https:// or an app scheme such as vscode://`;
  }
  if (WEB_SCHEMES.has(scheme) && !/^https?:\/\//i.test(trimmed)) {
    return `URL template must start with ${scheme}://`;
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
  options?: { metrics?: MetricResolver },
): BuildUrlResult {
  const prefixError = validateUrlTemplate(template);
  if (prefixError) return { ok: false, error: prefixError };

  // Referenced raw properties that resolve empty (missing OR not yet loaded
  // by the progressive property loader) abort the build. This is the primary
  // guard; formatLabel's `[name]` sentinel would otherwise leak into the URL.
  // Metric refs get the same treatment (uncomputed/session-stale metrics),
  // prefixed so the caller's toast reads unambiguously.
  const missing = extractTemplateProperties(template).filter(
    (property) => resolveItemValue(targetType, item, property) === '',
  );
  for (const ref of extractTemplateMetrics(template)) {
    if (resolveItemMetricValue(targetType, item, ref, options?.metrics) === '') {
      missing.push(`metric:${ref}`);
    }
  }
  if (missing.length > 0) return { ok: false, missing };

  // The wrapper closes over the RAW item id: encodeItemForUrl encodes
  // node_id/edge_id, which would break the metric Map lookup for ids
  // containing URI-special characters.
  const rawId = targetType === 'node' ? (item as Node).node_id : (item as Edge).edge_id;
  const encodedMetrics: MetricResolver | undefined = options?.metrics
    ? (t, _id, ref) => {
        const v = options.metrics!(t, rawId, ref);
        return v == null ? undefined : encodeURIComponent(String(v));
      }
    : undefined;

  const url = formatLabel(template, targetType, encodeItemForUrl(targetType, item), {
    metrics: encodedMetrics,
  });

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `Not a valid URL: ${url}` };
  }
  const scheme = parsed.protocol.slice(0, -1);
  if (IN_BROWSER_SCHEMES.has(scheme) || scheme !== urlScheme(template)) {
    return { ok: false, error: `Blocked URL protocol: ${parsed.protocol}` };
  }
  return { ok: true, url };
}

export function openUrl(url: string, openIn: 'new-tab' | 'same-tab'): void {
  // App links: the browser hands the URL to the OS (after its own "Open …?"
  // prompt) and the page stays put, so `openIn` does not apply.
  if (isAppUrl(url)) {
    window.location.assign(url);
  } else if (openIn === 'new-tab') {
    window.open(url, '_blank', 'noopener,noreferrer');
  } else {
    window.location.assign(url);
  }
}
