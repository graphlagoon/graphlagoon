import { describe, it, expect } from 'vitest';
import fixture from '@/__tests__/fixtures/trace/flow-chain.json';
import { toTraceEdges, traceForward, type TraceParams } from '@/utils/trace';
import { methodStamp, sankeyLayout, traceColumns, traceFlows } from '@/utils/traceView';
import { computeTraceLayerPositions } from '@/utils/layoutModes';

const edges = toTraceEdges(fixture.edges, fixture.edge_semantics);
const types = Object.fromEntries(fixture.nodes.map(n => [n.node_id, n.node_type]));
const result = traceForward(edges, types, fixture.seed, fixture.params as unknown as TraceParams);
const flows = traceFlows(result, edges);
const cols = traceColumns(result, flows, 'forward');

describe('trace screen model (T5)', () => {
  it('columns: seed, the layers, exits last', () => {
    expect(cols.labels).toEqual(['Seed', 'Layer 1', 'Layer 2', 'Exits']);
    expect([...cols.columns]).toEqual([
      ['0001-9', 0], ['4471-0', 1], ['5520-3', 2], ['8812-7', 2], ['3090-1', 2],
      ['atm-cash', 3], ['exchange-gama', 3], ['bet-delta', 3], // lined up with their payers
    ]);
    // The untraced 300 opening balance is not a flow.
    expect(flows.map(f => f.id)).not.toContain('e1');
  });

  it('sankey: node height = max(in, out), bands conserve the traced value', () => {
    const { nodes, links } = sankeyLayout(flows, cols, { width: 900, height: 340 });
    expect(links).toHaveLength(7);
    const n = Object.fromEntries(nodes.map(x => [x.id, x]));
    expect(n['0001-9'].value).toBe(4870);
    expect(n['8812-7'].value).toBe(1900); // in 1.900, out 1.550 (FIFO)
    expect(n['exchange-gama'].value).toBe(1550);
    expect(n['4471-0'].h / n['0001-9'].h).toBeCloseTo(1, 5);
    expect(n['atm-cash'].x).toBeGreaterThan(n['5520-3'].x);
  });

  it('method stamp lists every parameter', () => {
    const stamp = methodStamp(result.method);
    for (const part of ['forward', '3 layers', 'Δ 24 h', 'min', 'FIFO', 'CashWithdrawal, Exchange, Betting, ExternalBank', 'window', 'seed: e2']) {
      expect(stamp).toContain(part);
    }
  });

  it('trace-layers layout: a column per layer, centered', () => {
    const { positions, extent } = computeTraceLayerPositions(cols.columns, { levelSpacing: 100, nodeSpacing: 50 });
    expect(positions.get('0001-9')).toEqual({ x: 0, y: 0 });
    expect(positions.get('5520-3')).toEqual({ x: 200, y: 50 });
    expect(positions.get('3090-1')).toEqual({ x: 200, y: -50 });
    expect(extent).toEqual({ min: -50, max: 50 });
  });
});
