import { describe, it, expect } from 'vitest';
import { formatMetricValue } from '@/utils/metricFormat';

describe('formatMetricValue', () => {
  it('passes strings and booleans through; null/undefined → dash', () => {
    expect(formatMetricValue('foo.com')).toBe('foo.com');
    expect(formatMetricValue(true)).toBe('true');
    expect(formatMetricValue(false, 'long')).toBe('false');
    expect(formatMetricValue(null)).toBe('—');
    expect(formatMetricValue(undefined)).toBe('—');
  });

  it('short precision (side panel)', () => {
    expect(formatMetricValue(0)).toBe('0.0000');
    expect(formatMetricValue(0.00001)).toBe('1.00e-5');
    expect(formatMetricValue(0.5)).toBe('0.5000');
    expect(formatMetricValue(3.14159)).toBe('3.14');
    expect(formatMetricValue(12345.6)).toBe('12346');
  });

  it('long precision (detail modal)', () => {
    expect(formatMetricValue(0.00001, 'long')).toBe('1.0000e-5');
    expect(formatMetricValue(0.5, 'long')).toBe('0.500000');
    expect(formatMetricValue(3.14159, 'long')).toBe('3.1416');
    expect(formatMetricValue(12345.678, 'long')).toBe('12345.68');
  });

  it('non-finite numbers are stringified rather than formatted', () => {
    expect(formatMetricValue(Infinity)).toBe('Infinity');
  });
});
