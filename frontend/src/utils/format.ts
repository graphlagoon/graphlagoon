/**
 * Formatting for the case screens (05 §3 "Readability"): dates as
 * `dd/mm/yyyy HH:mm`, money as `$1,234.56`, relative times as "2 h ago".
 * Hand-rolled so the output does not depend on the browser's ICU data.
 */

type DateInput = string | number | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const two = (n: number) => String(n).padStart(2, '0');

/** `dd/mm/yyyy HH:mm` (local time); `{ time: false }` gives `dd/mm/yyyy`. Empty for a missing or invalid date. */
export function formatDate(value: DateInput, options: { time?: boolean } = {}): string {
  const d = toDate(value);
  if (!d) return '';
  const day = `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`;
  return options.time === false ? day : `${day} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** `$1,234.56`; negative amounts as `-$1.00`. Empty for a non-number. */
export function formatMoney(value: number | string | null | undefined, options: { decimals?: number } = {}): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  const decimals = options.decimals ?? 2;
  const fixed = Math.abs(n).toFixed(decimals);
  const [int, frac] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '-' : ''}$${grouped}${frac ? `.${frac}` : ''}`;
}

/** "just now", "5 min ago", "2 h ago", "3 d ago"; beyond 30 days the absolute date. Empty for a missing date. */
export function formatRelative(value: DateInput, now: DateInput = new Date()): string {
  const d = toDate(value);
  const ref = toDate(now);
  if (!d || !ref) return '';
  const seconds = Math.round((ref.getTime() - d.getTime()) / 1000);
  if (seconds < 0) return formatDate(d);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days} d ago`;
  return formatDate(d, { time: false });
}

/** "3 items" / "1 item": the plural with the count in front. */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}
