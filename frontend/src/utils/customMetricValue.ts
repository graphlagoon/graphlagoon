/**
 * Coercion of what user code returns into a typed MetricValue.
 *
 * Pure and dependency-free so it runs identically inside the sandbox worker
 * (first pass) and on the main thread (re-validation of whatever the worker
 * posted back — the worker's output is treated as untrusted too).
 */
import type { MetricValue, MetricValueType } from '@/types/metrics';
import { CUSTOM_METRIC_MAX_STRING_LENGTH } from '@/types/customMetrics';

/**
 * number  → finite numbers only, else null
 * string  → strings (capped), numbers/booleans stringified, else null
 * boolean → strict booleans only, else null
 * undefined / null / objects / functions / symbols → null
 */
export function coerceMetricValue(raw: unknown, valueType: MetricValueType): MetricValue {
  if (raw === null || raw === undefined) return null;
  switch (valueType) {
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    case 'string':
      if (typeof raw === 'string') return raw.slice(0, CUSTOM_METRIC_MAX_STRING_LENGTH);
      if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
      if (typeof raw === 'boolean') return String(raw);
      return null;
    case 'boolean':
      return typeof raw === 'boolean' ? raw : null;
    default:
      return null;
  }
}

/**
 * Main-thread re-validation of a worker payload: keeps only `[string, value]`
 * pairs and re-coerces every value. Anything else is dropped.
 */
export function sanitizeValues(entries: unknown, valueType: MetricValueType): [string, MetricValue][] {
  if (!Array.isArray(entries)) return [];
  const out: [string, MetricValue][] = [];
  for (const e of entries) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string') continue;
    out.push([e[0], coerceMetricValue(e[1], valueType)]);
  }
  return out;
}
