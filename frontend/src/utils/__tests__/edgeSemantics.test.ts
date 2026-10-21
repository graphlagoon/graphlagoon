import { describe, it, expect } from 'vitest';
import { edgeValue, parseAmount, parseTime } from '@/utils/edgeSemantics';
import { unifyGraph, type UnifySource } from '@/utils/unifyGraph';

describe('edge semantics', () => {
  it('parses amounts in units and cents; locale-formatted text is not guessed', () => {
    expect(parseAmount(12.5)).toBe(12.5);
    expect(parseAmount('1.234,56')).toBeNull(); // a file mapping's decimal_comma reads it
    expect(parseAmount('1234.56')).toBe(1234.56);
    expect(parseAmount('123456', 'cents')).toBe(1234.56);
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });

  it('parses times as epoch ms; a bare date is local midnight', () => {
    expect(parseTime('2024-03-15')).toBe(new Date(2024, 2, 15).getTime());
    expect(parseTime('2024-03-15T14:05')).toBe(new Date(2024, 2, 15, 14, 5).getTime());
    expect(parseTime('15/03/2024 14:05')).toBeNull(); // a file mapping's date: converter reads it
    expect(parseTime(1710511500)).toBe(1710511500000);
    expect(parseTime('1710511500000')).toBe(1710511500000);
    expect(parseTime('yesterday')).toBeNull();
  });

  it('reads an edge by its context semantics', () => {
    const e = { edge_id: 'e', src: 'a', dst: 'b', relationship_type: 'TRANSFER', properties: { amount: '50000', at: '2024-03-15' } };
    expect(edgeValue(e, { amount_prop: 'amount', amount_unit: 'cents', time_prop: 'at' })).toEqual({
      amount: 500,
      t: new Date(2024, 2, 15).getTime(),
    });
    expect(edgeValue(e, {})).toEqual({ amount: null, t: null });
  });

  it('tags each unified edge with its own context semantics', () => {
    const src = (id: string, contextId: string, properties: Record<string, unknown>): UnifySource => ({
      id,
      contextId,
      nodes: [
        { node_id: 'a', node_type: 'Conta' },
        { node_id: 'b', node_type: 'Conta' },
      ],
      edges: [{ edge_id: 'e1', src: 'a', dst: 'b', relationship_type: 'TRANSFER', properties }],
    });
    const g = unifyGraph(
      [src('s1', 'c1', { amount: 10, at: '2024-03-15' }), src('s2', 'c2', { amount_cents: 2500 }), src('s3', 'c3', { amount: 7 })],
      {
        c1: { edge_semantics: { amount_prop: 'amount', time_prop: 'at' } },
        c2: { edge_semantics: { amount_prop: 'amount_cents', amount_unit: 'cents' } },
        c3: {},
      },
    );
    expect(g.edges.map((e) => edgeValue(e, null))).toEqual([
      { amount: 10, t: new Date(2024, 2, 15).getTime() },
      { amount: 25, t: null },
      { amount: null, t: null },
    ]);
  });
});
