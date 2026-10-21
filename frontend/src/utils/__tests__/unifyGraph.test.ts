import { describe, it, expect } from 'vitest';
import { mergedEntityCounts, unifyGraph, type UnifySource } from '@/utils/unifyGraph';
import type { IdentityKey } from '@/types/graph';

const docKey = (node_type: string, prop: string): IdentityKey => ({
  node_type,
  entity: 'Person',
  source: { kind: 'prop', name: prop },
  normalize: 'digits',
});

const bank: UnifySource = {
  id: 's-bank',
  contextId: 'c-bank',
  nodes: [
    { node_id: 'p1', node_type: 'Holder', properties: { national_id: '123.456.789-01', name: 'Ana R.' } },
    { node_id: 'a1', node_type: 'Account', properties: {} },
  ],
  edges: [{ edge_id: 'e1', src: 'p1', dst: 'a1', relationship_type: 'HOLDS' }],
};
const crm: UnifySource = {
  id: 's-crm',
  contextId: 'c-crm',
  nodes: [
    { node_id: '9', node_type: 'Customer', properties: { doc: 12345678901, name: 'Ana Ribeiro', income: 1800 } },
    { node_id: 'a1', node_type: 'Account', properties: {} },
    { node_id: 'm1', node_type: 'Customer', properties: { doc: '***.418.207-**' } },
  ],
  edges: [
    { edge_id: 'e1', src: '9', dst: 'a1', relationship_type: 'OWNS' },
    { edge_id: 'dangling', src: '9', dst: 'nowhere', relationship_type: 'X' },
  ],
};
const contexts = {
  'c-bank': { identity_keys: [docKey('Holder', 'national_id')] },
  'c-crm': { identity_keys: [docKey('Customer', 'doc')] },
};

describe('unifyGraph', () => {
  const g = unifyGraph([bank, crm], contexts);
  const byId = new Map(g.nodes.map((n) => [n.node_id, n]));

  it('merges nodes sharing an identity key into one, with both sources', () => {
    const ana = byId.get('Person:12345678901')!;
    expect(ana.__sources.map((o) => o.sourceId)).toEqual(['s-bank', 's-crm']);
    expect(ana.__entity).toBe('Person');
    expect(mergedEntityCounts(g.nodes)).toEqual({ Person: 1 });
  });

  it('keeps the first value on a property or type conflict and records the loser', () => {
    const ana = byId.get('Person:12345678901')!;
    expect(ana.properties!.name).toBe('Ana R.');
    expect(ana.properties!.income).toBe(1800); // filled from the second source
    expect(ana.__conflicts!.name).toEqual([{ value: 'Ana Ribeiro', sourceId: 's-crm' }]);
    expect(ana.__conflicts!.node_type).toEqual([{ value: 'Customer', sourceId: 's-crm' }]);
  });

  it('falls back to a per-context uid without a key (and never keys a redacted value)', () => {
    expect(byId.has('a1@c-bank')).toBe(true);
    expect(byId.has('a1@c-crm')).toBe(true); // same raw id, different contexts: not merged
    expect(byId.get('m1@c-crm')!.__entity).toBeUndefined();
  });

  it('never merges edges across sources and drops dangling ones', () => {
    expect(g.edges.map((e) => [e.edge_id, e.src, e.dst, e.__source])).toEqual([
      ['s-bank:e1', 'Person:12345678901', 'a1@c-bank', 's-bank'],
      ['s-crm:e1', 'Person:12345678901', 'a1@c-crm', 's-crm'],
    ]);
  });
});
