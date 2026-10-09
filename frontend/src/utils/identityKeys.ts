/**
 * Identity-key normalizers (investigations, 03 §2.1). They turn a node's raw id
 * or property into a value that matches the same real-world entity across
 * contexts; the node's key is `"{entity}:{normalized}"`.
 */
import type { IdentityKey, IdentityNormalize } from '@/types/graph';

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

export function normalizeIdentityValue(
  value: unknown,
  normalize: IdentityNormalize,
): string | null {
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
  const normalized = normalizeIdentityValue(value, key.normalize);
  return normalized === null ? null : `${key.entity}:${normalized}`;
}

/** Short label for a key: `Pessoa → CPF (prop titular_cpf)`. */
export function describeIdentityKey(key: IdentityKey): string {
  const source = key.source === 'node_id' ? 'node id' : `prop ${key.source.name}`;
  return `${key.entity} → ${key.node_type} (${source})`;
}
