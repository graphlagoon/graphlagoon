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
