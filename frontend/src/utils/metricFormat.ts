/**
 * Display formatting for metric values (numbers, strings, booleans, null).
 *
 * One place for the two precision profiles previously duplicated in
 * SidePanel ('short') and DetailModal ('long').
 */
import type { MetricValue } from '@/types/metrics';

export type MetricPrecision = 'short' | 'long';

export function formatMetricValue(value: MetricValue | undefined, precision: MetricPrecision = 'short'): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (precision === 'long') {
    if (abs !== 0 && abs < 0.0001) return value.toExponential(4);
    if (abs >= 1000) return value.toFixed(2);
    if (abs >= 1) return value.toFixed(4);
    return value.toFixed(6);
  }
  if (abs !== 0 && abs < 0.0001) return value.toExponential(2);
  if (abs >= 1000) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(2);
  return value.toFixed(4);
}
