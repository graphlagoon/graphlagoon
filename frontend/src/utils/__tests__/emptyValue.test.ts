import { describe, it, expect } from 'vitest';
import { isEmptyValue, isEmptyPropertyValue, hideEmpty } from '@/utils/emptyValue';

describe('isEmptyValue', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['blank string', '   '],
    ['newline-only string', '\n\t'],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['empty array', []],
    ['empty object', {}],
  ])('treats %s as empty', (_label, value) => {
    expect(isEmptyValue(value)).toBe(true);
  });

  it.each([
    ['zero', 0],
    ['negative zero', -0],
    ['a negative number', -1],
    ['false', false],
    ['true', true],
    ['the string "0"', '0'],
    ['the string "false"', 'false'],
    ['the literal string "null"', 'null'],
    ['"N/A"', 'N/A'],
    ['a dash', '-'],
    ['an array holding a zero', [0]],
    ['an array holding a null', [null]],
    ['an object with a null value', { a: null }],
  ])('keeps %s', (_label, value) => {
    expect(isEmptyValue(value)).toBe(false);
  });

  it('does not mistake a class instance for an empty object', () => {
    // A Date has no own enumerable keys, but it is emphatically a value.
    expect(isEmptyValue(new Date('2026-01-01'))).toBe(false);
  });
});

describe('isEmptyPropertyValue', () => {
  it.each([
    ['a stringified empty array', '[]'],
    ['a stringified empty object', '{}'],
    ['a stringified empty array with spacing', '  [ ]  '],
    ['a real empty array', []],
    ['null', null],
    ['a blank string', '  '],
  ])('treats %s as empty', (_label, value) => {
    expect(isEmptyPropertyValue(value)).toBe(true);
  });

  it.each([
    ['a stringified populated object', '{"a":1}'],
    ['a stringified populated array', '[1,2]'],
    ['the literal string "null"', 'null'],
    ['an unparseable brace', '{'],
    ['a truncated array', '[1,'],
    ['zero', 0],
    ['false', false],
  ])('keeps %s', (_label, value) => {
    expect(isEmptyPropertyValue(value)).toBe(false);
  });

  it('keeps the array-of-tuples shape the side panel formats', () => {
    expect(isEmptyPropertyValue([['spark', 'v3'], ['rows', '10']])).toBe(false);
  });
});

describe('hideEmpty', () => {
  const isEmpty = (n: number | null) => n === null;

  it('keeps everything when disabled, hiding nothing', () => {
    const items = [1, null, 2];
    const result = hideEmpty(items, isEmpty, false);

    expect(result.kept).toEqual([1, null, 2]);
    expect(result.hiddenCount).toBe(0);
  });

  it('drops the empties and counts them when enabled', () => {
    const result = hideEmpty([1, null, 2, null], isEmpty, true);

    expect(result.kept).toEqual([1, 2]);
    expect(result.hiddenCount).toBe(2);
  });

  it('reports zero hidden when nothing is empty', () => {
    expect(hideEmpty([1, 2], isEmpty, true).hiddenCount).toBe(0);
  });

  it('can drop every item', () => {
    const result = hideEmpty([null, null], isEmpty, true);

    expect(result.kept).toEqual([]);
    expect(result.hiddenCount).toBe(2);
  });

  it('handles an empty input', () => {
    expect(hideEmpty([], isEmpty, true)).toEqual({ kept: [], hiddenCount: 0 });
  });

  it('never mutates the input', () => {
    const items = [1, null, 2];
    hideEmpty(items, isEmpty, true);
    hideEmpty(items, isEmpty, false);

    expect(items).toEqual([1, null, 2]);
  });

  it('returns a copy, not the original array, when disabled', () => {
    const items = [1, 2];
    expect(hideEmpty(items, isEmpty, false).kept).not.toBe(items);
  });
});
