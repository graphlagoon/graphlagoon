/**
 * Amount and time of an edge, read through its context's `edge_semantics`
 * (investigations F3.1, 03 §2.1). Pure: the trace/path workers import it too.
 */
import type { Edge, EdgeSemantics, EdgeSemanticsByType } from '@/types/graph';

export interface EdgeValue {
  amount: number | null;
  /** Epoch milliseconds. */
  t: number | null;
}

/**
 * `12.34` or `"12.34"` → number; anything else → null. A comma is never read:
 * locale-formatted text goes through a file mapping's `decimal_comma`.
 */
export function parseAmount(raw: unknown, unit: EdgeSemantics['amount_unit'] = 'units'): number | null {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && raw.trim() && !raw.includes(',')) n = Number(raw.trim());
  else return null;
  if (!Number.isFinite(n)) return null;
  return unit === 'cents' ? n / 100 : n;
}

/** ISO date/datetime, epoch seconds or ms → epoch ms; else null (other layouts: a mapping's `date:`). */
export function parseTime(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e11 ? raw * 1000 : raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  if (/^\d+$/.test(s)) return parseTime(Number(s));
  // A bare date is local midnight (Date.parse would read it as UTC and shift the day).
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00` : s);
  return Number.isNaN(t) ? null : t;
}

/** `$1,234.56 · 3/15/2024, 2:05 PM` in the viewer's locale; '' when the edge has neither. */
export function formatEdgeValue({ amount, t }: EdgeValue, currency?: string | null): string {
  const parts: string[] = [];
  if (amount !== null) parts.push(formatAmount(amount, currency));
  if (t !== null) parts.push(new Date(t).toLocaleString());
  return parts.join(' · ');
}

/** With the context's currency when it declares one; a plain number otherwise. */
export function formatAmount(amount: number, currency?: string | null): string {
  if (!currency) return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(amount);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(amount)} ${currency}`;
  }
}

/**
 * An edge tagged at unify time (`__amount`/`__t`, a mixed-context case graph) keeps
 * its tags; otherwise the value is read from its properties by `semantics`.
 */
export function edgeValue(edge: Edge, semantics: EdgeSemantics | null | undefined): EdgeValue {
  if (!semantics) return { amount: edge.__amount ?? null, t: edge.__t ?? null };
  const props = edge.properties ?? {};
  // A generic relation (login, device use) has a weight and a timestamp instead (05 §4b).
  const amountProp = semantics.amount_prop || semantics.weight_prop;
  const timeProp = semantics.time_prop || semantics.timestamp_prop;
  return {
    amount: amountProp ? parseAmount(props[amountProp], semantics.amount_unit) : null,
    t: timeProp ? parseTime(props[timeProp]) : null,
  };
}

/** The semantics for one edge: the case's per-type override (`*` = any type), else its context's. */
export function semanticsFor(
  relationshipType: string,
  byType: EdgeSemanticsByType | null | undefined,
  fallback: EdgeSemantics | null | undefined,
): EdgeSemantics | null | undefined {
  return byType?.[relationshipType] ?? byType?.['*'] ?? fallback;
}

/** Tags for a unified edge from its own context's semantics; nothing when the context declares none. */
export function edgeValueTags(edge: Edge, semantics: EdgeSemantics | null | undefined): Pick<Edge, '__amount' | '__t'> {
  if (!semantics?.amount_prop && !semantics?.time_prop && !semantics?.weight_prop && !semantics?.timestamp_prop) return {};
  const { amount, t } = edgeValue(edge, semantics);
  return { ...(amount !== null ? { __amount: amount } : {}), ...(t !== null ? { __t: t } : {}) };
}
