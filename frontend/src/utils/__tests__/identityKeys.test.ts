import { describe, it, expect } from 'vitest';
import { identityKeyOf, normalizeIdentityValue } from '../identityKeys';

describe('identity-key normalizers', () => {
  it('digits: a formatted and a bare document agree', () => {
    expect(normalizeIdentityValue('078-05-1120', 'digits')).toBe('078051120');
    expect(normalizeIdentityValue('078051120', 'digits')).toBe('078051120');
    expect(normalizeIdentityValue('12.345.678/0001-95', 'digits')).toBe('12345678000195');
  });

  it('digits: a redacted value never becomes a key', () => {
    expect(normalizeIdentityValue('***-**-1120', 'digits')).toBeNull();
    expect(normalizeIdentityValue('no digits', 'digits')).toBeNull();
  });

  it('account: leading zeros dropped in each part', () => {
    expect(normalizeIdentityValue('001-0123-0004471-0', 'account')).toBe('1-123-4471-0');
    expect(normalizeIdentityValue('1 / 123 / 4471-0', 'account')).toBe('1-123-4471-0');
    expect(normalizeIdentityValue('000', 'account')).toBe('0');
  });

  it('phone, email and empty values', () => {
    expect(normalizeIdentityValue('+1 (415) 555-0100', 'phone')).toBe('14155550100');
    expect(normalizeIdentityValue(' Ana@X.com ', 'email')).toBe('ana@x.com');
    expect(normalizeIdentityValue('', 'none')).toBeNull();
  });

  it('builds the entity-prefixed key from a property or the node id', () => {
    const node = { id: '7', properties: { national_id: '078-05-1120' } };
    expect(
      identityKeyOf(
        { node_type: 'P', entity: 'Person', source: { kind: 'prop', name: 'national_id' }, normalize: 'digits' },
        node,
      ),
    ).toBe('Person:078051120');
    expect(identityKeyOf({ node_type: 'P', entity: 'X', source: 'node_id', normalize: 'none' }, node)).toBe('X:7');
  });
});

describe('generic normalizers (05 §4b)', () => {
  it('device, ip, terminal and address clean punctuation, zeros, case and accents', () => {
    expect(normalizeIdentityValue('DEV-123 456', 'device_id')).toBe('dev123456');
    expect(normalizeIdentityValue('177.010.001.009', 'ip')).toBe('177.10.1.9');
    expect(normalizeIdentityValue('[fe80::1%eth0]', 'ip')).toBe('fe80::1');
    expect(normalizeIdentityValue('300.1.1.1', 'ip')).toBeNull();
    expect(normalizeIdentityValue('t-0042', 'terminal_id')).toBe('T42');
    expect(normalizeIdentityValue('12 Café St., Apt. 31', 'address')).toBe('12 cafe st apt 31');
  });

  it('card keeps BIN and last 4; a redacted card only its visible digits', () => {
    expect(normalizeIdentityValue('5311 2233 4455 1234', 'card')).toBe('531122*1234');
    expect(normalizeIdentityValue('5311 **** **** 1234', 'card')).toBe('5311*1234');
  });

  it('regex captures group 1 lowercased; no match, no pattern or a bad pattern give no key', () => {
    expect(normalizeIdentityValue('sid=AbC12 x', 'regex', 'sid=([A-Za-z0-9]+)')).toBe('abc12');
    expect(normalizeIdentityValue('nothing', 'regex', 'sid=([A-Za-z0-9]+)')).toBeNull();
    expect(normalizeIdentityValue('x', 'regex')).toBeNull();
    expect(normalizeIdentityValue('x', 'regex', '(')).toBeNull();
    expect(identityKeyOf({ node_type: 'Login', entity: 'Session', source: { kind: 'prop', name: 'ua' }, normalize: 'regex', pattern: 'sid=(\\w+)' }, { id: 'l1', properties: { ua: 'sid=Z9' } })).toBe('Session:z9');
  });
});
