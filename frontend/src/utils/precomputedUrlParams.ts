/**
 * Which query parameters belong to a precomputed graph, and how to watch them.
 *
 * `?precomputed=<name>` names a graph resource; every other non-reserved key is
 * an argument the resolving provider declared — `?precomputed=neighbourhood&
 * seed=99872&hops=3`. The keys are open-ended, so the frontend cannot allowlist
 * them the way `layoutUrlOverrides` allowlists layout fields; it forwards what
 * is not spoken for and lets the server reject anything undeclared.
 *
 * A pure module, imported by GraphVisualizationView — no Vue, no Pinia, no
 * router — for the same reason layoutUrlOverrides is: the view has no unit test
 * of its own, so the logic that has to be right lives where it can be tested.
 */

import type { QueryLike } from './layoutUrlOverrides';

/**
 * Query keys the frontend owns. Forwarding one would send the server a
 * parameter no provider can have declared, which is an immediate 400.
 *
 * `layout` is matched by prefix rather than as `layout.`, deliberately wider
 * than layoutUrlOverrides' own `isLayoutKey`: a future `layoutMode=` must never
 * leak into a provider's arguments, and this denylist is the last line before
 * it would.
 */
const RESERVED_KEYS = ['precomputed', 'style', 'exploration'] as const;
const RESERVED_PREFIX = 'layout';

/**
 * Analytics parameters that ride along on shared links.
 *
 * Pasting a link into Slack can append `?utm_source=...`, and forwarding it
 * would turn a perfectly good link into "unknown parameter". Dropping them is
 * cheaper than explaining that failure to everyone who shares a graph.
 */
const IGNORED_PREFIXES = ['utm_', 'fbclid', 'gclid', '_hs', 'mc_'];

/** The name of the precomputed graph a URL asks for, if any. */
export const PRECOMPUTED_KEY = 'precomputed';

export function isReservedKey(key: string): boolean {
  if ((RESERVED_KEYS as readonly string[]).includes(key)) return true;
  if (key.startsWith(RESERVED_PREFIX)) return true;
  return IGNORED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Collapse vue-router's `string | string[] | null` into one string.
 *
 * Last occurrence wins here, matching how `resolveValue` treats layout keys.
 * Note the server does *not*: it rejects a repeated parameter outright rather
 * than guessing. Collapsing anyway keeps the watch signature stable, and the
 * request that follows carries the single value the user most likely meant —
 * so the 400, when it comes, is about the URL rather than about us.
 */
function collapse(raw: string | (string | null)[] | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  const values = raw.map((value) => value ?? '');
  return values.length > 0 ? values[values.length - 1] : '';
}

/** The graph name in `?precomputed=`, or undefined when the URL asks for none. */
export function precomputedName(query: QueryLike): string | undefined {
  const raw = collapse(query[PRECOMPUTED_KEY]);
  return raw === '' ? undefined : raw;
}

/**
 * Provider arguments to forward: every key the frontend does not own.
 *
 * Empty when the URL names no precomputed graph — arguments without a name are
 * nobody's, and sending them would attach a stray `?foo=1` to whatever else the
 * page happens to be doing.
 */
export function precomputedParams(query: QueryLike): Record<string, string> {
  if (precomputedName(query) === undefined) return {};

  const params: Record<string, string> = {};
  for (const key of Object.keys(query)) {
    if (isReservedKey(key)) continue;
    // Guard the prototype the same way parseLayoutOverrides does: these keys
    // come from the URL and end up as object keys.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    params[key] = collapse(query[key]);
  }
  return params;
}

/**
 * A stable string standing in for "which precomputed graph, with which arguments".
 *
 * The name and its arguments both live in the query string and the argument
 * keys are open-ended, so there is no single `route.query.style`-style property
 * to watch — the signature plays the role `layoutQuerySignature` plays for
 * `layout.*`. Sorting makes reordering a link a no-op.
 *
 * Two properties are load-bearing rather than cosmetic:
 *
 * - It is `''` when no graph is named. Otherwise a stray `?foo=1` on an
 *   ordinary context URL would move the signature, fire the watcher and re-run
 *   the default auto-load branch.
 * - It excludes `style` and `layout*`. Those have their own, cheaper watchers,
 *   and changing a style deliberately does *not* reload the graph; folding them
 *   in here would shadow that with a full refetch.
 */
export function precomputedQuerySignature(query: QueryLike): string {
  const name = precomputedName(query);
  if (name === undefined) return '';

  const params = precomputedParams(query);
  const entries = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`);
  return [`${PRECOMPUTED_KEY}=${name}`, ...entries].join('&');
}
