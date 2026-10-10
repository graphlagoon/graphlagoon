import { describe, it, expect } from 'vitest';
import { identityKeyOf, normalizeIdentityValue } from '../identityKeys';

describe('identity-key normalizers', () => {
  it('cpf_cnpj: formatted and bare CPF agree, numeric zeros are restored', () => {
    expect(normalizeIdentityValue('012.345.678-90', 'cpf_cnpj')).toBe('01234567890');
    expect(normalizeIdentityValue('01234567890', 'cpf_cnpj')).toBe('01234567890');
    expect(normalizeIdentityValue(1234567890, 'cpf_cnpj')).toBe('01234567890');
  });

  it('cpf_cnpj: CNPJ keeps 14 digits; masked documents never become keys', () => {
    expect(normalizeIdentityValue('12.345.678/0001-95', 'cpf_cnpj')).toBe('12345678000195');
    expect(normalizeIdentityValue('***.418.207-**', 'cpf_cnpj')).toBeNull();
  });

  it('account: leading zeros dropped in each part', () => {
    expect(normalizeIdentityValue('001-0123-0004471-0', 'account')).toBe('1-123-4471-0');
    expect(normalizeIdentityValue('1 / 123 / 4471-0', 'account')).toBe('1-123-4471-0');
    expect(normalizeIdentityValue('000', 'account')).toBe('0');
  });

  it('phone, email and empty values', () => {
    expect(normalizeIdentityValue('+55 (11) 98765-4321', 'phone')).toBe('11987654321');
    expect(normalizeIdentityValue(' Ana@X.com ', 'email')).toBe('ana@x.com');
    expect(normalizeIdentityValue('', 'none')).toBeNull();
  });

  it('builds the entity-prefixed key from a property or the node id', () => {
    const node = { id: '7', properties: { titular_cpf: '012.345.678-90' } };
    expect(
      identityKeyOf(
        { node_type: 'P', entity: 'Pessoa', source: { kind: 'prop', name: 'titular_cpf' }, normalize: 'cpf_cnpj' },
        node,
      ),
    ).toBe('Pessoa:01234567890');
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
    expect(normalizeIdentityValue('R. Acácias, nº 120, apto 31', 'address')).toBe('rua acacias 120 ap 31');
  });

  it('pix key detects its type; card keeps BIN and last 4; a masked card only its visible digits', () => {
    expect(normalizeIdentityValue('Ana.R@Example.com', 'pix_key')).toBe('email:ana.r@example.com');
    expect(normalizeIdentityValue('+55 11 98765-4321', 'pix_key')).toBe('phone:11987654321');
    expect(normalizeIdentityValue('123.456.789-01', 'pix_key')).toBe('cpf:12345678901');
    expect(normalizeIdentityValue('12.345.678/0001-95', 'pix_key')).toBe('cnpj:12345678000195');
    expect(normalizeIdentityValue('123e4567-e89b-12d3-a456-426614174000', 'pix_key')).toBe('evp:123e4567-e89b-12d3-a456-426614174000');
    expect(normalizeIdentityValue('???', 'pix_key')).toBeNull();
    expect(normalizeIdentityValue('5311 2233 4455 1234', 'card')).toBe('531122*1234');
    expect(normalizeIdentityValue('5311 **** **** 1234', 'card')).toBe('5311*1234');
  });

  it('regex captures group 1 lowercased; no match, no pattern or a bad pattern give no key', () => {
    expect(normalizeIdentityValue('sid=AbC12 x', 'regex', 'sid=([A-Za-z0-9]+)')).toBe('abc12');
    expect(normalizeIdentityValue('nothing', 'regex', 'sid=([A-Za-z0-9]+)')).toBeNull();
    expect(normalizeIdentityValue('x', 'regex')).toBeNull();
    expect(normalizeIdentityValue('x', 'regex', '(')).toBeNull();
    expect(identityKeyOf({ node_type: 'Login', entity: 'Sessao', source: { kind: 'prop', name: 'ua' }, normalize: 'regex', pattern: 'sid=(\\w+)' }, { id: 'l1', properties: { ua: 'sid=Z9' } })).toBe('Sessao:z9');
  });
});
