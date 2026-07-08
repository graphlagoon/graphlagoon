import { describe, it, expect } from 'vitest';
import { buildSearchText, SEARCH_SEP } from '@/utils/searchText';

describe('buildSearchText', () => {
  it('lowercases and joins values with the separator', () => {
    const s = buildSearchText(['Alice', 'Person']);
    expect(s).toBe(`alice${SEARCH_SEP}person${SEARCH_SEP}`);
  });

  it('stringifies non-string values', () => {
    const s = buildSearchText([42, true, new Date('2024-01-15T00:00:00Z')]);
    expect(s).toContain('42');
    expect(s).toContain('true');
    expect(s.toLowerCase()).toBe(s); // fully lowercased
  });

  it('skips null and undefined without emitting a separator for them', () => {
    expect(buildSearchText([null, 'x', undefined])).toBe(`x${SEARCH_SEP}`);
  });

  it('matches a substring within a single value', () => {
    const s = buildSearchText(['acme corp', 'Company']);
    expect(s.includes('acme')).toBe(true);
    expect(s.includes('company')).toBe(true);
  });

  it('does not match across value boundaries (separator guards concatenation)', () => {
    // 'corppers' would only match if the two values were joined without a
    // boundary; the NUL separator prevents that.
    const s = buildSearchText(['corp', 'person']);
    expect(s.includes('corpperson')).toBe(false);
  });
});
