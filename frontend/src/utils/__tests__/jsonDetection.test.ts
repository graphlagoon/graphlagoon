import { describe, it, expect } from 'vitest';
import {
  tryParseJson,
  isUniformObjectArray,
  extractCommonKeys,
  truncateValue,
  isComplexValue,
} from '../jsonDetection';

describe('tryParseJson', () => {
  // Positive cases
  it('parses a JSON object string', () => {
    const result = tryParseJson('{"name":"John","age":30}');
    expect(result.isJson).toBe(true);
    if (result.isJson) {
      expect(result.parsed).toEqual({ name: 'John', age: 30 });
    }
  });

  it('parses a JSON array string', () => {
    const result = tryParseJson('[1, 2, 3]');
    expect(result.isJson).toBe(true);
    if (result.isJson) {
      expect(result.parsed).toEqual([1, 2, 3]);
    }
  });

  it('parses an array of objects string', () => {
    const result = tryParseJson('[{"a":1},{"a":2}]');
    expect(result.isJson).toBe(true);
    if (result.isJson) {
      expect(result.parsed).toEqual([{ a: 1 }, { a: 2 }]);
    }
  });

  it('handles already-parsed objects', () => {
    const obj = { foo: 'bar' };
    const result = tryParseJson(obj);
    expect(result.isJson).toBe(true);
    if (result.isJson) {
      expect(result.parsed).toBe(obj);
    }
  });

  it('handles already-parsed arrays', () => {
    const arr = [1, 2, 3];
    const result = tryParseJson(arr);
    expect(result.isJson).toBe(true);
    if (result.isJson) {
      expect(result.parsed).toBe(arr);
    }
  });

  it('handles whitespace-padded JSON strings', () => {
    const result = tryParseJson('  { "key": "value" }  ');
    expect(result.isJson).toBe(true);
    if (result.isJson) {
      expect(result.parsed).toEqual({ key: 'value' });
    }
  });

  it('handles nested JSON', () => {
    const result = tryParseJson('{"a":{"b":{"c":1}}}');
    expect(result.isJson).toBe(true);
    if (result.isJson) {
      expect(result.parsed).toEqual({ a: { b: { c: 1 } } });
    }
  });

  // Negative cases
  it('rejects plain strings', () => {
    expect(tryParseJson('hello world')).toEqual({ isJson: false });
  });

  it('rejects numbers', () => {
    expect(tryParseJson(42)).toEqual({ isJson: false });
  });

  it('rejects booleans', () => {
    expect(tryParseJson(true)).toEqual({ isJson: false });
  });

  it('rejects strings not starting with { or [', () => {
    expect(tryParseJson('"just a string"')).toEqual({ isJson: false });
    expect(tryParseJson('42')).toEqual({ isJson: false });
    expect(tryParseJson('true')).toEqual({ isJson: false });
  });

  it('rejects malformed JSON', () => {
    expect(tryParseJson('{invalid json}')).toEqual({ isJson: false });
    expect(tryParseJson('[1, 2,')).toEqual({ isJson: false });
  });

  it('rejects null', () => {
    expect(tryParseJson(null)).toEqual({ isJson: false });
  });

  it('rejects undefined', () => {
    expect(tryParseJson(undefined)).toEqual({ isJson: false });
  });

  it('rejects empty string', () => {
    expect(tryParseJson('')).toEqual({ isJson: false });
    expect(tryParseJson('   ')).toEqual({ isJson: false });
  });
});

describe('isUniformObjectArray', () => {
  it('returns true for array of same-keyed objects', () => {
    expect(isUniformObjectArray([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
      { a: 5, b: 6 },
    ])).toBe(true);
  });

  it('returns true with some optional keys', () => {
    expect(isUniformObjectArray([
      { a: 1, b: 2, c: 3 },
      { a: 4, b: 5 },
      { a: 7, b: 8, c: 9 },
    ])).toBe(true);
  });

  it('returns false for empty array', () => {
    expect(isUniformObjectArray([])).toBe(false);
  });

  it('returns false for array of primitives', () => {
    expect(isUniformObjectArray([1, 2, 3])).toBe(false);
  });

  it('returns false for mixed types', () => {
    expect(isUniformObjectArray([{ a: 1 }, 'string', 42])).toBe(false);
  });

  it('returns false for array of arrays', () => {
    expect(isUniformObjectArray([[1, 2], [3, 4]])).toBe(false);
  });

  it('returns false for non-array', () => {
    expect(isUniformObjectArray({ a: 1 })).toBe(false);
    expect(isUniformObjectArray('string')).toBe(false);
    expect(isUniformObjectArray(null)).toBe(false);
  });

  it('returns false for array with null items', () => {
    expect(isUniformObjectArray([null, null])).toBe(false);
  });

  it('returns true for single-item array', () => {
    expect(isUniformObjectArray([{ a: 1, b: 2 }])).toBe(true);
  });

  it('returns false for objects with no common keys', () => {
    expect(isUniformObjectArray([
      { a: 1 },
      { b: 2 },
      { c: 3 },
      { d: 4 },
    ])).toBe(false);
  });

  it('returns false for array of empty objects', () => {
    expect(isUniformObjectArray([{}, {}, {}])).toBe(false);
  });
});

describe('extractCommonKeys', () => {
  it('returns keys sorted by frequency then alphabetically', () => {
    const items = [
      { a: 1, b: 2, c: 3 },
      { a: 4, b: 5 },
      { a: 7, c: 9 },
    ];
    const keys = extractCommonKeys(items);
    // a appears 3 times, b and c appear 2 times each
    expect(keys).toEqual(['a', 'b', 'c']);
  });

  it('handles single item', () => {
    expect(extractCommonKeys([{ x: 1, y: 2 }])).toEqual(['x', 'y']);
  });

  it('handles empty items array', () => {
    expect(extractCommonKeys([])).toEqual([]);
  });

  it('sorts alphabetically when frequencies are equal', () => {
    const items = [
      { z: 1, a: 2, m: 3 },
    ];
    expect(extractCommonKeys(items)).toEqual(['a', 'm', 'z']);
  });
});

describe('truncateValue', () => {
  it('returns short strings unchanged', () => {
    expect(truncateValue('hello')).toBe('hello');
  });

  it('truncates long strings', () => {
    const long = 'a'.repeat(100);
    const result = truncateValue(long, 60);
    expect(result).toBe('a'.repeat(60) + '...');
  });

  it('truncates complex objects', () => {
    const obj = { key: 'a'.repeat(100) };
    const result = truncateValue(obj, 30);
    expect(result.length).toBe(33); // 30 chars + '...'
    expect(result.endsWith('...')).toBe(true);
  });

  it('returns "null" for null/undefined', () => {
    expect(truncateValue(null)).toBe('null');
    expect(truncateValue(undefined)).toBe('null');
  });

  it('handles numbers', () => {
    expect(truncateValue(42)).toBe('42');
  });

  it('handles booleans', () => {
    expect(truncateValue(true)).toBe('true');
  });

  it('does not truncate small objects', () => {
    expect(truncateValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe('isComplexValue', () => {
  it('returns true for objects', () => {
    expect(isComplexValue({ a: 1 })).toBe(true);
  });

  it('returns true for arrays', () => {
    expect(isComplexValue([1, 2])).toBe(true);
  });

  it('returns false for null', () => {
    expect(isComplexValue(null)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isComplexValue('string')).toBe(false);
    expect(isComplexValue(42)).toBe(false);
    expect(isComplexValue(true)).toBe(false);
    expect(isComplexValue(undefined)).toBe(false);
  });
});
