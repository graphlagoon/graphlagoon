import { describe, it, expect, beforeEach } from 'vitest';
import {
  databricksXxhash64,
  substituteHashCalls,
  resetHasher,
} from '@/utils/queryHash';

// Golden vectors verified against Databricks `xxhash64(<str>, 42)` (signed 64-bit).
const GOLDEN: Record<string, string> = {
  melao_pf: '-1480451197245718748',
  foo: '-3075308222547705278',
  '': '-7444071767201028348',
  user_123: '1418859906640916740',
};

describe('databricksXxhash64', () => {
  beforeEach(() => resetHasher());

  it('matches Databricks xxhash64 (seed 42, signed) — primary parity vector', async () => {
    expect((await databricksXxhash64('melao_pf')).toString()).toBe(
      '-1480451197245718748',
    );
  });

  it('reproduces additional golden vectors, including negative results', async () => {
    for (const [input, expected] of Object.entries(GOLDEN)) {
      expect((await databricksXxhash64(input)).toString()).toBe(expected);
    }
  });

  it('returns a bigint', async () => {
    expect(typeof (await databricksXxhash64('foo'))).toBe('bigint');
  });
});

describe('substituteHashCalls', () => {
  beforeEach(() => resetHasher());

  it('replaces a single-quoted macro with the signed decimal hash', async () => {
    const out = await substituteHashCalls("MATCH (n {id: $hash('melao_pf')}) RETURN n");
    expect(out).toBe('MATCH (n {id: -1480451197245718748}) RETURN n');
  });

  it('treats the no-quote form the same as the quoted form', async () => {
    const quoted = await substituteHashCalls("$hash('foo')");
    const bare = await substituteHashCalls('$hash(foo)');
    expect(bare).toBe(GOLDEN.foo);
    expect(bare).toBe(quoted);
  });

  it('handles double-quoted args', async () => {
    expect(await substituteHashCalls('$hash("foo")')).toBe(GOLDEN.foo);
  });

  it('replaces multiple occurrences (including repeats) in one query', async () => {
    const out = await substituteHashCalls(
      "WHERE a = $hash('foo') OR b = $hash('user_123') OR c = $hash('foo')",
    );
    expect(out).toBe(
      `WHERE a = ${GOLDEN.foo} OR b = ${GOLDEN.user_123} OR c = ${GOLDEN.foo}`,
    );
  });

  it('tolerates whitespace inside the parentheses', async () => {
    expect(await substituteHashCalls("$hash(  'foo'  )")).toBe(GOLDEN.foo);
  });

  it('leaves surrounding text and other tokens untouched', async () => {
    const q = 'SELECT hash(x), xxhash64(y, 42) FROM t WHERE z > 1';
    expect(await substituteHashCalls(q)).toBe(q);
  });

  it('returns the input unchanged when no macro is present', async () => {
    const q = 'MATCH (n) RETURN n LIMIT 10';
    expect(await substituteHashCalls(q)).toBe(q);
    expect(await substituteHashCalls('')).toBe('');
  });
});
