import { describe, it, expect } from 'vitest';
import shared from '@/__tests__/fixtures/er/shared-attributes.json';
import { sharedAttributeLinks } from '@/utils/sharedLinks';

describe('shared attributes (05 §4b, links)', () => {
  it('matches the shared fixture (parity with the Python service)', () => {
    const p = shared.params;
    expect(sharedAttributeLinks(shared.graph as any, p)).toEqual(shared.expected);
  });

  it('a common value above maxEntities never links; minShared 1 links by a single attribute', () => {
    const { pairs } = sharedAttributeLinks(shared.graph as any, { attributes: ['ip'], minShared: 1, maxEntities: 3 });
    expect(pairs).toEqual([]);
    const one = sharedAttributeLinks(shared.graph as any, { attributes: ['ip'], minShared: 1 });
    expect(one.pairs).toHaveLength(6); // 4 entities share the carrier IP
    expect(one.edges[0]).toMatchObject({ type: 'shares_ip', properties: { shared_by: 4 } });
  });

  it('an attribute whose name says nothing takes the normalizer it is given', () => {
    const graph = {
      nodes: [
        { uid: 'a', type: 'Person', properties: { telefone: '+1 (415) 555-0100' } },
        { uid: 'b', type: 'Person', properties: { telefone: '14155550100' } },
      ],
      edges: [],
    };
    expect(sharedAttributeLinks(graph, { attributes: ['telefone'] }).pairs).toEqual([]);
    expect(sharedAttributeLinks(graph, { attributes: ['telefone'], normalize: { telefone: 'phone' } }).pairs).toEqual([
      { left: 'a', right: 'b', shared: ['telefone'] },
    ]);
  });
});
