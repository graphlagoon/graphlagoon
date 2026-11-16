import { describe, it, expect } from 'vitest';
import {
  chooseKey,
  computeHubLeavesPlan,
  OTHER_KEY,
  scoreKey,
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

describe('automatic key and the Other petal', () => {
  const role = (i: number) => ['Socio', 'Administrador', 'Diretor', 'Conselheiro'][i % 4]

  it('scoreKey: an even split beats a skewed one; one value, or one value per leaf, scores ~0', () => {
    const n = 100
    const even = Array.from({ length: n }, (_, i) => role(i))
    const skewed = Array.from({ length: n }, (_, i) => (i < 97 ? 'Person' : 'Company'))
    const unique = Array.from({ length: n }, (_, i) => `name-${i}`)
    expect(scoreKey(even)).toBeGreaterThan(scoreKey(skewed))
    expect(scoreKey(Array(n).fill('Person'))).toBe(0)
    expect(scoreKey(unique)).toBeLessThan(scoreKey(skewed))
    expect(scoreKey(unique)).toBeLessThan(scoreKey(even) / 4)
    // Missing values cost coverage.
    expect(scoreKey(even.map((v, i) => (i % 2 ? null : v)))).toBeLessThan(scoreKey(even))
  })

  it('chooseKey picks per hub; the plan reports the choice', () => {
    const links = [...star(40, false)]
    for (let i = 0; i < 40; i++) links.push({ id: `f${i}`, source: `far-${i}`, target: 'hub2' })
    const typeOf = (l: string) => (l.startsWith('leaf') ? 'Person' : ['Person', 'Company'][Number(l.split('-')[1]) % 2])
    const roleOf = (l: string) => (l.startsWith('leaf') ? role(Number(l.split('-')[1])) : 'Socio')
    const candidates = [
      { name: 'node type', keyOf: typeOf },
      { name: 'qualificacao', keyOf: roleOf },
    ]
    expect(chooseKey(['leaf-0', 'leaf-1', 'leaf-2'], 'hub', candidates)?.name).toBe('qualificacao')
    const plan = computeHubLeavesPlan(links, { ...base, mode: 'petals', keyCandidates: candidates })
    expect(plan.keyByHub.get('hub')).toBe('qualificacao')
    expect(plan.keyByHub.get('hub2')).toBe('node type')
    expect(plan.regions.filter((r) => r.hub === 'hub').map((r) => r.key).sort()).toEqual(['Administrador', 'Conselheiro', 'Diretor', 'Socio'])
  })

  it('no candidate splits the leaves: one petal of missing values, no key reported', () => {
    const plan = computeHubLeavesPlan(star(20, false), { ...base, mode: 'petals', keyCandidates: [{ name: 'x', keyOf: () => 'same' }] })
    expect(plan.keyByHub.size).toBe(0)
    expect(plan.regions).toHaveLength(1)
  })

  it('more values than maxPetals: the largest keep a petal, the rest share Other with its value count', () => {
    // 12 values: value-0 has 12 leaves, value-1 11, … value-11 1 (78 leaves)
    const links: { id: string; source: string; target: string }[] = []
    const keyByLeaf = new Map<string, string>()
    let i = 0
    for (let v = 0; v < 12; v++) {
      for (let j = 0; j < 12 - v; j++, i++) {
        links.push({ id: `e${i}`, source: `l${i}`, target: 'hub' })
        keyByLeaf.set(`l${i}`, `value-${v}`)
      }
    }
    const plan = computeHubLeavesPlan(links, { ...base, mode: 'petals', keyOf: (l) => keyByLeaf.get(l)!, maxPetals: 8 })
    expect(plan.regions).toHaveLength(8)
    const other = plan.regions[7]
    expect(other.key).toBe(OTHER_KEY)
    expect(other.values).toBe(5)
    expect(other.count).toBe(5 + 4 + 3 + 2 + 1)
    expect(regionLabel(other)).toBe('5 other values (15)')
    expect(plan.offsets.size).toBe(78)
  })
})

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

describe("mode 'auto': the shape is decided per hub", () => {
  it('petals where a key splits the leaves, a crown where none does; nothing below the threshold', () => {
    const links = [...star(40, false)]
    for (let i = 0; i < 40; i++) links.push({ id: `f${i}`, source: `far-${i}`, target: 'hub2' })
    for (let i = 0; i < 4; i++) links.push({ id: `s${i}`, source: `tiny-${i}`, target: 'hub3' })
    const role = (l: string) => ['Socio', 'Administrador', 'Diretor'][Number(l.split('-')[1]) % 3]
    const candidates = [
      // hub: three even roles; hub2: 39 Person + 1 Company (0.17 bits, under the minimum)
      { name: 'qualificacao', keyOf: (l: string) => (l.startsWith('leaf') ? role(l) : null) },
      { name: 'node type', keyOf: (l: string) => (l === 'far-0' ? 'Company' : 'Person') },
    ]
    const plan = computeHubLeavesPlan(links, { ...base, minLeaves: 30, mode: 'auto', keyCandidates: candidates })
    expect([...plan.shapeByHub]).toEqual([['hub', 'petals'], ['hub2', 'crown']])
    expect(plan.keyByHub.get('hub')).toBe('qualificacao')
    expect(plan.regions.filter((r) => r.hub === 'hub')).toHaveLength(3)
    expect(plan.regions.filter((r) => r.hub === 'hub2')).toEqual([expect.objectContaining({ key: '', count: 40 })])
    expect(plan.offsets.size).toBe(80)
    expect(plan.implicitEdgeIds.size).toBe(80)
  })

  it('fixed modes report their shape too', () => {
    expect([...computeHubLeavesPlan(star(20, false), { ...base, mode: 'crown' }).shapeByHub.values()]).toEqual(['crown'])
    expect([...computeHubLeavesPlan(star(20, false), { ...base, mode: 'petals', keyOf: () => 'x' }).shapeByHub.values()]).toEqual(['petals'])
  })
})

describe('reveal on zoom (D7)', () => {
  it('revealCount: all when leaves are far enough apart on screen; fewer, in powers of 2, when closer', async () => {
    const { revealCount, REVEAL_MIN_PX, REVEAL_MIN_LEAVES } = await import('../hubLeaves')
    expect(revealCount(300, REVEAL_MIN_PX)).toBe(300)
    expect(revealCount(300, REVEAL_MIN_PX * 0.75)).toBe(150) // (0.75)² = 0.56 → 1/2
    expect(revealCount(300, REVEAL_MIN_PX * 0.5)).toBe(75) // 1/4
    expect(revealCount(300, 0.01)).toBe(REVEAL_MIN_LEAVES)
    expect(revealCount(2, 0.01)).toBe(2)
    // A small zoom change inside one step does not change the count.
    expect(revealCount(300, REVEAL_MIN_PX * 0.72)).toBe(revealCount(300, REVEAL_MIN_PX * 0.74))
  })

  it('zoomHiddenLeaves hides the outer leaves of each region, never a kept one, and counts per region', async () => {
    const { zoomHiddenLeaves, REVEAL_MIN_PX } = await import('../hubLeaves')
    const plan = computeHubLeavesPlan(star(100, false), { ...base, mode: 'crown' })
    const region = plan.regions[0]
    const outer = region.members[region.members.length - 1]
    const { hidden, hiddenByRegion } = zoomHiddenLeaves(plan.regions, REVEAL_MIN_PX * 0.5, new Set([outer]))
    expect(hidden.has(region.members[0])).toBe(false)
    expect(hidden.has(outer)).toBe(false)
    expect(hiddenByRegion).toEqual([100 - 25 - 1])
    expect(regionLabel(region, hiddenByRegion[0])).toBe('100 leaves +74 hidden')
    expect(zoomHiddenLeaves(plan.regions, REVEAL_MIN_PX).hidden.size).toBe(0)
  })
})
