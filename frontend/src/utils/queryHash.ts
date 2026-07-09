/**
 * Client-side `$hash(...)` query macro — Databricks-compatible xxhash64.
 *
 * Some graphs use a Databricks `xxhash64(...)` of a natural key as the node/edge
 * ID. Writing the raw 64-bit integer by hand is impractical, so the user can put
 * `$hash('some_key')` anywhere in a query; `substituteHashCalls()` rewrites each
 * call to the signed 64-bit integer Databricks would produce, before the query is
 * sent to the transpile/execute endpoint.
 *
 * Parity (seed 42), matching Spark `xxhash64` on a STRING column:
 *   hashUnsigned = h64(input, 42n)              // xxhash-wasm, unsigned bigint
 *   result       = BigInt.asIntN(64, hashUnsigned)   // signed 64-bit
 * Both hash the UTF-8 bytes of the string, so parity holds for string inputs only
 * (numeric/other Spark types use a different byte encoding and are out of scope).
 *
 * Pure of Vue/Three; the xxhash-wasm instance is lazily initialized once and reused
 * (singleton, modeled on services/workerPool.ts's getWorkerPool()).
 */
import xxhash from 'xxhash-wasm';

/** Databricks/Spark xxhash64 seed. */
const SEED = 42n;

/** Macro token; distinct marker so it never shadows native SQL `hash()`/`xxhash64()`. */
const HASH_MACRO = '$hash(';

/**
 * Matches `$hash(<arg>)`. `[^)]*` means a quoted arg containing a literal `)`
 * is not supported — acceptable for hash keys.
 */
const HASH_MACRO_RE = /\$hash\(\s*([^)]*?)\s*\)/g;

let hasherPromise: ReturnType<typeof xxhash> | null = null;

function getHasher(): ReturnType<typeof xxhash> {
  if (!hasherPromise) hasherPromise = xxhash();
  return hasherPromise;
}

/** Clear the memoized hasher — test hook (mirrors resetWorkerPool). */
export function resetHasher(): void {
  hasherPromise = null;
}

/**
 * Signed 64-bit xxhash64 of `input` with seed 42, identical to Databricks
 * `xxhash64(input, 42)` for a STRING argument.
 */
export async function databricksXxhash64(input: string): Promise<bigint> {
  const { h64 } = await getHasher();
  const unsigned = h64(input, SEED);
  return BigInt.asIntN(64, unsigned);
}

/** Strip one pair of surrounding single/double quotes, if present. */
function stripQuotes(arg: string): string {
  const t = arg.trim();
  if (
    t.length >= 2 &&
    ((t[0] === "'" && t[t.length - 1] === "'") ||
      (t[0] === '"' && t[t.length - 1] === '"'))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Replace every `$hash(<arg>)` in `query` with the decimal signed 64-bit hash of
 * its (unquoted) argument. Negative hashes render as `-123…`, valid SQL/Cypher
 * literals. Returns `query` unchanged — without initializing WASM — when no macro is
 * present.
 */
export async function substituteHashCalls(query: string): Promise<string> {
  if (!query || !query.includes(HASH_MACRO)) return query;

  const matches = [...query.matchAll(HASH_MACRO_RE)];
  if (matches.length === 0) return query;

  // Compute each distinct arg's hash once.
  const cache = new Map<string, string>();
  for (const m of matches) {
    const key = stripQuotes(m[1]);
    if (!cache.has(key)) {
      cache.set(key, (await databricksXxhash64(key)).toString());
    }
  }

  return query.replace(HASH_MACRO_RE, (_full, arg: string) =>
    cache.get(stripQuotes(arg))!,
  );
}
