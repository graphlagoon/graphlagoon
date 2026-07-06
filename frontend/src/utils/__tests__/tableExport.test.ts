import { describe, it, expect } from 'vitest';
import { toDelimited } from '@/utils/tableExport';

describe('toDelimited', () => {
  it('produces a header row + data with the given separator', () => {
    const tsv = toDelimited(['a', 'b'], [['1', '2'], ['3', '4']], '\t');
    expect(tsv).toBe('a\tb\n1\t2\n3\t4');
  });

  it('emits just the header when there are no rows', () => {
    expect(toDelimited(['a', 'b'], [], ',')).toBe('a,b');
  });

  it('quotes and escapes fields containing the separator, quotes or newlines', () => {
    const csv = toDelimited(
      ['name', 'note'],
      [['Alice, Jr', 'says "hi"'], ['Bob', 'line1\nline2']],
      ',',
    );
    expect(csv).toBe('name,note\n"Alice, Jr","says ""hi"""\nBob,"line1\nline2"');
  });

  it('renders null cells as empty', () => {
    expect(toDelimited(['a'], [[null]], ',')).toBe('a\n');
  });
});
