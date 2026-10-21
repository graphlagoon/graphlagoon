/**
 * A case type's fields (06 §1) on screen: the value as text, and the value an
 * input gives back. The server validates them (`services/case_types.py`).
 */
import type { CaseTypeField } from '@/types/investigation';

/** "84,000.00", "2026-10-01", "5999" or "—". */
export function fieldText(field: Pick<CaseTypeField, 'type'>, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if ((field.type === 'money' || field.type === 'number') && typeof value === 'number') {
    return new Intl.NumberFormat(undefined, field.type === 'money' ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {}).format(value);
  }
  return String(value);
}

/** What an input's text becomes for the API: numbers as numbers, empty as null (a PATCH removes it). */
export function fieldInput(field: Pick<CaseTypeField, 'type'>, text: string): string | number | null {
  const t = text.trim();
  if (!t) return null;
  if (field.type === 'money' || field.type === 'number') {
    const n = Number(t);
    return Number.isFinite(n) ? n : t;
  }
  return t;
}
