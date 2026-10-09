import { describe, it, expect } from 'vitest';
import { mergedEntityCounts, unifyGraph, type UnifySource } from '@/utils/unifyGraph';
import type { IdentityKey } from '@/types/graph';

const cpfKey = (node_type: string, prop: string): IdentityKey => ({
  node_type,
  entity: 'Pessoa',
  source: { kind: 'prop', name: prop },
  normalize: 'cpf_cnpj',
});

const pix: UnifySource = {
  id: 's-pix',
  contextId: 'c-pix',
  nodes: [
    { node_id: 'p1', node_type: 'Titular', properties: { cpf: '123.456.789-01', nome: 'Ana R.' } },
    { node_id: 'a1', node_type: 'Conta', properties: {} },
  ],
  edges: [{ edge_id: 'e1', src: 'p1', dst: 'a1', relationship_type: 'TITULAR' }],
};
const cadastro: UnifySource = {
  id: 's-cad',
  contextId: 'c-cad',
  nodes: [
    { node_id: '9', node_type: 'Cliente', properties: { doc: 12345678901, nome: 'Ana Ribeiro', renda: 1800 } },
    { node_id: 'a1', node_type: 'Conta', properties: {} },
    { node_id: 'm1', node_type: 'Cliente', properties: { doc: '***.418.207-**' } },
  ],
  edges: [
    { edge_id: 'e1', src: '9', dst: 'a1', relationship_type: 'POSSUI' },
    { edge_id: 'dangling', src: '9', dst: 'nowhere', relationship_type: 'X' },
  ],
};
const contexts = {
  'c-pix': { identity_keys: [cpfKey('Titular', 'cpf')] },
  'c-cad': { identity_keys: [cpfKey('Cliente', 'doc')] },
};

describe('unifyGraph', () => {
  const g = unifyGraph([pix, cadastro], contexts);
  const byId = new Map(g.nodes.map((n) => [n.node_id, n]));

  it('merges nodes sharing an identity key into one, with both sources', () => {
    const ana = byId.get('Pessoa:12345678901')!;
    expect(ana.__sources.map((o) => o.sourceId)).toEqual(['s-pix', 's-cad']);
    expect(ana.__entity).toBe('Pessoa');
    expect(mergedEntityCounts(g.nodes)).toEqual({ Pessoa: 1 });
  });

  it('keeps the first value on a property or type conflict and records the loser', () => {
    const ana = byId.get('Pessoa:12345678901')!;
    expect(ana.properties!.nome).toBe('Ana R.');
    expect(ana.properties!.renda).toBe(1800); // filled from the second source
    expect(ana.__conflicts!.nome).toEqual([{ value: 'Ana Ribeiro', sourceId: 's-cad' }]);
    expect(ana.__conflicts!.node_type).toEqual([{ value: 'Cliente', sourceId: 's-cad' }]);
  });

  it('falls back to a per-context uid without a key (and never keys a masked document)', () => {
    expect(byId.has('a1@c-pix')).toBe(true);
    expect(byId.has('a1@c-cad')).toBe(true); // same raw id, different contexts: not merged
    expect(byId.get('m1@c-cad')!.__entity).toBeUndefined();
  });

  it('never merges edges across sources and drops dangling ones', () => {
    expect(g.edges.map((e) => [e.edge_id, e.src, e.dst, e.__source])).toEqual([
      ['s-pix:e1', 'Pessoa:12345678901', 'a1@c-pix', 's-pix'],
      ['s-cad:e1', 'Pessoa:12345678901', 'a1@c-cad', 's-cad'],
    ]);
  });
});
