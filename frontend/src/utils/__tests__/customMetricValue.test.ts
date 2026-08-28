import { describe, it, expect } from 'vitest';
import { coerceMetricValue, sanitizeValues } from '@/utils/customMetricValue';
import { CUSTOM_METRIC_MAX_STRING_LENGTH } from '@/types/customMetrics';

describe('coerceMetricValue', () => {
  it('number: finite numbers only', () => {
    expect(coerceMetricValue(1.5, 'number')).toBe(1.5);
    expect(coerceMetricValue(0, 'number')).toBe(0);
    expect(coerceMetricValue(NaN, 'number')).toBeNull();
    expect(coerceMetricValue(Infinity, 'number')).toBeNull();
    expect(coerceMetricValue('7', 'number')).toBeNull();
    expect(coerceMetricValue(true, 'number')).toBeNull();
    expect(coerceMetricValue({}, 'number')).toBeNull();
  });

  it('string: strings capped, primitives stringified, objects dropped', () => {
    expect(coerceMetricValue('abc', 'string')).toBe('abc');
    expect(coerceMetricValue('x'.repeat(10_000), 'string')).toHaveLength(CUSTOM_METRIC_MAX_STRING_LENGTH);
    expect(coerceMetricValue(12, 'string')).toBe('12');
    expect(coerceMetricValue(false, 'string')).toBe('false');
    expect(coerceMetricValue(NaN, 'string')).toBeNull();
    expect(coerceMetricValue({ a: 1 }, 'string')).toBeNull();
    expect(coerceMetricValue(['a'], 'string')).toBeNull();
    expect(coerceMetricValue(() => 1, 'string')).toBeNull();
  });

  it('boolean: strict', () => {
    expect(coerceMetricValue(true, 'boolean')).toBe(true);
    expect(coerceMetricValue(false, 'boolean')).toBe(false);
    expect(coerceMetricValue(1, 'boolean')).toBeNull();
    expect(coerceMetricValue('true', 'boolean')).toBeNull();
  });

  it('null / undefined are null for every type', () => {
    for (const t of ['number', 'string', 'boolean'] as const) {
      expect(coerceMetricValue(null, t)).toBeNull();
      expect(coerceMetricValue(undefined, t)).toBeNull();
    }
  });
});

describe('sanitizeValues', () => {
  it('keeps only [string, value] pairs and re-coerces', () => {
    const out = sanitizeValues(
      [
        ['a', 1],
        ['b', 'x'],
        ['c', NaN],
        [1, 2],
        ['d'],
        'junk',
        null,
        ['e', { hostile: true }],
      ],
      'number',
    );
    expect(out).toEqual([
      ['a', 1],
      ['b', null],
      ['c', null],
      ['e', null],
    ]);
  });

  it('non-array payloads yield an empty list', () => {
    expect(sanitizeValues(null, 'number')).toEqual([]);
    expect(sanitizeValues({ length: 1 }, 'string')).toEqual([]);
  });
});
