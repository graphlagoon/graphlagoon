/**
 * The "Demo · QSA" partner register (api/graphlagoon/dev/qsa_demo.py): Banco
 * Aurora with 380 partners, Boreal with 105, 24 partners holding a holding too.
 * The same graph `make dev-seed-qsa` puts in the dev warehouse, read from the
 * JSON fixture a backend test keeps identical to the generator — so an e2e
 * test, a screenshot and the dev demo all show one graph.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../../src/__tests__/fixtures/qsa-demo.json', import.meta.url));

export function qsaDemo(): { nodes: any[]; edges: any[]; truncated: boolean; total_count: number } {
  const graph = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  // The mocked contexts label nodes with {prop:name}; the demo calls it display_name.
  for (const n of graph.nodes) n.properties = { name: n.properties.display_name, ...n.properties };
  return { ...graph, truncated: false, total_count: graph.edges.length };
}
