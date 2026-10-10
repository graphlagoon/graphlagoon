/**
 * Identity-key normalizers (investigations, 03 §2.1, 05 §4b). They turn a node's raw id
 * or property into a value that matches the same real-world entity across
 * contexts; the node's key is `"{entity}:{normalized}"`. Twin of
 * `api/graphlagoon/services/case_graph.py::_normalize`; both are pinned by
 * `__tests__/fixtures/unify/generic-normalizers.json`.
 */
import type { IdentityKey, IdentityNormalize } from '@/types/graph';

/** Normalizers that make a value an entity key; `lower`/`none`/`regex` only clean it. */
export const KEY_NORMALIZERS: IdentityNormalize[] = ['cpf_cnpj', 'account', 'phone', 'email', 'device_id', 'ip', 'pix_key', 'card', 'terminal_id', 'address'];

export const NORMALIZER_LABELS: Record<IdentityNormalize, string> = {
  cpf_cnpj: 'CPF/CNPJ',
  account: 'Account (bank-agency-number)',
  phone: 'Phone',
  email: 'E-mail',
  device_id: 'Device id',
  ip: 'IP address',
  pix_key: 'Pix key (detects the type)',
  card: 'Card (BIN + last 4)',
  terminal_id: 'Terminal id',
  address: 'Address',
  regex: 'Regex capture',
  lower: 'Lowercase',
  none: 'As is',
};

/** CPF (11) or CNPJ (14) digits, zero-padded; null when masked or not a document. */
export function normalizeCpfCnpj(raw: string): string | null {
  // A masked document (***.418.207-**) must never become a key: it goes to entity resolution.
  if (/[*xX]/.test(raw)) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits || digits.length > 14) return null;
  // Numeric columns drop leading zeros; pad back to the document length.
  return digits.padStart(digits.length <= 11 ? 11 : 14, '0');
}

/** `bank-agency-account`: digit groups, each without leading zeros. */
export function normalizeAccount(raw: string): string | null {
  const parts = raw.split(/\D+/).filter(Boolean).map((p) => p.replace(/^0+(?=\d)/, ''));
  return parts.length ? parts.join('-') : null;
}

/** Digits only, without the Brazilian country code. */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.length > 11 && digits.startsWith('55')) digits = digits.slice(2);
  return digits || null;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `email:…`, `phone:…`, `cpf:…`, `cnpj:…` or `evp:…` by the shape of the key (a phone key starts with `+`). */
export function normalizePixKey(raw: string): string | null {
  const s = raw.trim();
  if (s.includes('@')) return `email:${s.toLowerCase()}`;
  if (UUID.test(s)) return `evp:${s.toLowerCase()}`;
  if (s.startsWith('+')) {
    const phone = normalizePhone(s);
    return phone ? `phone:${phone}` : null;
  }
  const doc = normalizeCpfCnpj(s);
  if (!doc) return null;
  return doc.length === 11 ? `cpf:${doc}` : `cnpj:${doc}`;
}

/**
 * `BIN*last4`: the leading digits (up to 6) and the last 4. shortcut: a masked
 * number (`5311 **** **** 1234`) keeps only the 4 digits it shows, so it does not
 * match the full PAN; fine until unmasked card data enters a case.
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

const ADDRESS_WORDS: Record<string, string> = {
  r: 'rua',
  av: 'avenida',
  al: 'alameda',
  tv: 'travessa',
  apto: 'ap',
  apartamento: 'ap',
  bl: 'bloco',
  cj: 'conj',
  conjunto: 'conj',
  n: '',
  no: '',
  numero: '',
  de: '',
  da: '',
  do: '',
  das: '',
  dos: '',
};

export function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Accentless lowercase words, abbreviations expanded, connectives and "nº" dropped. */
export function normalizeAddress(raw: string): string | null {
  const words = stripAccents(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => (w in ADDRESS_WORDS ? ADDRESS_WORDS[w] : w))
    .filter(Boolean);
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
    case 'cpf_cnpj':
      return normalizeCpfCnpj(raw);
    case 'account':
      return normalizeAccount(raw);
    case 'phone':
      return normalizePhone(raw);
    case 'device_id':
      return normalizeDeviceId(raw);
    case 'ip':
      return normalizeIp(raw);
    case 'pix_key':
      return normalizePixKey(raw);
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

/** Short label for a key: `Pessoa → CPF (prop titular_cpf)`. */
export function describeIdentityKey(key: IdentityKey): string {
  const source = key.source === 'node_id' ? 'node id' : `prop ${key.source.name}`;
  return `${key.entity} → ${key.node_type} (${source})`;
}
