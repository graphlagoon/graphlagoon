import { describe, it, expect } from 'vitest';
import {
  computeHubLeavesPlan,
  findHubLeaves,
  forceHubLeaves,
  MISSING_KEY,
  regionLabel,
  serializeHubLeavesPlan,
  snapHubLeaves,
  spiralOffsets,
  type HubLeavesLink,
} from '../hubLeaves';

/** hub + n leaves; leaf-0 and leaf-1 also link to `other` (not leaves). */
function star(n: number, extra = true): HubLeavesLink[] {
  const links: HubLeavesLink[] = [];
  for (let i = 0; i < n; i++) links.push({ id: `e${i}`, source: `leaf-${i}`, target: 'hub' });
  if (extra) {
    links.push({ id: 'x0', source: 'leaf-0', target: 'other' });
    links.push({ id: 'x1', source: 'leaf-1', target: 'other' });
  }
  return links;
}

function minPairDistance(points: { dx: number; dy: number }[]): number {
  let min = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      min = Math.min(min, Math.hypot(points[i].dx - points[j].dx, points[i].dy - points[j].dy));
    }
  }
  return min;
}

const base = { minLeaves: 5, spacing: 14, hubRadiusOf: () => 20 };

describe('findHubLeaves', () => {
  it('a leaf has exactly one distinct neighbour; nodes with a second link are not leaves', () => {
    const byHub = findHubLeaves(star(10), 5);
    expect([...byHub.keys()]).toEqual(['hub']);
    expect(byHub.get('hub')).toHaveLength(8);
    expect(byHub.get('hub')).not.toContain('leaf-0');
  });

  it('two edges to the same hub still make a leaf; self-loops are ignored', () => {
    const links = [
      ...star(6, false),
      { id: 'dup', source: 'hub', target: 'leaf-2' },
      { id: 'self', source: 'leaf-3', target: 'leaf-3' },
    ];
    expect(findHubLeaves(links, 5).get('hub')).toHaveLength(6);
  });

  it('a hub needs at least minLeaves leaves; an isolated pair has no hub', () => {
    expect(findHubLeaves(star(4, false), 5).size).toBe(0);
    expect(findHubLeaves([{ id: 'a', source: 'p', target: 'q' }], 1).size).toBe(0);
  });
});

describe('spiralOffsets', () => {
  it('keeps every pair of leaves at least ~one spacing apart', () => {
    for (const n of [10, 100, 600]) {
      expect(minPairDistance(spiralOffsets(n, 14))).toBeGreaterThan(14 * 0.85);
      expect(minPairDistance(spiralOffsets(n, 14, 40))).toBeGreaterThan(14 * 0.85);
    }
  });

  it('starts outside r0', () => {
    for (const p of spiralOffsets(50, 14, 40)) expect(Math.hypot(p.dx, p.dy)).toBeGreaterThanOrEqual(40);
  });
});

describe('computeHubLeavesPlan', () => {
  it('crown: every leaf gets an offset outside the hub; hub–leaf edges become implicit', () => {
    const plan = computeHubLeavesPlan(star(300), { ...base, mode: 'crown' });
    expect(plan.offsets.size).toBe(298);
    for (const o of plan.offsets.values()) {
      expect(o.hub).toBe('hub');
      expect(Math.hypot(o.dx, o.dy)).toBeGreaterThan(20);
    }
    // 298 leaf edges implicit; the two edges of the linked partners to the hub stay drawn.
    expect(plan.implicitEdgeIds.size).toBe(298);
    expect(plan.implicitEdgeIds.has('e0')).toBe(false);
    expect(plan.implicitEdgeIds.has('x0')).toBe(false);
    expect(plan.regions).toEqual([expect.objectContaining({ hub: 'hub', key: '', count: 298 })]);
    // Radius grows with √N, not N: far smaller than a 300-node ring at the same spacing (~670).
    expect(plan.hubRadius.get('hub')!).toBeLessThan(200);
  });

  it('petals: one disc per key, largest first, missing values last; discs do not overlap', () => {
    const links = star(60, false);
    const keyOf = (leaf: string) => {
      const i = Number(leaf.split('-')[1]);
      if (i < 5) return null;
      return i % 3 === 0 ? 'Acionista' : 'Socio';
    };
    const plan = computeHubLeavesPlan(links, { ...base, mode: 'petals', keyOf });
    expect(plan.regions.map((r) => r.key)).toEqual(['Socio', 'Acionista', MISSING_KEY]);
    expect(plan.regions.map((r) => r.count)).toEqual([37, 18, 5]);
    for (let i = 0; i < plan.regions.length; i++) {
      for (let j = i + 1; j < plan.regions.length; j++) {
        const a = plan.regions[i];
        const b = plan.regions[j];
        expect(Math.hypot(a.dx - b.dx, a.dy - b.dy)).toBeGreaterThanOrEqual(a.radius + b.radius);
      }
      expect(Math.hypot(plan.regions[i].dx, plan.regions[i].dy) - plan.regions[i].radius).toBeGreaterThan(20);
    }
    expect(regionLabel(plan.regions[0])).toBe('Socio (37)');
  });

  it('is deterministic', () => {
    const a = computeHubLeavesPlan(star(120), { ...base, mode: 'petals', keyOf: (l) => l.slice(-1) });
    const b = computeHubLeavesPlan([...star(120)].reverse(), { ...base, mode: 'petals', keyOf: (l) => l.slice(-1) });
    expect([...a.offsets].sort()).toEqual([...b.offsets].sort());
  });

  it('no hub → empty plan', () => {
    const plan = computeHubLeavesPlan(star(3), { ...base, mode: 'crown' });
    expect(plan.offsets.size).toBe(0);
    expect(plan.regions).toEqual([]);
  });
});

describe('forceHubLeaves', () => {
  it('puts leaves at hub + offset (also when pinned) and pushes other nodes out of the arrangement', () => {
    const plan = computeHubLeavesPlan(star(30), { ...base, mode: 'crown' });
    const nodes: any[] = [
      { id: 'hub', x: 100, y: 50 },
      { id: 'other', x: 101, y: 50 },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `leaf-${i}`, x: 0, y: 0, fx: i === 5 ? 0 : undefined, fy: i === 5 ? 0 : undefined })),
    ];
    const force = forceHubLeaves(serializeHubLeavesPlan(plan), 14);
    force.initialize(nodes);
    force();
    const leaf5 = nodes.find((n) => n.id === 'leaf-5');
    const o = plan.offsets.get('leaf-5')!;
    expect(leaf5.x).toBeCloseTo(100 + o.dx);
    expect(leaf5.fy).toBeCloseTo(50 + o.dy);
    const other = nodes.find((n) => n.id === 'other');
    expect(Math.hypot(other.x - 100, other.y - 50)).toBeGreaterThanOrEqual(plan.hubRadius.get('hub')!);
  });
});

// The vitest alias mocks d3-force-3d; this one case runs the real simulation
// (the submodule) to prove the arrangement survives charge, links and the
// velocity integration step — what the live engine and the settle worker do.
describe('forceHubLeaves in a real d3-force-3d simulation', () => {
  it('leaves end exactly at hub + offset; linked nodes end outside the arrangement', async () => {
    // @ts-expect-error untyped JS submodule
    const d3 = await import('../../../ext-3d-force/d3-force-3d/src/index.js');
    const links = star(40);
    const plan = computeHubLeavesPlan(links, { ...base, mode: 'petals', keyOf: (l) => (Number(l.split('-')[1]) % 2 ? 'odd' : 'even') });
    const nodes: any[] = ['hub', 'other', ...Array.from({ length: 40 }, (_, i) => `leaf-${i}`)].map((id) => ({ id }));
    const sim = d3
      .forceSimulation(nodes, 2)
      .force('link', d3.forceLink(links.map((l) => ({ source: l.source, target: l.target }))).id((n: any) => n.id).distance(30))
      .force('charge', d3.forceManyBody().strength(-80))
      .force('hubLeaves', forceHubLeaves(serializeHubLeavesPlan(plan), 14))
      .stop();
    sim.tick(300);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const hub = byId.get('hub');
    for (const [leaf, o] of plan.offsets) {
      expect(byId.get(leaf).x).toBeCloseTo(hub.x + o.dx, 6);
      expect(byId.get(leaf).y).toBeCloseTo(hub.y + o.dy, 6);
    }
    for (const id of ['other', 'leaf-0', 'leaf-1']) {
      const n = byId.get(id);
      expect(Math.hypot(n.x - hub.x, n.y - hub.y)).toBeGreaterThan(plan.hubRadius.get('hub')! * 0.9);
    }
  });
});

describe('snapHubLeaves', () => {
  it('anchors on a pinned hub (fx), e.g. while it is dragged', () => {
    const plan = computeHubLeavesPlan(star(20), { ...base, mode: 'crown' });
    const nodes: any[] = [{ id: 'hub', x: 0, y: 0, fx: 300, fy: -40 }, ...[...plan.offsets.keys()].map((id) => ({ id, x: 0, y: 0 }))];
    snapHubLeaves(nodes, serializeHubLeavesPlan(plan), 14);
    const [leaf, o] = [...plan.offsets][0];
    const n = nodes.find((x) => x.id === leaf);
    expect(n.x).toBeCloseTo(300 + o.dx);
    expect(n.y).toBeCloseTo(-40 + o.dy);
  });

  it('pushes nodes out of arrangements of hubs far apart (grid), and two hubs apart from each other', () => {
    const links = [...star(30, false)];
    for (let i = 0; i < 30; i++) links.push({ id: `f${i}`, source: `far-${i}`, target: 'hub2' });
    const plan = computeHubLeavesPlan(links, { ...base, mode: 'crown' });
    const nodes: any[] = [
      { id: 'hub', x: 0, y: 0 },
      { id: 'hub2', x: 10_000, y: 0 },
      { id: 'near2', x: 10_001, y: 1 },
      { id: 'hub-close', x: 5, y: 5 },
    ];
    snapHubLeaves(nodes, serializeHubLeavesPlan(plan), 14);
    const near2 = nodes[2];
    expect(Math.hypot(near2.x - 10_000, near2.y)).toBeGreaterThanOrEqual(plan.hubRadius.get('hub2')!);
    expect(Math.hypot(nodes[3].x, nodes[3].y)).toBeGreaterThanOrEqual(plan.hubRadius.get('hub')!);
  });
});
