import { describe, it, expect } from 'vitest';
import { canvasKeyGuide, describeMatch, readTable, scopeLabel, suggestEnrichmentMatches } from '@/utils/enrichmentAutoMatch';
import type { PlainGraph } from '@/utils/enrichment';

const graph: PlainGraph = {
  nodes: [
    { node_id: 'p1', node_type: 'Person', properties: { name: 'Ana' } },
    { node_id: 'p2', node_type: 'Person', properties: { name: 'Bia' } },
    { node_id: 'c1', node_type: 'Company', properties: { tax_id: '12345678000190', name: 'Acme' } },
    { node_id: 'c2', node_type: 'Company', properties: { tax_id: '98765432000110', name: 'Beta' } },
    { node_id: 'c3', node_type: 'Company', properties: { tax_id: '11111111000111', name: 'Gama' } },
  ],
  edges: [
    { edge_id: 'e1', src: 'p1', dst: 'c1', relationship_type: 'WORKS_AT' },
    { edge_id: 'e2', src: 'p2', dst: 'c2', relationship_type: 'WORKS_AT' },
  ],
};

describe('readTable', () => {
  it('reads a CSV with its header', () => {
    const t = readTable('id,risk\np1,high\np2,low\n');
    expect(t.delimiter).toBe(',');
    expect(t.header).toEqual(['id', 'risk']);
    expect(t.rows).toEqual([['p1', 'high'], ['p2', 'low']]);
    expect(t.skipped).toBe(0);
  });

  it('reads rows pasted from a spreadsheet (tabs)', () => {
    const t = readTable('id\trisk\tsegment\np1\thigh\tretail\n');
    expect(t.delimiter).toBe('\t');
    expect(t.header).toEqual(['id', 'risk', 'segment']);
  });

  it('drops a title line above the header, and the BOM', () => {
    const t = readTable('﻿Risk review 2026\n\ndoc;risk;segment\n12.345.678/0001-90;high;retail\n98.765.432/0001-10;low;sme\n');
    expect(t.delimiter).toBe(';');
    expect(t.skipped).toBe(1);
    expect(t.header).toEqual(['doc', 'risk', 'segment']);
    expect(t.text.startsWith('doc;risk;segment')).toBe(true);
  });
});

describe('suggestEnrichmentMatches', () => {
  it('joins by the node id when a column holds it', () => {
    const [best] = suggestEnrichmentMatches(graph, readTable('person,risk\np1,high\np2,low\nzz,none\n'), 'risk');
    expect(best.spec.key_column).toBe('person');
    expect(best.spec.match_source).toBe('node_id');
    expect(best.spec.normalize).toBe('none');
    expect(best.spec.columns).toEqual(['risk']);
    expect(best.matched).toBe(2);
    expect(best.spec.match_node_types).toEqual(['Person']);
    expect(best.total).toBe(2);
    expect(scopeLabel(best.spec)).toBe('Person nodes');
  });

  it('finds a formatted document against a digits-only property, without any setting', () => {
    const t = readTable('Risk review\ndoc;risk\n12.345.678/0001-90;high\n98.765.432/0001-10;low\n');
    const [best] = suggestEnrichmentMatches(graph, t, 'risk');
    expect(best.spec.key_column).toBe('doc');
    expect(best.spec.match_source).toEqual({ kind: 'prop', name: 'tax_id' });
    expect(best.spec.normalize).toBe('digits');
    expect(best.matched).toBe(2);
    expect(describeMatch(best.spec)).toBe('column doc = property tax_id, digits only (document, tax or national id)');
  });

  it('ignores case when only the case differs', () => {
    const [best] = suggestEnrichmentMatches(graph, readTable('who,score\nP1,3\nP2,4\n'), 'x');
    expect(best.spec.normalize).toBe('lower');
    expect(best.matched).toBe(2);
  });

  it('offers the other joins as alternatives', () => {
    const all = suggestEnrichmentMatches(graph, readTable('id,name,risk\np1,Acme,high\np2,Beta,low\n'), 'x');
    expect(all.map((s) => s.spec.key_column)).toEqual(expect.arrayContaining(['id', 'name']));
  });

  it('reads two columns that are an edge\'s ends as an edge enrichment', () => {
    const [best] = suggestEnrichmentMatches(graph, readTable('from,to,since\np1,c1,2019\nc2,p2,2020\n'), 'x');
    expect(best.spec.target).toBe('edges');
    expect(best.spec.edge_key).toEqual({ by: 'endpoints', source_column: 'from', target_column: 'to', type_column: null });
    expect(best.spec.columns).toEqual(['since']);
    expect(best.matched).toBe(2);
    expect(scopeLabel(best.spec)).toBe('edges');
  });

  it('returns nothing when no column meets the canvas', () => {
    expect(suggestEnrichmentMatches(graph, readTable('k,v\nnope,1\nnada,2\n'), 'x')).toEqual([]);
  });
});

describe('canvasKeyGuide', () => {
  it('names each type with a real node and its id-like properties, not its categories', () => {
    const g = canvasKeyGuide({
      nodes: [
        ...graph.nodes,
        { node_id: 'c4', node_type: 'Company', properties: { tax_id: '22222222000122', name: 'Delta', sector: 'Retail' } },
        { node_id: 'c5', node_type: 'Company', properties: { tax_id: '33333333000133', name: 'Eta', sector: 'Retail' } },
      ],
      edges: graph.edges,
    });
    expect(g.types.map((t) => [t.type, t.count])).toEqual([['Company', 5], ['Person', 2]]);
    const company = g.types[0];
    expect(company.sample).toEqual({ id: 'c1', name: 'Acme' });
    expect(company.keys.map((k) => k.name)).toEqual(['tax_id', 'name']);
    expect(company.keys[0].example).toBe('12345678000190');
    expect(g.edge).toEqual({ src: 'p1', dst: 'c1', type: 'WORKS_AT' });
    expect(g.idsOnly).toBe(false);
  });

  it('does not offer short numbers or, on a few nodes, a property whose name is not an id', () => {
    const g = canvasKeyGuide({
      nodes: [
        { node_id: 'a', node_type: 'P', properties: { age: 30, city: 'Rio', email: 'a@x.io', name: 'Ana' } },
        { node_id: 'b', node_type: 'P', properties: { age: 25, city: 'SP', email: 'b@x.io', name: 'Bia' } },
      ],
      edges: [],
    });
    expect(g.types[0].keys.map((k) => k.name)).toEqual(['email', 'name']);
  });

  it('says when the nodes carry no property (only ids can join)', () => {
    const g = canvasKeyGuide({ nodes: [{ node_id: 'a', node_type: 'T' }], edges: [] });
    expect(g.idsOnly).toBe(true);
    expect(g.types[0].keys).toEqual([]);
    expect(g.edge).toBeNull();
  });

  it('is empty on an empty canvas', () => {
    expect(canvasKeyGuide({ nodes: [], edges: [] }).types).toEqual([]);
  });
});
