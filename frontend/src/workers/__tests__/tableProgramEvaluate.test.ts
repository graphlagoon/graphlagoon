import { describe, it, expect } from 'vitest';
import fixture from '@/utils/__tests__/fixtures/canvasTable.json';
import { evaluateTableProgram, type TableProgramSnapshot } from '../tableProgramEvaluate';
import { toTable } from '@/utils/canvasTable';

const snapshot = (over: Partial<TableProgramSnapshot> = {}): TableProgramSnapshot => ({
  ...(fixture.graph as Pick<TableProgramSnapshot, 'nodes' | 'edges'>),
  item: { type: 'node', node_id: 'co', node_type: 'Company' },
  params: { min_amount: '1000' },
  selectedNodeIds: ['co'],
  metrics: [{ id: 'm1', name: 'pagerank', target: 'node', valueType: 'number', values: [['a2', 0.9]] }],
  ...over,
});

describe('evaluateTableProgram', () => {
  it('sees the clicked item, params and the graph helpers', () => {
    const code = `
      const ids = hops(item.node_id, 2, { edgeTypes: ['OWNS', 'PARTNER_OF'] }).map(n => n.node_id);
      return edgesOf(ids, { types: ['TRANSFER'] })
        .filter(e => Number(e.properties.amount) >= Number(params.min_amount))
        .map(e => ({ src: e.src, dst: e.dst, amount: e.properties.amount, pr: metric('pagerank', e.src) }));
    `;
    expect(toTable(evaluateTableProgram(code, snapshot()))).toEqual({
      columns: ['src', 'dst', 'amount', 'pr'],
      rows: [['a2', 'x', '5000', '0.9']],
      truncated: false,
    });
  });

  it('exposes nodes, edges, node(), neighbors(), selectedNodeIds and metrics', () => {
    const code = 'return [{ n: nodes.length, e: edges.length, name: node("co").properties.name, nb: neighbors("p1").length, sel: selectedNodeIds[0], m: metrics[0].name }]';
    expect(evaluateTableProgram(code, snapshot())).toEqual([{ n: 6, e: 6, name: 'ACME', nb: 2, sel: 'co', m: 'pagerank' }]);
  });

  it('throws what the code throws, and compile errors', () => {
    expect(() => evaluateTableProgram('throw new Error("boom")', snapshot())).toThrow('boom');
    expect(() => evaluateTableProgram('return (', snapshot())).toThrow();
  });
});
