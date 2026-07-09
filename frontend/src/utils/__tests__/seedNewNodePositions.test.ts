import { describe, it, expect } from 'vitest';
import { seedNewNodePositions, type SeedableNode } from '@/utils/seedNewNodePositions';

const RADIUS = 40;

function dist(a: { x: number; y: number; z: number }, b: { x?: number; y?: number; z?: number }): number {
  return Math.sqrt((a.x - b.x!) ** 2 + (a.y - b.y!) ** 2 + (a.z - b.z!) ** 2);
}

describe('seedNewNodePositions', () => {
  it('places a new node within radius of its positioned neighbor and pins it', () => {
    const anchor = { x: 100, y: -50, z: 30 };
    const nodes: SeedableNode[] = [{ id: 'old' }, { id: 'new1' }];
    const links = [{ source: 'old', target: 'new1' }];
    const known = new Map([['old', anchor]]);

    seedNewNodePositions(nodes, links, known, { radius: RADIUS });

    const n = nodes[1];
    expect(n.x).toBeDefined();
    // Each axis offset is bounded by radius → euclidean bound is radius*sqrt(3)
    expect(dist(anchor, n)).toBeLessThanOrEqual(RADIUS * Math.sqrt(3));
    expect(n.fx).toBe(n.x);
    expect(n.fy).toBe(n.y);
    expect(n.fz).toBe(n.z);
  });

  it('resolves chains across passes (ring-2 anchors on ring-1 seeds)', () => {
    const anchor = { x: 0, y: 0, z: 0 };
    const nodes: SeedableNode[] = [{ id: 'old' }, { id: 'ring1' }, { id: 'ring2' }];
    // ring2 only connects to ring1, which only connects to old
    const links = [
      { source: 'old', target: 'ring1' },
      { source: 'ring1', target: 'ring2' },
    ];
    seedNewNodePositions(nodes, links, new Map([['old', anchor]]), { radius: RADIUS });

    const ring1 = nodes[1];
    const ring2 = nodes[2];
    expect(ring1.x).toBeDefined();
    expect(ring2.x).toBeDefined();
    // ring2 is anchored on ring1's seeded position
    expect(dist({ x: ring1.x!, y: ring1.y!, z: ring1.z! }, ring2)).toBeLessThanOrEqual(RADIUS * Math.sqrt(3));
  });

  it('falls back to the centroid of known positions for isolated new nodes', () => {
    const known = new Map([
      ['a', { x: 0, y: 0, z: 0 }],
      ['b', { x: 200, y: 200, z: 200 }],
    ]);
    const nodes: SeedableNode[] = [{ id: 'a' }, { id: 'b' }, { id: 'lonely' }];
    seedNewNodePositions(nodes, [], known, { radius: RADIUS });

    const lonely = nodes[2];
    expect(lonely.x).toBeDefined();
    expect(dist({ x: 100, y: 100, z: 100 }, lonely)).toBeLessThanOrEqual(RADIUS * Math.sqrt(3));
  });

  it('forces z=0 in 2D mode', () => {
    const nodes: SeedableNode[] = [{ id: 'old' }, { id: 'new1' }];
    const links = [{ source: 'old', target: 'new1' }];
    seedNewNodePositions(nodes, links, new Map([['old', { x: 5, y: 5, z: 99 }]]), { is2D: true });

    expect(nodes[1].z).toBe(0);
    expect(nodes[1].fz).toBe(0);
  });

  it('does not touch nodes that already have a known position', () => {
    const nodes: SeedableNode[] = [{ id: 'old', x: 1, y: 2, z: 3 }, { id: 'new1' }];
    const links = [{ source: 'old', target: 'new1' }];
    seedNewNodePositions(nodes, links, new Map([['old', { x: 1, y: 2, z: 3 }]]), {});

    expect(nodes[0].x).toBe(1);
    expect(nodes[0].y).toBe(2);
    expect(nodes[0].z).toBe(3);
    expect(nodes[0].fx).toBeUndefined(); // never pinned by the seeder
  });

  it('no pending nodes → no-op', () => {
    const nodes: SeedableNode[] = [{ id: 'a', x: 1, y: 1, z: 1 }];
    seedNewNodePositions(nodes, [], new Map([['a', { x: 1, y: 1, z: 1 }]]), {});
    expect(nodes[0].fx).toBeUndefined();
  });
});
