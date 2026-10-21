/**
 * Identity-key normalizers (investigations, 03 §2.1, 05 §4b). They turn a node's raw id
 * or property into a value that matches the same real-world entity across
 * contexts; the node's key is `"{entity}:{normalized}"`. Twin of
 * `api/graphlagoon/services/case_graph.py::_normalize`; both are pinned by
 * `__tests__/fixtures/unify/generic-normalizers.json`.
 */
import type { IdentityKey, IdentityNormalize } from '@/types/graph';

/** Normalizers that make a value an entity key; `lower`/`none`/`regex` only clean it. */
export const KEY_NORMALIZERS: IdentityNormalize[] = ['digits', 'account', 'phone', 'email', 'device_id', 'ip', 'card', 'terminal_id', 'address'];

export const NORMALIZER_LABELS: Record<IdentityNormalize, string> = {
  digits: 'Digits only (document, tax or national id)',
  account: 'Account (bank-agency-number)',
  phone: 'Phone',
  email: 'E-mail',
  device_id: 'Device id',
  ip: 'IP address',
  card: 'Card (BIN + last 4)',
  terminal_id: 'Terminal id',
  address: 'Address',
  regex: 'Regex capture',
  lower: 'Lowercase',
  none: 'As is',
};

/** The digits of a document, tax or national id; null when empty or redacted (`***-**-1120`). */
export function normalizeDigits(raw: string): string | null {
  // A redacted value must never become a key: it goes to entity resolution.
  if (raw.includes('*')) return null;
  return raw.replace(/\D/g, '') || null;
}

/** `bank-agency-account`: digit groups, each without leading zeros. */
export function normalizeAccount(raw: string): string | null {
  const parts = raw.split(/\D+/).filter(Boolean).map((p) => p.replace(/^0+(?=\d)/, ''));
  return parts.length ? parts.join('-') : null;
}

/** Digits only: `+1 (415) 555-0100` and `14155550100` are the same phone. */
export function normalizePhone(raw: string): string | null {
  return raw.replace(/\D/g, '') || null;
}

/** Lowercase alphanumerics: `DEV-123 456` and `dev123456` are the same device. */
export function normalizeDeviceId(raw: string): string | null {
  const s = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  return s || null;
}

/** IPv4 without leading zeros per octet; IPv6 lowercased, without brackets or zone. */
export function normalizeIp(raw: string): string | null {
  const s = raw.replace(/^\[|\]$/g, '').split('%')[0].trim();
  if (!s) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const octets = s.split('.').map(Number);
    return octets.some((o) => o > 255) ? null : octets.join('.');
  }
  return s.toLowerCase();
}

/**
 * `BIN*last4`: the leading digits (up to 6) and the last 4, so a tokenized or
 * redacted number (`5311 **** **** 1234`) matches the full one. A case never
 * needs the full PAN: contexts expose it tokenized (06 §2b, PCI).
 */
export function normalizeCard(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, '');
  const first = /^\d+/.exec(s)?.[0] ?? '';
  const last = /\d{4}$/.exec(s)?.[0];
  if (!last || first.length < 4) return null;
  return `${first.slice(0, 6)}*${last}`;
}

/** Uppercase alphanumerics, digit runs without leading zeros: `t-0042` → `T42`. */
export function normalizeTerminalId(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(^|\D)0+(?=\d)/g, '$1');
  return s || null;
}

export function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Accentless lowercase words, punctuation dropped: `12 Main St., Apt. 3` → `12 main st apt 3` (accents stripped too). */
export function normalizeAddress(raw: string): string | null {
  const words = stripAccents(raw).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
  return words.length ? words.join(' ') : null;
}

/** First match of `pattern` (group 1 when it has one), lowercased; null without a match or pattern. */
export function normalizeRegex(raw: string, pattern: string | undefined): string | null {
  if (!pattern) return null;
  let m: RegExpExecArray | null;
  try {
    m = new RegExp(pattern).exec(raw);
  } catch {
    return null;
  }
  if (!m) return null;
  const value = (m[1] ?? m[0]).trim().toLowerCase();
  return value || null;
}

export function normalizeIdentityValue(value: unknown, normalize: IdentityNormalize, pattern?: string): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  switch (normalize) {
    case 'digits':
      return normalizeDigits(raw);
    case 'account':
      return normalizeAccount(raw);
    case 'phone':
      return normalizePhone(raw);
    case 'device_id':
      return normalizeDeviceId(raw);
    case 'ip':
      return normalizeIp(raw);
    case 'card':
      return normalizeCard(raw);
    case 'terminal_id':
      return normalizeTerminalId(raw);
    case 'address':
      return normalizeAddress(raw);
    case 'regex':
      return normalizeRegex(raw, pattern);
    case 'email':
    case 'lower':
      return raw.toLowerCase();
    default:
      return raw;
  }
}

/** The node's identity key under `key`, or null when the value is missing or unusable. */
export function identityKeyOf(
  key: IdentityKey,
  node: { id: string; properties?: Record<string, unknown> },
): string | null {
  const value = key.source === 'node_id' ? node.id : node.properties?.[key.source.name];
  const normalized = normalizeIdentityValue(value, key.normalize, key.pattern);
  return normalized === null ? null : `${key.entity}:${normalized}`;
}

/** Short label for a key: `Person → Holder (prop national_id)`. */
export function describeIdentityKey(key: IdentityKey): string {
  const source = key.source === 'node_id' ? 'node id' : `prop ${key.source.name}`;
  return `${key.entity} → ${key.node_type} (${source})`;
}
