import { describe, it, expect } from 'vitest';
import fixture from '@/__tests__/fixtures/er/matches.json';
import shared from '@/__tests__/fixtures/er/shared-attributes.json';
import { jaroWinkler, middleSix, normalizeName, sharedAttributeLinks, suggestMatches } from '@/utils/entityResolution';

describe('entity resolution (03 §6.2)', () => {
  it('matches the shared fixture (parity with the Python service)', () => {
    expect(suggestMatches(fixture.nodes)).toEqual(fixture.expected);
  });

  it('blocks on the 6 central digits and needs a masked side', () => {
    expect(middleSix('123.418.207-90')).toEqual(['418207', false]);
    expect(middleSix('***.418.207-**')).toEqual(['418207', true]);
    expect(middleSix('**.345.678/****-**')).toBeNull(); // CNPJ
    const full = (uid: string, cpf: string) => ({ uid, properties: { nome: 'Ana Lima', cpf, cep: '01001-000' } });
    // Two full documents with the same central digits: identity keys decide, never a suggestion.
    expect(suggestMatches([full('a', '11141820722'), full('b', '99941820711')])).toEqual([]);
    expect(suggestMatches([full('a', '11141820722'), full('b', '•••.418.207-••')])).toHaveLength(1);
  });

  it('Jaro-Winkler and name normalization', () => {
    expect(normalizeName('Maria  da Conceição E Souza')).toBe('MARIA CONCEICAO SOUZA');
    expect(jaroWinkler('MARTHA', 'MARHTA')).toBeCloseTo(0.9611, 4);
    expect(jaroWinkler('DWAYNE', 'DUANE')).toBeCloseTo(0.84, 2);
    expect(jaroWinkler('', 'X')).toBe(0);
  });
});

describe('shared attributes (05 §4b, Vínculos)', () => {
  it('matches the shared fixture (parity with the Python service)', () => {
    const p = shared.params;
    expect(sharedAttributeLinks(shared.graph as any, p)).toEqual(shared.expected);
  });

  it('a common value above maxEntities never links; minShared 1 links by a single attribute', () => {
    const { pairs } = sharedAttributeLinks(shared.graph as any, { attributes: ['ip'], minShared: 1, maxEntities: 3 });
    expect(pairs).toEqual([]);
    const one = sharedAttributeLinks(shared.graph as any, { attributes: ['ip'], minShared: 1 });
    expect(one.pairs).toHaveLength(6); // 4 entities share the carrier IP
    expect(one.edges[0]).toMatchObject({ type: 'compartilha_ip', properties: { shared_by: 4 } });
  });
});
