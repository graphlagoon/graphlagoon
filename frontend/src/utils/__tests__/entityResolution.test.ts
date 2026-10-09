import { describe, it, expect } from 'vitest';
import fixture from '@/__tests__/fixtures/er/matches.json';
import { jaroWinkler, middleSix, normalizeName, suggestMatches } from '@/utils/entityResolution';

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
