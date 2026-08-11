/**
 * Remove comments from a query, preserving string literals.
 *
 * Port of `strip_sql_comments` in api/graphlagoon/services/sql_validation.py —
 * keep the two in sync. The backend strips comments before executing; the
 * frontend needs the same view of the text so the gates that test the leading
 * keyword (Run button validation, cypher/sql mode routing) agree with it.
 *
 * Used only to *decide* — never to rewrite what the user sees in the editor,
 * so comments they typed are preserved in the panel and in saved explorations.
 *
 * Scans character by character tracking quote state, so a comment marker inside
 * a literal (`WHERE name = 'a -- not a comment'`) is left alone. A plain regex
 * would truncate that literal.
 *
 * @param query The raw query text.
 * @param lineMarker Line comment marker — `--` for SQL, `//` for Cypher.
 * @returns The query with comments removed. The newline terminating a line
 *   comment is kept, so tokens on adjacent lines never get glued together.
 */
export function stripComments(query: string, lineMarker: string = '--'): string {
  if (!query) return query;

  let result = '';
  let i = 0;
  const length = query.length;
  let quote: string | null = null; // active string/identifier delimiter

  while (i < length) {
    const char = query[i];

    if (quote !== null) {
      result += char;
      if (char === '\\' && (quote === "'" || quote === '"') && i + 1 < length) {
        // Spark treats backslash as an escape inside string literals, so the
        // next character cannot close the literal.
        result += query[i + 1];
        i += 2;
        continue;
      }
      if (char === quote) {
        // A doubled delimiter ('' or "") is an escaped delimiter, not the end.
        if (i + 1 < length && query[i + 1] === quote) {
          result += query[i + 1];
          i += 2;
          continue;
        }
        quote = null;
      }
      i += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      result += char;
      i += 1;
      continue;
    }

    if (query.startsWith(lineMarker, i)) {
      // Skip to end of line, keeping the newline itself.
      const newline = query.indexOf('\n', i);
      if (newline === -1) break;
      i = newline;
      continue;
    }

    if (query.startsWith('/*', i)) {
      const end = query.indexOf('*/', i + 2);
      if (end === -1) break; // unterminated block comment: drop the remainder
      i = end + 2;
      continue;
    }

    result += char;
    i += 1;
  }

  return result;
}
