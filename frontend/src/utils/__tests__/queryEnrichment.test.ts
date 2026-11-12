import { describe, expect, it } from 'vitest';
import type { Edge, EnrichmentTable, Node } from '@/types/graph';
import {
  authorizedTables,
  enrichedKeys,
  queryEntries,
  recordProvenance,
  runPatch,
  runPayloads,
  stripEnriched,
  type EnrichmentProvenance,
} from '../queryEnrichment';

const nodes: Node[] = [
  { node_id: 'a', node_type: 'Conta', properties: { name: 'A' } },
  { node_id: 'b', node_type: 'Conta', properties: { name: 'B' } },
  { node_id: 'c', node_type: 'Conta' },
];
const edges: Edge[] = [
  { edge_id: 'e1', src: 'a', dst: 'b', relationship_type: 'PAYS', properties: { amount: 10, risk: 'old' } },
  { edge_id: 'e2', src: 'b', dst: 'c', relationship_type: 'PAYS' },
  { edge_id: 'e3', src: 'c', dst: 'a', relationship_type: 'PAYS' },
];
const entry = (query: EnrichmentTable['query']): EnrichmentTable => ({ name: 'q', label: 'Risk', table: 'm.s.t', query });

describe('queryEntries', () => {
  const ctx = {
    enrichment_tables: [
      { name: 'bare', label: 'Bare', table: 'm.s.a' },
      entry({ sql: 'SELECT 1', run: 'auto' }),
      { ...entry({ sql: 'SELECT 2' }), name: 'm' },
    ],
  };
  it('keeps entries with a query, filtered by run', () => {
    expect(queryEntries(ctx).map((t) => t.name)).toEqual(['q', 'm']);
    expect(queryEntries(ctx, 'auto').map((t) => t.name)).toEqual(['q']);
    expect(queryEntries(ctx, 'manual').map((t) => t.name)).toEqual(['m']);
    expect(queryEntries(null)).toEqual([]);
    expect(authorizedTables(ctx)).toEqual(['m.s.a', 'm.s.t']);
  });
});

describe('runPayloads', () => {
  it('batches edges with only their endpoint nodes, node properties only when asked', () => {
    const [first, second] = runPayloads(nodes, edges, entry({ sql: 's' }), 2);
    expect(first.edges.map((e) => e.edge_id)).toEqual(['e1', 'e2']);
    expect(first.nodes.map((n) => n.node_id)).toEqual(['a', 'b', 'c']);
    expect(first.nodes[0].properties).toEqual({});
    expect(second.edges.map((e) => e.edge_id)).toEqual(['e3']);
    expect(second.nodes.map((n) => n.node_id).sort()).toEqual(['a', 'c']);
    const [withProps] = runPayloads(nodes, edges, entry({ sql: 's', node_props: true }));
    expect(withProps.nodes[0].properties).toEqual({ name: 'A' });
    expect(withProps.edges[1].properties).toEqual({});
    const [onlyNew] = runPayloads(nodes, edges, entry({ sql: 's' }), 500, { edges: new Set(['e3']) });
    expect(onlyNew.edges.map((e) => e.edge_id)).toEqual(['e3']);
  });

  it('a node query batches nodes, each with the edges that touch it', () => {
    const nodeEntry = entry({ sql: 's', target: 'nodes', node_props: true });
    const [first, second] = runPayloads(nodes, edges, nodeEntry, 2);
    expect(first.nodes.map((n) => n.node_id)).toEqual(['a', 'b']);
    expect(first.nodes[0].properties).toEqual({ name: 'A' });
    expect(first.edges.map((e) => e.edge_id)).toEqual(['e1', 'e2', 'e3']);
    expect(second.nodes.map((n) => n.node_id)).toEqual(['c']);
    expect(second.edges.map((e) => e.edge_id)).toEqual(['e2', 'e3']);
    const [onlyNew] = runPayloads(nodes, edges, nodeEntry, 500, { nodes: new Set(['c']) });
    expect(onlyNew.nodes.map((n) => n.node_id)).toEqual(['c']);
  });
});

describe('runPatch', () => {
  const result = { rows: { e1: { risk: 'high', channel: 'pix', none: null }, e2: { risk: null }, zz: { risk: 'x' } } };
  it('keeps values already there unless overwrite, skips nulls', () => {
    const { patch, written, matched } = runPatch(edges, (e) => e.edge_id, result, false);
    expect(matched).toBe(2);
    expect(patch.get('e1')).toEqual({ amount: 10, risk: 'old', channel: 'pix' });
    expect(written.get('e1')).toEqual(['channel']);
    expect(patch.has('e2')).toBe(false);
    const over = runPatch(edges, (e) => e.edge_id, result, true);
    expect(over.patch.get('e1')).toEqual({ amount: 10, risk: 'high', channel: 'pix' });
    expect(edges[0].properties).toEqual({ amount: 10, risk: 'old' });
  });
});

describe('provenance', () => {
  it('records, reads and strips what queries wrote', () => {
    const prov: EnrichmentProvenance = new Map();
    recordProvenance(prov, 'Risk', new Map([['e1', ['channel']]]));
    recordProvenance(prov, 'Risk', new Map([['e1', ['score']]]));
    recordProvenance(prov, 'Cities', new Map([['e1', ['city']]]));
    expect([...enrichedKeys(prov, 'e1')]).toEqual([['channel', 'Risk'], ['score', 'Risk'], ['city', 'Cities']]);
    const enriched = [{ edge_id: 'e1', properties: { amount: 1, channel: 'pix', city: 'X' } }, { edge_id: 'e2' }];
    expect(stripEnriched(enriched, (e) => e.edge_id, prov)).toEqual([{ edge_id: 'e1', properties: { amount: 1 } }, { edge_id: 'e2' }]);
    expect(stripEnriched(enriched, (e) => e.edge_id, new Map())).toBe(enriched);
  });
});
