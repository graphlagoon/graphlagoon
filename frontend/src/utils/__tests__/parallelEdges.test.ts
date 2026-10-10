import { describe, it, expect } from 'vitest';
import type { Edge } from '@/types/graph';
import { aggregateParallelEdges, drawnAmount } from '@/utils/parallelEdges';
import { edgeValue } from '@/utils/edgeSemantics';
import { AMOUNT_MAX_WIDTH, amountWidth, computeLinkAppearance, type AppearanceContext } from '@/utils/graphAppearance';

const pix = (id: string, src: string, dst: string, valor: number, data: string, type = 'PIX'): Edge => ({
  edge_id: id,
  src,
  dst,
  relationship_type: type,
  properties: { valor, data },
});
const valueOf = (e: Edge) => edgeValue(e, { amount_prop: 'valor', time_prop: 'data' });

describe('aggregateParallelEdges', () => {
  const edges = [
    pix('e1', 'a', 'b', 100, '2024-03-15T10:00'),
    pix('e2', 'a', 'b', 250, '2024-03-15T09:00'),
    pix('e3', 'b', 'a', 40, '2024-03-15T11:00'), // opposite direction: its own group
    pix('e4', 'a', 'b', 5, '2024-03-16T08:00', 'TED'), // other type: its own group
    pix('e5', 'a', 'b', 50, '2024-03-15T12:00'),
  ];
  const out = aggregateParallelEdges(edges, valueOf);

  it('groups by (src, dst, type) with sum, count and first and last time', () => {
    expect(out.map((e) => e.edge_id)).toEqual(['e1', 'e3', 'e4']);
    expect(out[0].__agg).toEqual({
      count: 3,
      sum: 400,
      first: new Date(2024, 2, 15, 9).getTime(),
      last: new Date(2024, 2, 15, 12).getTime(),
      edgeIds: ['e1', 'e2', 'e5'],
    });
    expect(out[1].__agg).toBeUndefined();
    expect(drawnAmount(out[0], valueOf)).toBe(400);
    expect(drawnAmount(out[1], valueOf)).toBe(40);
  });

  it('is display only: the input edges are untouched', () => {
    expect(edges[0].__agg).toBeUndefined();
    expect(edges).toHaveLength(5);
  });
});

describe('width by amount', () => {
  it('is proportional to the amount, with a floor', () => {
    expect(amountWidth(400, 400)).toBe(AMOUNT_MAX_WIDTH);
    expect(amountWidth(200, 400)).toBe(AMOUNT_MAX_WIDTH / 2);
    expect(amountWidth(-200, 400)).toBe(AMOUNT_MAX_WIDTH / 2);
    expect(amountWidth(0, 400)).toBeGreaterThan(0);
  });

  it('sets the link width from the edge amount unless a weight metric is chosen', () => {
    const ctx = {
      hasEdgeTypeFilter: false,
      edgeTypeFilterSet: new Set(),
      tableVisibleEdgeIds: null,
      getEdgeTypeColor: () => '#888888',
      focusedNodeIds: null,
      hubNodeIds: null,
      edgeLensMode: 'off',
      edgeLensDimOpacity: 0.1,
      degreeDimOpacity: 0.1,
      edgeOpacity: 1,
      edgeWeightMetric: null,
      edgeAmounts: { values: new Map([['e1', 100]]), max: 400 },
    } as unknown as AppearanceContext;
    expect(computeLinkAppearance('e1', 'PIX', 'a', 'b', new Set(), ctx).width).toBe(2);
    expect(computeLinkAppearance('e9', 'PIX', 'a', 'b', new Set(), ctx).width).toBeNull();
  });
});
