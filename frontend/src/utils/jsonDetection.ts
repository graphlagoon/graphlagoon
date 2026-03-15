/**
 * Utilities for detecting and working with JSON values in property displays.
 */

type JsonParseSuccess = { parsed: unknown; isJson: true };
type JsonParseFailure = { isJson: false };
export type JsonParseResult = JsonParseSuccess | JsonParseFailure;

/**
 * Attempts to detect and parse a JSON value.
 * - If value is already an object/array, returns it directly.
 * - If value is a string starting with { or [, attempts JSON.parse.
 * - Only returns isJson:true for parsed objects/arrays (not primitives).
 */
export function tryParseJson(value: unknown): JsonParseResult {
  if (typeof value === 'object' && value !== null) {
    return { parsed: value, isJson: true };
  }

  if (typeof value !== 'string') return { isJson: false };

  const trimmed = value.trim();
  if (trimmed.length === 0) return { isJson: false };

  const firstChar = trimmed[0];
  if (firstChar !== '{' && firstChar !== '[') return { isJson: false };

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      return { parsed, isJson: true };
    }
    return { isJson: false };
  } catch {
    return { isJson: false };
  }
}

/**
 * Returns true when value is an array of plain objects with sufficient key overlap.
 * "Uniform" means: all items are non-null objects (not arrays), and at least 70% of
 * all keys appear in at least 50% of items.
 */
export function isUniformObjectArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;

  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
  }

  const keyCounts = new Map<string, number>();
  for (const item of value) {
    for (const key of Object.keys(item as Record<string, unknown>)) {
      keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    }
  }

  if (keyCounts.size === 0) return false;

  const threshold = value.length * 0.5;
  let commonKeys = 0;
  for (const count of keyCounts.values()) {
    if (count >= threshold) commonKeys++;
  }

  return commonKeys >= keyCounts.size * 0.7;
}

/**
 * Extracts keys from an array of objects, sorted by frequency (most common first),
 * then alphabetically for ties.
 */
export function extractCommonKeys(items: Record<string, unknown>[]): string[] {
  const keyCounts = new Map<string, number>();
  for (const item of items) {
    for (const key of Object.keys(item)) {
      keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    }
  }
  return Array.from(keyCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
}

/**
 * Truncates a value for display in table cells.
 */
export function truncateValue(value: unknown, maxLen = 60): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') {
    const str = String(value);
    return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
  }
  const str = JSON.stringify(value);
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

/**
 * Returns true if the value is an object or array (i.e., complex/expandable).
 */
export function isComplexValue(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}
