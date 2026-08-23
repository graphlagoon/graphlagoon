/**
 * Substitute `$paramId` placeholders in a template's query text.
 *
 * One regex, one pass. That shape is the fix for two real bugs the previous
 * sequential split/join had:
 *
 * - Prefix collision: replacing `$node` before `$node_id` corrupted the longer
 *   placeholder into `<value>_id`. The alternation is sorted longest-first, so
 *   the longer id always wins the match.
 * - Chained substitution: a value containing `$other` was itself re-substituted
 *   by a later iteration. A single pass never rescans its own output, so a
 *   value is inert text no matter what it contains.
 *
 * Only DECLARED ids are placeholders. A `$something` the template never
 * declared passes through untouched — it may be a `$hash()` macro or plain
 * text, and either way it is not this function's to interpret.
 */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace `$id` for every id in `paramIds` that has a value in `values`.
 * Declared ids absent from `values` are left as written.
 */
export function substituteTemplateParams(
  text: string,
  paramIds: string[],
  values: Record<string, string>,
): string {
  const ids = paramIds.filter(
    (id) => id.length > 0 && Object.prototype.hasOwnProperty.call(values, id),
  );
  if (ids.length === 0 || text === '') return text;

  const alternation = [...ids]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const placeholder = new RegExp(`\\$(?:${alternation})`, 'g');

  // Function replacer, not a replacement string: `$&`-style patterns inside a
  // value must land as literal text, not as regex back-references.
  return text.replace(placeholder, (match) => values[match.slice(1)]);
}
