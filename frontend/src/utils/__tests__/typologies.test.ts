import { describe, it, expect } from 'vitest';
import fixture from '@/__tests__/fixtures/typologies/small.json';
import { runTypologies, TYPOLOGIES, type TypologyGraph } from '@/utils/typologies';

const graph: TypologyGraph = {
  nodes: fixture.nodes,
  edges: fixture.edges.map((e) => ({ ...e, t: e.t === null ? null : Date.parse(e.t) })),
};
const run = (g: TypologyGraph = graph) =>
  Object.fromEntries(runTypologies(g, fixture.params).map((r) => [r.id, r.hits]));

describe('typologies (03 §6.4)', () => {
  it('matches every fixture hit (parity with the Python mirror)', () => {
    const got = run();
    for (const t of TYPOLOGIES) expect(got[t.id], t.id).toEqual((fixture.expected as Record<string, unknown>)[t.id]);
  });

  it('every badge cites a CC 4.001 item', () => {
    for (const t of TYPOLOGIES) expect(t.normRef).toMatch(/^CC 4\.001 /);
  });

  it('does not depend on the input order', () => {
    expect(run({ nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() })).toEqual(run());
  });

  it('defaults apply when no params are given, and `only` filters', () => {
    const [r] = runTypologies(graph, {}, ['concentracao_entradas']);
    expect(r.params).toEqual({ minDistinct: 10, windowDays: 7 });
    expect(r.hits).toEqual([]);
  });

  it('a cycle out of time order is not a cycle', () => {
    const edges = graph.edges.map((e) => (e.id === 'c2' ? { ...e, t: Date.parse('2026-09-03T09:00:00-03:00') } : e));
    expect(run({ nodes: graph.nodes, edges }).ciclo_temporal.map((h) => h.nodeId)).toEqual(['U']);
  });
});
