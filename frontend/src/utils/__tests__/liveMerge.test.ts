import { describe, it, expect } from 'vitest';
import { applyDiff, describeSummary, diffSnapshot, fingerprints, isEmptyDiff } from '@/utils/liveMerge';
import type { Edge, GraphSnapshot, Node } from '@/types/graph';

const BASE: GraphSnapshot = {
  nodes: [
    { id: 'a', type: 'Conta', properties: { titular: 'Ana' } },
    { id: 'b', type: 'Conta', properties: { titular: 'Bia' } },
    { id: 'c', type: 'Conta', properties: {} },
  ],
  edges: [
    { id: 'e1', source: 'a', target: 'b', type: 'PIX', properties: { valor: 1 } },
    { id: 'e2', source: 'b', target: 'c', type: 'PIX', properties: {} },
  ],
};

describe('liveMerge: three-way merge of a server change into the canvas', () => {
  it('finds what moved against the base, ignoring positions and key order', () => {
    const remote: GraphSnapshot = {
      nodes: [
        { id: 'a', type: 'Conta', properties: { titular: 'Ana' }, x: 99, y: 99 },
        { id: 'b', type: 'Conta', properties: { titular: 'Bia', risco: 'alto' } },
        { id: 'd', type: 'Conta', properties: {} },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', type: 'PIX', properties: { valor: 1 } }, { id: 'e3', source: 'a', target: 'd', type: 'PIX', properties: {} }],
    };
    const diff = diffSnapshot(fingerprints(BASE), remote);
    expect(diff.addedNodes.map((n) => n.node_id)).toEqual(['d']);
    expect(diff.changedNodes.map((n) => n.node_id)).toEqual(['b']);
    expect([...diff.removedNodeIds]).toEqual(['c']);
    expect(diff.addedEdges.map((e) => e.edge_id)).toEqual(['e3']);
    expect([...diff.removedEdgeIds]).toEqual(['e2']);
    expect(isEmptyDiff(diffSnapshot(fingerprints(BASE), { ...BASE, nodes: BASE.nodes.map((n) => ({ ...n, properties: { ...n.properties } })) }))).toBe(true);
  });

  it('keeps node objects (their layout) and the nodes the person expanded, patches changed ones in place', () => {
    const a: Node = { node_id: 'a', node_type: 'Conta', properties: { titular: 'Ana' }, x: 10, y: 20 };
    const b: Node = { node_id: 'b', node_type: 'Conta', properties: { titular: 'Bia' } };
    const c: Node = { node_id: 'c', node_type: 'Conta', properties: {} };
    const mine: Node = { node_id: 'z', node_type: 'Conta', properties: {} }; // expanded, not saved
    const edges: Edge[] = [
      { edge_id: 'e1', src: 'a', dst: 'b', relationship_type: 'PIX', properties: { valor: 1 } },
      { edge_id: 'e2', src: 'b', dst: 'c', relationship_type: 'PIX', properties: {} },
      { edge_id: 'ez', src: 'c', dst: 'z', relationship_type: 'PIX', properties: {} },
    ];
    const remote: GraphSnapshot = {
      nodes: [
        { id: 'a', type: 'Pessoa', properties: { titular: 'Ana' } },
        { id: 'b', type: 'Conta', properties: { titular: 'Bia', risco: 'alto' } },
        { id: 'd', type: 'Conta', properties: {} },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b', type: 'PIX', properties: { valor: 2 } },
        { id: 'e3', source: 'a', target: 'd', type: 'PIX', properties: {} },
      ],
    };
    const out = applyDiff([a, b, c, mine], edges, diffSnapshot(fingerprints(BASE), remote));
    expect(out.nodes.map((n) => n.node_id)).toEqual(['a', 'b', 'z', 'd']);
    expect(out.nodes[0]).toBe(a);
    expect(a.node_type).toBe('Pessoa');
    expect(a.x).toBe(10);
    expect(out.patch).toEqual(new Map([['a', { titular: 'Ana' }], ['b', { titular: 'Bia', risco: 'alto' }]]));
    // c is gone with its edges (e2, and ez the person had); e1 is the server's copy now.
    expect(out.edges.map((e) => [e.edge_id, e.properties])).toEqual([['e1', { valor: 2 }], ['e3', {}]]);
  });

  it('a node the agent added that the person had already expanded is updated, not duplicated', () => {
    const z: Node = { node_id: 'z', node_type: 'Conta', properties: {} };
    const remote: GraphSnapshot = { nodes: [...BASE.nodes, { id: 'z', type: 'Conta', properties: { titular: 'Zé' } }], edges: BASE.edges };
    const out = applyDiff([z], [], diffSnapshot(fingerprints(BASE), remote));
    expect(out.nodes).toEqual([z]);
    expect(out.patch.get('z')).toEqual({ titular: 'Zé' });
  });

  it('describes a summary for a toast', () => {
    expect(describeSummary({ added_nodes: 3, removed_edges: 1, updated_nodes: 2 })).toBe('+3 nodes, −1 edge, 2 changed');
    expect(describeSummary({})).toBe('');
    expect(describeSummary(undefined)).toBe('');
  });
});
