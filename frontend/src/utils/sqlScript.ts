/**
 * Whether a SQL string is a BEGIN…END compound-statement script.
 *
 * Mirrors the backend's `_is_script` (services/datasource/sql_warehouse.py):
 * such scripts are procedural-BFS transpiler output and are only executable
 * through the Cypher endpoints — the raw-SQL endpoints reject them with
 * SCRIPT_NOT_ALLOWED, because their bodies can contain DML/DDL the SELECT-only
 * validator cannot inspect.
 */
export function isSqlScript(sql: string): boolean {
  // Slightly more lenient than the backend (tolerates a trailing ';'):
  // "BEGIN…END;" is not recognized as a script server-side either, but it
  // still fails SELECT-only validation there, so treating it as a script
  // here routes it to the same dead end with a better message.
  const stripped = sql.trim().toUpperCase().replace(/;\s*$/, '');
  return stripped.startsWith('BEGIN') && stripped.endsWith('END');
}
