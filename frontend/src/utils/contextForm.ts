/**
 * Pure helpers for the graph-context create/edit form.
 *
 * Extracted from ContextsView.vue so they have a real export to test against —
 * ContextsView.logic.test.ts used to re-declare copies of these three
 * functions because the SFC didn't export them, which meant it was testing
 * copies, not the actual logic. Import from here instead.
 */

/** Simple fuzzy search: matches if every query term appears (in any order). */
export function fuzzyMatch(text: string, query: string): boolean {
  const textLower = text.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => textLower.includes(term));
}

/** Parse a tag into its `name:value` parts, or null if it has no colon. */
export function parseTag(tag: string): { name: string; value: string } | null {
  const colonIndex = tag.indexOf(':');
  if (colonIndex > 0) {
    return {
      name: tag.substring(0, colonIndex).trim(),
      value: tag.substring(colonIndex + 1).trim(),
    };
  }
  return null;
}

/**
 * Parse a fully-qualified table name: `database.table` or `catalog.database.table`.
 * A 2-part name implies the `spark_catalog` default.
 */
export function parseTableName(
  fullName: string,
): { catalog: string; database: string; table: string } | null {
  const parts = fullName.split('.');
  if (parts.length === 2) {
    return { catalog: 'spark_catalog', database: parts[0], table: parts[1] };
  } else if (parts.length === 3) {
    // Pass the catalog as-is, sql-warehouse handles the translation
    return { catalog: parts[0], database: parts[1], table: parts[2] };
  }
  return null;
}
