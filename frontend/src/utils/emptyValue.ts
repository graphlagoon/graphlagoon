/**
 * "Is this value nothing?" — the single predicate behind the
 * "Hide empty properties and metrics" display setting.
 *
 * Pure and shared: SidePanel and DetailModal still carry their own value
 * formatters, and this is the one rule they must never disagree about. Both
 * surfaces call it for properties *and* for metrics, so there is exactly one
 * definition of "empty" in the app.
 *
 * Non-goals, on purpose:
 * - No recursion into containers. `[0]` and `{ a: null }` have structure, so
 *   they are data.
 * - No "looks like a null literal" heuristics. The string `'null'`, `'N/A'` or
 *   `'-'` is text somebody stored; guessing at its semantics would delete real
 *   values.
 * - `0` and `false` are results, not absences (degree 0, weight 0, a flag that
 *   is off). They always render.
 */
import { tryParseJson } from './jsonDetection';

/**
 * Structural emptiness. Used directly for metric values.
 *
 * Non-finite numbers count as empty: `NaN` is a computation that failed, and
 * `Infinity` was included by product decision (revisit if a metric ever wants
 * to show an unreachable distance).
 */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    // Only plain objects. A Date (or any class instance) has no own enumerable
    // keys and is emphatically not empty.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.keys(value as object).length === 0;
  }
  return false;
}

/**
 * Property-cell emptiness: judges the value as it is *rendered*.
 *
 * A property whose value is the string `'[]'` is drawn by JsonValueViewer as an
 * empty array, so it is judged on the parsed value. `tryParseJson` only reports
 * `isJson` for objects and arrays, so the literal string `'null'` is never
 * collapsed by this.
 */
export function isEmptyPropertyValue(value: unknown): boolean {
  const parsed = tryParseJson(value);
  return isEmptyValue(parsed.isJson ? parsed.parsed : value);
}

/**
 * Split a list into what to render and how many were dropped — the shape the
 * "N empty hidden · Show" hint needs.
 *
 * `enabled === false` short-circuits to "keep everything", so the disabled path
 * is identical to the pre-feature one and callers stay one-liners.
 */
export function hideEmpty<T>(
  items: readonly T[],
  isEmpty: (item: T) => boolean,
  enabled: boolean,
): { kept: T[]; hiddenCount: number } {
  if (!enabled) return { kept: [...items], hiddenCount: 0 };
  const kept = items.filter((item) => !isEmpty(item));
  return { kept, hiddenCount: items.length - kept.length };
}
