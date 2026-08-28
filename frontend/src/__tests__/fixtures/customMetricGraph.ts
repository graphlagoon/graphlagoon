/**
 * Deterministic small graph for the custom-metric example tests.
 *
 * Degrees (src+dst count, matching graphStore.nodeDegrees):
 *   p1 4 · p2 4 · p3 2 · c1 3 · c2 2 · c3 1 · hub 6 · iso 0   (Σ = 22 = 2E, E = 11)
 * Triangles: (p1, p2, hub) and (p1, c1, p2) and (p1, c1, hub) and (p2, c1, hub)
 *   → clustering(p1) = clustering(p2) = 1, clustering(c3) = 0, clustering(hub) = 4/15
 * Reciprocal pair: e3 (p1→p2) and e4 (p2→p1)
 * Communities: {p1, p2, hub, c1} = 0, {p3, c2} = 1, {c3} = 2, iso = none
 */
import type { CustomMetricSnapshot } from '@/types/customMetrics';

/** "Now" the date examples are evaluated against (use vi.setSystemTime). */
export const FIXTURE_NOW = new Date('2026-08-28T12:00:00Z');

const daysAgo = (d: number) => new Date(FIXTURE_NOW.getTime() - d * 864e5).toISOString();

export const PAGERANK_NAME = 'PageRank (12:00:00)';

export function makeCustomMetricSnapshot(): CustomMetricSnapshot {
  const nodes = [
    {
      id: 'p1',
      type: 'Person',
      properties: {
        name: 'Ana Silva',
        first_name: '  ana   ',
        last_name: 'silva',
        email: 'A@Foo.COM',
        state: 'SP',
        revenue: 100,
        employees: 0,
        created_at: daysAgo(10),
        meta: '{"country":"BR"}',
        website: 'https://portal.x.gov.br',
      },
    },
    {
      id: 'p2',
      type: 'Person',
      properties: {
        name: 'Bruno Costa',
        first_name: 'bruno',
        last_name: 'costa',
        email: 'bruno@bar.org',
        state: 'RJ',
        revenue: 50,
        employees: 5,
        created_at: daysAgo(100),
        meta: 'not json',
      },
    },
    {
      id: 'p3',
      type: 'Person',
      properties: {
        name: 'x',
        state: 'SP',
        revenue: 300,
        employees: 10,
        created_at: daysAgo(730),
        website: 'http://y.com',
      },
    },
    {
      id: 'c1',
      type: 'Company',
      properties: { name: 'ACME LTDA', cnpj: '12.345.678/0001-95', state: 'SP', revenue: 1000, employees: 100 },
    },
    {
      id: 'c2',
      type: 'Company',
      properties: { name: 'Beta S.A.', cnpj: '12345678901', state: 'RJ', revenue: 20, employees: 2 },
    },
    {
      id: 'c3',
      type: 'Company',
      properties: { name: 'Gamma ME', state: 'SP', revenue: 5, employees: 1 },
    },
    {
      id: 'hub',
      type: 'Person',
      properties: { name: 'Hub', state: 'SP', revenue: 60, employees: 3 },
    },
    {
      id: 'iso',
      type: 'Person',
      properties: { name: 'Iso', state: 'MG', revenue: 7, employees: 1 },
    },
  ];

  const edge = (id: string, src: string, dst: string, relationship_type: string, amount: number) => ({
    id,
    src,
    dst,
    relationship_type,
    properties: { amount },
  });

  const edges = [
    edge('e1', 'p1', 'c1', 'OWNS', 999),
    edge('e2', 'p2', 'c1', 'WORKS_AT', 10),
    edge('e3', 'p1', 'p2', 'KNOWS', 1),
    edge('e4', 'p2', 'p1', 'KNOWS', 2),
    edge('e5', 'p3', 'c2', 'OWNS', 100),
    edge('e6', 'hub', 'p1', 'KNOWS', 1),
    edge('e7', 'hub', 'p2', 'KNOWS', 1),
    edge('e8', 'hub', 'p3', 'KNOWS', 1),
    edge('e9', 'hub', 'c1', 'OWNS', 1),
    edge('e10', 'hub', 'c2', 'OWNS', 1),
    edge('e11', 'hub', 'c3', 'OWNS', 1),
  ];

  const degrees = new Map<string, number>();
  for (const n of nodes) degrees.set(n.id, 0);
  for (const e of edges) {
    degrees.set(e.src, (degrees.get(e.src) ?? 0) + 1);
    degrees.set(e.dst, (degrees.get(e.dst) ?? 0) + 1);
  }

  const n = nodes.length;
  const e = edges.length;
  return {
    nodes,
    edges,
    degrees: Array.from(degrees.entries()),
    metrics: {
      Degree: Array.from(degrees.entries()),
      [PAGERANK_NAME]: [
        ['hub', 0.02],
        ['p1', 0.005],
        ['c3', 0.0001],
      ],
    },
    metricIdToName: { __builtin_degree: 'Degree', 'run-1': PAGERANK_NAME },
    metricsByAlgorithm: { __builtin: 'Degree', degree: 'Degree', pagerank: PAGERANK_NAME },
    communities: [
      ['p1', 0],
      ['p2', 0],
      ['hub', 0],
      ['c1', 0],
      ['p3', 1],
      ['c2', 1],
      ['c3', 2],
    ],
    summary: {
      nodeCount: n,
      edgeCount: e,
      meanDegree: (2 * e) / n,
      density: e / (n * (n - 1)),
    },
  };
}
