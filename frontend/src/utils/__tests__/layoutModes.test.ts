import { describe, it, expect } from 'vitest';
import {
  circularMean,
  circularMedian,
  computeEgoHops,
  computeEgoLinkCurvatures,
  computeHivePositions,
  computeRingGuideSpec,
  computeHiveAxesSpec,
  computeHiveLinkCurvatures,
  computeTreeLayout,
  HIVE_OTHERS_AXIS,
} from '../layoutModes';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function node(id: string, type = 'Account', properties?: Record<string, unknown>) {
  return { node_id: id, node_type: type, properties };
}

function edge(src: string, dst: string, type = 'TRANSFER') {
  return { src, dst, relationship_type: type };
}

// ---------------------------------------------------------------------------
// computeEgoHops
// ---------------------------------------------------------------------------

describe('computeEgoHops', () => {
  it('assigns hop counts along a chain (both directions)', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];

    const result = computeEgoHops(nodes, edges, { focusNodeId: 'a', direction: 'both', edgeTypes: null });

    expect(result.hops.get('a')).toBe(0);
    expect(result.hops.get('b')).toBe(1);
    expect(result.hops.get('c')).toBe(2);
    expect(result.hops.get('d')).toBe(3);
    expect(result.maxHop).toBe(3);
    expect(result.unreachable.size).toBe(0);
  });

  it('handles cycles without infinite loops', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];

    const result = computeEgoHops(nodes, edges, { focusNodeId: 'a', direction: 'both', edgeTypes: null });

    expect(result.hops.get('a')).toBe(0);
    expect(result.hops.get('b')).toBe(1);
    expect(result.hops.get('c')).toBe(1);
  });

  it('direction "out" follows only outgoing edges', () => {
    // a → b → c, and d → a (upstream of a)
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('d', 'a')];

    const result = computeEgoHops(nodes, edges, { focusNodeId: 'a', direction: 'out', edgeTypes: null });

    expect(result.hops.get('b')).toBe(1);
    expect(result.hops.get('c')).toBe(2);
    // d only reaches a via an incoming edge — unreachable downstream
    expect(result.unreachable.has('d')).toBe(true);
    expect(result.hops.get('d')).toBe(result.maxHop + 1);
  });

  it('direction "in" follows only incoming edges', () => {
    const nodes = [node('a'), node('b'), node('d')];
    const edges = [edge('a', 'b'), edge('d', 'a')];

    const result = computeEgoHops(nodes, edges, { focusNodeId: 'a', direction: 'in', edgeTypes: null });

    expect(result.hops.get('d')).toBe(1);
    expect(result.unreachable.has('b')).toBe(true);
  });

  it('restricts traversal to the given edge types but keeps other nodes on the outer ring', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('a', 'b', 'TRANSFER'), edge('a', 'c', 'SAME_DEVICE')];

    const result = computeEgoHops(nodes, edges, {
      focusNodeId: 'a',
      direction: 'both',
      edgeTypes: ['TRANSFER'],
    });

    expect(result.hops.get('b')).toBe(1);
    expect(result.unreachable.has('c')).toBe(true);
    expect(result.hops.get('c')).toBe(2); // maxHop(1) + 1
  });

  it('places disconnected nodes on a dedicated outermost ring', () => {
    const nodes = [node('a'), node('b'), node('island')];
    const edges = [edge('a', 'b')];

    const result = computeEgoHops(nodes, edges, { focusNodeId: 'a', direction: 'both', edgeTypes: null });

    expect(result.unreachable).toEqual(new Set(['island']));
    expect(result.hops.get('island')).toBe(2);
  });

  it('treats an empty edgeTypes array as "all types"', () => {
    const nodes = [node('a'), node('b')];
    const edges = [edge('a', 'b', 'X')];

    const result = computeEgoHops(nodes, edges, { focusNodeId: 'a', direction: 'both', edgeTypes: [] });

    expect(result.hops.get('b')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeHivePositions
// ---------------------------------------------------------------------------

describe('computeHivePositions', () => {
  const baseOptions = {
    axisKey: 'node_type',
    maxAxes: 6,
    positionKey: 'degree',
    scale: 'rank' as const,
    innerRadius: 40,
    outerRadius: 300,
  };

  function degrees(entries: [string, number][]) {
    return { nodeDegrees: new Map(entries) };
  }

  it('assigns one axis per node type, evenly spaced', () => {
    const nodes = [node('a', 'Account'), node('b', 'Device'), node('c', 'Merchant')];
    const result = computeHivePositions(nodes, baseOptions, degrees([['a', 1], ['b', 1], ['c', 1]]));

    expect(result.axes).toHaveLength(3);
    expect(result.othersCategoryCount).toBe(0);
    const axisIndexes = new Set(
      [...result.positions.values()].map((p) => p.axisIndex)
    );
    expect(axisIndexes.size).toBe(3);
  });

  it('buckets categories beyond maxAxes into an Others axis, largest kept first', () => {
    const nodes = [
      node('a1', 'A'), node('a2', 'A'), node('a3', 'A'),
      node('b1', 'B'), node('b2', 'B'),
      node('c1', 'C'),
      node('d1', 'D'),
    ];
    const result = computeHivePositions(
      nodes,
      { ...baseOptions, maxAxes: 2 },
      degrees(nodes.map((n) => [n.node_id, 1]))
    );

    expect(result.axes).toEqual(['A', 'B', HIVE_OTHERS_AXIS]);
    expect(result.othersCategoryCount).toBe(2); // C and D
    expect(result.positions.get('c1')!.axisLabel).toBe(HIVE_OTHERS_AXIS);
    expect(result.positions.get('d1')!.axisLabel).toBe(HIVE_OTHERS_AXIS);
  });

  it('rank scale spreads nodes uniformly between inner and outer radius', () => {
    const nodes = [node('lo', 'A'), node('mid', 'A'), node('hi', 'A')];
    const result = computeHivePositions(
      nodes,
      baseOptions,
      degrees([['lo', 1], ['mid', 5], ['hi', 100]])
    );

    const radius = (id: string) => Math.hypot(result.positions.get(id)!.x, result.positions.get(id)!.y);
    expect(radius('lo')).toBeCloseTo(40);
    expect(radius('mid')).toBeCloseTo(170); // midpoint of 40..300
    expect(radius('hi')).toBeCloseTo(300);
  });

  it('linear scale normalizes per axis by metric value', () => {
    const nodes = [node('lo', 'A'), node('hi', 'A')];
    const result = computeHivePositions(
      nodes,
      { ...baseOptions, scale: 'linear' },
      degrees([['lo', 0], ['hi', 10]])
    );

    const radius = (id: string) => Math.hypot(result.positions.get(id)!.x, result.positions.get(id)!.y);
    expect(radius('lo')).toBeCloseTo(40);
    expect(radius('hi')).toBeCloseTo(300);
  });

  it('reads numeric properties via prop: keys and sends missing values to the inner end', () => {
    const nodes = [
      node('scored', 'A', { risk: 0.9 }),
      node('unscored', 'A', {}),
      node('low', 'A', { risk: 0.1 }),
    ];
    const result = computeHivePositions(
      nodes,
      { ...baseOptions, positionKey: 'prop:risk', scale: 'linear' },
      degrees([])
    );

    const radius = (id: string) => Math.hypot(result.positions.get(id)!.x, result.positions.get(id)!.y);
    expect(radius('unscored')).toBeCloseTo(40); // missing → inner
    expect(radius('scored')).toBeCloseTo(300);
    expect(radius('low')).toBeCloseTo(40);
  });

  it('supports categorical property axes via prop: keys, with (missing) bucket', () => {
    const nodes = [
      node('x', 'A', { bank: 'Acme' }),
      node('y', 'A', { bank: 'Zenith' }),
      node('z', 'A', {}),
    ];
    const result = computeHivePositions(
      nodes,
      { ...baseOptions, axisKey: 'prop:bank' },
      degrees([])
    );

    expect(new Set(result.axes)).toEqual(new Set(['Acme', 'Zenith', '(missing)']));
  });

  it('is deterministic: same input twice yields identical positions', () => {
    const nodes = [node('a', 'A'), node('b', 'A'), node('c', 'B')];
    const deps = degrees([['a', 2], ['b', 2], ['c', 1]]); // tie between a and b
    const r1 = computeHivePositions(nodes, baseOptions, deps);
    const r2 = computeHivePositions(nodes, baseOptions, deps);

    for (const id of ['a', 'b', 'c']) {
      expect(r1.positions.get(id)).toEqual(r2.positions.get(id));
    }
    // Tie broken by id: 'a' before 'b'
    const radius = (r: typeof r1, id: string) => Math.hypot(r.positions.get(id)!.x, r.positions.get(id)!.y);
    expect(radius(r1, 'a')).toBeLessThan(radius(r1, 'b'));
  });

  it('uses Louvain communities as axes when axisKey is "community"', () => {
    const nodes = [node('a'), node('b'), node('c'), node('orphan')];
    const result = computeHivePositions(
      nodes,
      { ...baseOptions, axisKey: 'community' },
      {
        nodeDegrees: new Map(),
        communityMap: new Map([['a', 0], ['b', 0], ['c', 1]]),
      }
    );

    expect(new Set(result.axes)).toEqual(new Set(['Community 0', 'Community 1', '(none)']));
    expect(result.positions.get('a')!.axisLabel).toBe('Community 0');
    expect(result.positions.get('c')!.axisLabel).toBe('Community 1');
    expect(result.positions.get('orphan')!.axisLabel).toBe('(none)');
  });

  it('centers a single node on its axis midpoint', () => {
    const nodes = [node('only', 'A')];
    const result = computeHivePositions(nodes, baseOptions, degrees([['only', 3]]));

    const pos = result.positions.get('only')!;
    expect(Math.hypot(pos.x, pos.y)).toBeCloseTo(170);
  });
});

// ---------------------------------------------------------------------------
// computeRingGuideSpec
// ---------------------------------------------------------------------------

describe('computeRingGuideSpec', () => {
  const stats = (entries: [number, number, boolean][]) =>
    entries.map(([level, offset, unreachable]) => ({ level, offset, count: 1, unreachable }));

  it('creates one ring per level using the actual (adaptive) radii', () => {
    const spec = computeRingGuideSpec({
      levelStats: stats([[1, 60, false], [2, 145, false], [3, 210, false]]),
      maxHops: null,
    });

    expect(spec.rings.map((r) => r.radius)).toEqual([60, 145, 210]);
    // Labels carry ring population — "where is the mass?" without counting dots
    expect(spec.rings.map((r) => r.label)).toEqual(['1 · 1', '2 · 1', '3 · 1']);
    expect(spec.rings.every((r) => !r.dashed)).toBe(true);
  });

  it('renders the unreachable level as a dashed ring', () => {
    const spec = computeRingGuideSpec({
      levelStats: stats([[1, 60, false], [2, 120, true]]),
      maxHops: null,
    });

    expect(spec.rings[1].dashed).toBe(true);
    expect(spec.rings[1].label).toBe('unreachable · 1');
  });

  it('omits the count when a level is empty', () => {
    const spec = computeRingGuideSpec({
      levelStats: [{ level: 1, offset: 60, count: 0, unreachable: false }],
      maxHops: null,
    });

    expect(spec.rings[0].label).toBe('1');
  });

  it('omits rings hidden by the maxHops cutoff', () => {
    const spec = computeRingGuideSpec({
      levelStats: stats([[1, 60, false], [2, 120, false], [3, 180, true]]),
      maxHops: 2,
    });

    expect(spec.rings).toHaveLength(2);
    expect(spec.rings.every((r) => !r.dashed)).toBe(true);
  });

  it('skips level 0 (the focus has no ring)', () => {
    const spec = computeRingGuideSpec({ levelStats: stats([[0, 0, false]]), maxHops: null });
    expect(spec.rings).toHaveLength(0);
  });

  it('labels every ring by default (hideLabels is opt-in)', () => {
    const spec = computeRingGuideSpec({ levelStats: stats([[1, 60, false]]), maxHops: null });
    expect(spec.rings[0].label).toBe('1 · 1');
  });

  it('drops the captions but keeps the rings when hideLabels is on', () => {
    const levelStats = stats([[1, 60, false], [2, 145, false], [3, 210, true]]);
    const labelled = computeRingGuideSpec({ levelStats, maxHops: null });
    const bare = computeRingGuideSpec({ levelStats, maxHops: null, hideLabels: true });

    expect(bare.rings.map((r) => r.label)).toEqual([null, null, null]);
    // Geometry is untouched — toggling captions must never move a ring
    expect(bare.rings.map((r) => r.radius)).toEqual(labelled.rings.map((r) => r.radius));
    expect(bare.rings.map((r) => r.dashed)).toEqual(labelled.rings.map((r) => r.dashed));
    expect(bare.rings.map((r) => r.hop)).toEqual(labelled.rings.map((r) => r.hop));
  });

  it('still respects the maxHops cutoff with labels hidden', () => {
    const spec = computeRingGuideSpec({
      levelStats: stats([[1, 60, false], [2, 120, false], [3, 180, false]]),
      maxHops: 2,
      hideLabels: true,
    });

    expect(spec.rings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// computeTreeLayout
// ---------------------------------------------------------------------------

describe('computeTreeLayout', () => {
  const radialOpts = {
    mode: 'radial' as const,
    direction: 'both' as const,
    edgeTypes: null,
    levelSpacing: 60,
    nodeSpacing: 26,
    orphanPolicy: 'outer-ring' as const,
  };

  const layeredOpts = {
    mode: 'layered' as const,
    focusNodeId: null,
    direction: 'out' as const,
    edgeTypes: null,
    levelSpacing: 100,
    nodeSpacing: 40,
    layeredDirection: 'td' as const,
    orphanPolicy: 'adopt' as const,
  };

  it('radial: focus sits at the origin and each level lies on its ring radius', () => {
    const nodes = [node('f'), node('a'), node('b'), node('c')];
    const edges = [edge('f', 'a'), edge('f', 'b'), edge('a', 'c')];

    const result = computeTreeLayout(nodes, edges, { ...radialOpts, focusNodeId: 'f' });

    expect(result.positions.get('f')).toEqual({ x: 0, y: 0 });
    const ring1 = result.levelStats.find((s) => s.level === 1)!;
    for (const id of ['a', 'b']) {
      const pos = result.positions.get(id)!;
      expect(Math.hypot(pos.x, pos.y)).toBeCloseTo(ring1.offset);
    }
    expect(result.levels.get('c')).toBe(2);
  });

  it('radial: ring radii are monotonic and grow to fit crowded rings', () => {
    // 100 first-hop neighbors need circumference 100×26 → radius ≥ ~414, not 60
    const nodes = [node('f'), ...Array.from({ length: 100 }, (_, i) => node(`n${String(i).padStart(3, '0')}`))];
    const edges = nodes.slice(1).map((n) => edge('f', n.node_id));

    const result = computeTreeLayout(nodes, edges, { ...radialOpts, focusNodeId: 'f' });

    const ring1 = result.levelStats.find((s) => s.level === 1)!;
    expect(ring1.offset).toBeGreaterThanOrEqual((100 * 26) / (2 * Math.PI));
    // Neighbors on the ring are spread — min pairwise arc respects nodeSpacing approximately
    const angles = nodes.slice(1).map((n) => {
      const pos = result.positions.get(n.node_id)!;
      return Math.atan2(pos.y, pos.x);
    }).sort((a, b) => a - b);
    const minGap = Math.min(...angles.slice(1).map((a, i) => a - angles[i]));
    expect(minGap * ring1.offset).toBeGreaterThan(20); // ≈ nodeSpacing with rounding slack
  });

  it('radial: children sit near their parent angle (contiguous subtree sectors)', () => {
    // Two subtrees under the focus: a{a1,a2}, b{b1,b2}
    const nodes = [node('f'), node('a'), node('b'), node('a1'), node('a2'), node('b1'), node('b2')];
    const edges = [edge('f', 'a'), edge('f', 'b'), edge('a', 'a1'), edge('a', 'a2'), edge('b', 'b1'), edge('b', 'b2')];

    const result = computeTreeLayout(nodes, edges, { ...radialOpts, focusNodeId: 'f' });

    const angleOf = (id: string) => {
      const pos = result.positions.get(id)!;
      return Math.atan2(pos.y, pos.x);
    };
    // Parent angle is the mean of its children's — it lies between them
    const a = angleOf('a');
    expect(a).toBeGreaterThanOrEqual(Math.min(angleOf('a1'), angleOf('a2')));
    expect(a).toBeLessThanOrEqual(Math.max(angleOf('a1'), angleOf('a2')));
  });

  it('radial: unreachable nodes land on a dedicated dashed outer ring', () => {
    const nodes = [node('f'), node('a'), node('island1'), node('island2')];
    const edges = [edge('f', 'a')];

    const result = computeTreeLayout(nodes, edges, { ...radialOpts, focusNodeId: 'f' });

    expect(result.unreachable).toEqual(new Set(['island1', 'island2']));
    const outer = result.levelStats[result.levelStats.length - 1];
    expect(outer.unreachable).toBe(true);
    const pos = result.positions.get('island1')!;
    expect(Math.hypot(pos.x, pos.y)).toBeCloseTo(outer.offset);
    expect(result.levels.get('island1')).toBe(result.maxLevel + 1);
  });

  it('is deterministic: same input twice gives identical positions', () => {
    const nodes = [node('f'), node('b'), node('a'), node('c')];
    const edges = [edge('f', 'a'), edge('f', 'b'), edge('f', 'c')];

    const r1 = computeTreeLayout(nodes, edges, { ...radialOpts, focusNodeId: 'f' });
    const r2 = computeTreeLayout(nodes, edges, { ...radialOpts, focusNodeId: 'f' });

    for (const n of nodes) {
      expect(r1.positions.get(n.node_id)).toEqual(r2.positions.get(n.node_id));
    }
  });

  it('layered td: roots are in-degree-0 nodes, levels descend in -y, slots spaced in x', () => {
    // s1 → m1 → d1, s2 → m1  (s1, s2 are sources)
    const nodes = [node('s1'), node('s2'), node('m1'), node('d1')];
    const edges = [edge('s1', 'm1'), edge('s2', 'm1'), edge('m1', 'd1')];

    const result = computeTreeLayout(nodes, edges, layeredOpts);

    expect(new Set(result.roots)).toEqual(new Set(['s1', 's2']));
    expect(result.positions.get('s1')!.y).toBe(0);
    expect(result.positions.get('m1')!.y).toBe(-100);
    expect(result.positions.get('d1')!.y).toBe(-200);
    // Two source slots spaced by nodeSpacing
    const xs = [result.positions.get('s1')!.x, result.positions.get('s2')!.x].sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBeCloseTo(40);
  });

  it('layered lr: levels grow in +x', () => {
    const nodes = [node('s'), node('d')];
    const edges = [edge('s', 'd')];

    const result = computeTreeLayout(nodes, edges, { ...layeredOpts, layeredDirection: 'lr' });

    expect(result.positions.get('s')!.x).toBe(0);
    expect(result.positions.get('d')!.x).toBe(100);
  });

  it('layered: wide levels wrap into bounded sub-rows instead of one endless line', () => {
    // Bipartite fraud shape: 200 transactions (all roots) → 5 shared entities.
    // Without wrapping, level 0 would be 200 × nodeSpacing = 8000 wide (a hair-thin line).
    const txs = Array.from({ length: 200 }, (_, i) => node(`t${String(i).padStart(3, '0')}`));
    const entities = Array.from({ length: 5 }, (_, i) => node(`e${i}`));
    const nodes = [...txs, ...entities];
    const edges = txs.map((t, i) => edge(t.node_id, `e${i % 5}`));

    const result = computeTreeLayout(nodes, edges, layeredOpts);

    // perRow = max(8, ceil(1.5·√205)) = 22 → width bounded by ~22×40
    const xs = txs.map((t) => result.positions.get(t.node_id)!.x);
    const width = Math.max(...xs) - Math.min(...xs);
    expect(width).toBeLessThanOrEqual(22 * 40);

    // Level 0 became a band of multiple sub-rows...
    const ys = new Set(txs.map((t) => result.positions.get(t.node_id)!.y));
    expect(ys.size).toBeGreaterThan(5);

    // ...and level 1 starts below the whole band, not at -levelSpacing
    const level1 = result.levelStats.find((s) => s.level === 1)!;
    const level0Bottom = Math.min(...txs.map((t) => result.positions.get(t.node_id)!.y));
    expect(-level1.offset).toBeLessThan(level0Bottom);
  });

  it('layered: pure cycles are adopted via an extra root instead of being dropped', () => {
    // a → b → c → a (no in-degree-0 node)
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];

    const result = computeTreeLayout(nodes, edges, layeredOpts);

    expect(result.unreachable.size).toBe(0);
    expect(result.positions.size).toBe(3);
    expect(result.levels.get('a')).toBe(0); // smallest id adopted as root
    expect(result.levels.get('b')).toBe(1);
    expect(result.levels.get('c')).toBe(2);
  });

  it('layered adopt: disconnected components all get placed', () => {
    const nodes = [node('s'), node('d'), node('x'), node('y')];
    const edges = [edge('s', 'd'), edge('x', 'y')];

    const result = computeTreeLayout(nodes, edges, layeredOpts);

    expect(result.positions.size).toBe(4);
    expect(result.unreachable.size).toBe(0);
  });

  it('respects edgeTypes and traversal direction like computeEgoHops', () => {
    const nodes = [node('f'), node('a'), node('b')];
    const edges = [edge('f', 'a', 'TRANSFER'), edge('b', 'f', 'TRANSFER')];

    const result = computeTreeLayout(nodes, edges, {
      ...radialOpts,
      focusNodeId: 'f',
      direction: 'out',
    });

    expect(result.levels.get('a')).toBe(1);
    expect(result.unreachable.has('b')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeHiveAxesSpec
// ---------------------------------------------------------------------------

describe('computeHiveAxesSpec', () => {
  it('angles match the implicit axis angles of computeHivePositions', () => {
    // A node on axis i must lie exactly along the spec's axis direction
    const nodes = [node('a', 'A'), node('b', 'B'), node('c', 'C')];
    const positionsResult = computeHivePositions(
      nodes,
      { axisKey: 'node_type', maxAxes: 6, positionKey: 'degree', scale: 'rank', innerRadius: 40, outerRadius: 300 },
      { nodeDegrees: new Map([['a', 1], ['b', 1], ['c', 1]]) }
    );
    const spec = computeHiveAxesSpec({ axes: positionsResult.axes, innerRadius: 40, outerRadius: 300 });

    for (const id of ['a', 'b', 'c']) {
      const pos = positionsResult.positions.get(id)!;
      const axis = spec.axes[pos.axisIndex];
      // Cross product of node position and axis direction must be ~0 (collinear)
      const cross = pos.x * axis.outer.y - pos.y * axis.outer.x;
      expect(Math.abs(cross)).toBeLessThan(1e-6);
    }
  });

  it('places labels beyond the outer radius', () => {
    const spec = computeHiveAxesSpec({ axes: ['A', 'B'], innerRadius: 40, outerRadius: 300, labelOffset: 24 });

    for (const axis of spec.axes) {
      const labelRadius = Math.hypot(axis.labelPos.x, axis.labelPos.y);
      expect(labelRadius).toBeCloseTo(324);
    }
  });

  it('sets textAlign by quadrant so labels grow away from the axis tip', () => {
    const spec = computeHiveAxesSpec({ axes: ['right', 'up', 'left', 'down'], innerRadius: 0, outerRadius: 100 });

    expect(spec.axes[0].textAlign).toBe('left');   // +X → text extends rightward
    expect(spec.axes[1].textAlign).toBe('center'); // +Y (cos ≈ 0)
    expect(spec.axes[2].textAlign).toBe('right');  // -X
    expect(spec.axes[3].textAlign).toBe('center'); // -Y
  });

  it('handles an empty axes list', () => {
    expect(computeHiveAxesSpec({ axes: [], innerRadius: 40, outerRadius: 300 }).axes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeHiveLinkCurvatures
// ---------------------------------------------------------------------------

describe('computeHiveLinkCurvatures', () => {
  const positions = new Map([
    ['a1', { x: 10, y: 0, axisIndex: 0, axisLabel: 'A' }],
    ['a2', { x: 20, y: 0, axisIndex: 0, axisLabel: 'A' }],
    ['b1', { x: -10, y: 5, axisIndex: 1, axisLabel: 'B' }],
  ]);

  it('curves intra-axis links strongly and inter-axis links gently', () => {
    const intra = { source: 'a1', target: 'a2' };
    const inter = { source: 'a1', target: 'b1' };

    const result = computeHiveLinkCurvatures([intra, inter], positions);

    expect(result.get(intra)).toBe(0.5);
    expect(result.get(inter)).toBe(0.2);
  });

  it('accepts object endpoints (post-simulation links)', () => {
    const link = { source: { id: 'a1' }, target: { id: 'b1' } };

    const result = computeHiveLinkCurvatures([link], positions);

    expect(result.get(link)).toBe(0.2);
  });

  it('skips links with endpoints missing from positions (cluster/synthetic nodes)', () => {
    const link = { source: 'a1', target: 'cluster_x' };

    const result = computeHiveLinkCurvatures([link], positions);

    expect(result.has(link)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// circularMean
// ---------------------------------------------------------------------------

describe('circularMean', () => {
  it('is wraparound-safe: the mean of angles straddling 0 is ~0, not π', () => {
    // The whole point of averaging unit vectors instead of raw radians
    expect(circularMean([0.1, 2 * Math.PI - 0.1])!).toBeCloseTo(0, 6);
  });

  it('averages a simple spread', () => {
    expect(circularMean([0, Math.PI / 2])!).toBeCloseTo(Math.PI / 4, 6);
  });

  it('returns null when empty or when vectors cancel out', () => {
    expect(circularMean([])).toBeNull();
    expect(circularMean([0, Math.PI])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeTreeLayout — ring ordering strategies
// ---------------------------------------------------------------------------

describe('computeTreeLayout ring ordering', () => {
  const radialOpts = {
    mode: 'radial' as const,
    direction: 'both' as const,
    edgeTypes: null,
    levelSpacing: 60,
    nodeSpacing: 26,
    orphanPolicy: 'outer-ring' as const,
  };

  const angleOf = (result: { positions: Map<string, { x: number; y: number }> }, id: string) => {
    const pos = result.positions.get(id)!;
    return Math.atan2(pos.y, pos.x);
  };

  /** Shortest angular distance between two placed nodes. */
  const angularGap = (
    result: { positions: Map<string, { x: number; y: number }> },
    a: string,
    b: string
  ) => {
    let delta = Math.abs(angleOf(result, a) - angleOf(result, b)) % (2 * Math.PI);
    if (delta > Math.PI) delta = 2 * Math.PI - delta;
    return delta;
  };

  /**
   * Walk the nodes in angular order around the FULL circle and count how many
   * times the group label changes, wraparound included. A set of contiguous
   * sectors yields exactly one transition per sector boundary — so k groups
   * arranged contiguously give exactly k. Counting on a linear -π..π sort would
   * spuriously split whichever sector straddles the seam.
   */
  const circularTransitions = (
    result: { positions: Map<string, { x: number; y: number }> },
    ids: string[],
    groupOf: (id: string) => string
  ) => {
    const ordered = ids
      .map((id) => ({ group: groupOf(id), angle: angleOf(result, id) }))
      .sort((x, y) => x.angle - y.angle)
      .map((entry) => entry.group);
    return ordered.filter((group, i) => group !== ordered[(i + ordered.length - 1) % ordered.length]).length;
  };

  it('defaults to id ordering (regression: omitting the option === explicit id)', () => {
    const nodes = [node('f'), node('a'), node('b'), node('c'), node('d')];
    const edges = [edge('f', 'a'), edge('f', 'b'), edge('f', 'c'), edge('f', 'd'), edge('a', 'd')];

    const implicit = computeTreeLayout(nodes, edges, { ...radialOpts, focusNodeId: 'f' });
    const explicit = computeTreeLayout(nodes, edges, {
      ...radialOpts,
      focusNodeId: 'f',
      ringOrdering: 'id',
    });

    for (const n of nodes) {
      expect(implicit.positions.get(n.node_id)).toEqual(explicit.positions.get(n.node_id));
    }
    expect(implicit.ringOrderingDegraded).toBe(false);
  });

  it('exposes the BFS forest as parents (roots excluded)', () => {
    const nodes = [node('f'), node('a'), node('b')];
    const edges = [edge('f', 'a'), edge('a', 'b')];

    const result = computeTreeLayout(nodes, edges, { ...radialOpts, focusNodeId: 'f' });

    expect(result.parents.get('a')).toBe('f');
    expect(result.parents.get('b')).toBe('a');
    expect(result.parents.has('f')).toBe(false);
  });

  it('barycenter: pulls subtrees linked by a non-tree edge angularly closer', () => {
    // Four hop-1 subtrees in id order a,b,c,d. The only non-tree edge joins the
    // leaves of the FIRST and LAST subtrees, so id order puts them far apart.
    const nodes = [
      node('f'),
      node('a'), node('b'), node('c'), node('d'),
      node('a1'), node('b1'), node('c1'), node('d1'),
    ];
    const edges = [
      edge('f', 'a'), edge('f', 'b'), edge('f', 'c'), edge('f', 'd'),
      edge('a', 'a1'), edge('b', 'b1'), edge('c', 'c1'), edge('d', 'd1'),
      edge('a1', 'd1'), // the crossing chord to be minimized
    ];

    const byId = computeTreeLayout(nodes, edges, { ...radialOpts, focusNodeId: 'f', ringOrdering: 'id' });
    const byBarycenter = computeTreeLayout(nodes, edges, {
      ...radialOpts,
      focusNodeId: 'f',
      ringOrdering: 'barycenter',
    });

    expect(angularGap(byBarycenter, 'a1', 'd1')).toBeLessThan(angularGap(byId, 'a1', 'd1'));
  });

  it('barycenter: subtrees remain contiguous angular sectors', () => {
    const nodes = [
      node('f'), node('a'), node('b'),
      node('a1'), node('a2'), node('b1'), node('b2'),
    ];
    const edges = [
      edge('f', 'a'), edge('f', 'b'),
      edge('a', 'a1'), edge('a', 'a2'), edge('b', 'b1'), edge('b', 'b2'),
      edge('a1', 'b1'),
    ];

    const result = computeTreeLayout(nodes, edges, {
      ...radialOpts,
      focusNodeId: 'f',
      ringOrdering: 'barycenter',
    });

    // No member of subtree B may fall angularly between the two members of subtree A:
    // two contiguous sectors around the circle = exactly two boundaries
    expect(circularTransitions(result, ['a1', 'a2', 'b1', 'b2'], (id) => id[0])).toBe(2);
  });

  it('node-type: groups siblings into contiguous sectors by type', () => {
    const nodes = [
      node('f', 'Focus'),
      node('p1', 'Person'), node('c1', 'Company'),
      node('p2', 'Person'), node('c2', 'Company'),
    ];
    const edges = ['p1', 'c1', 'p2', 'c2'].map((id) => edge('f', id));

    const result = computeTreeLayout(nodes, edges, {
      ...radialOpts,
      focusNodeId: 'f',
      ringOrdering: 'node-type',
    });

    const transitions = circularTransitions(result, ['p1', 'p2', 'c1', 'c2'], (id) =>
      id.startsWith('p') ? 'Person' : 'Company'
    );
    expect(transitions).toBe(2); // two contiguous sectors
  });

  it('node-type: nodes missing the attribute form ONE trailing sector, never scattered', () => {
    // Heterogeneous graph: some nodes simply lack the field
    const nodes = [
      node('f', 'Focus'),
      node('p1', 'Person'), node('p2', 'Person'),
      { node_id: 'x1' }, { node_id: 'x2' }, // no node_type at all
    ];
    const edges = ['p1', 'p2', 'x1', 'x2'].map((id) => edge('f', id));

    const result = computeTreeLayout(nodes, edges, {
      ...radialOpts,
      focusNodeId: 'f',
      ringOrdering: 'node-type',
    });

    expect(result.ringOrderingDegraded).toBe(false);
    // All four are placed — missing-attribute nodes are never hidden
    for (const id of ['p1', 'p2', 'x1', 'x2']) {
      expect(result.positions.has(id)).toBe(true);
    }
    // The two attribute-less nodes sit next to each other (one contiguous block)
    const transitions = circularTransitions(result, ['p1', 'p2', 'x1', 'x2'], (id) =>
      id.startsWith('x') ? 'missing' : 'present'
    );
    expect(transitions).toBe(2);
  });

  it('flags degradation and falls back to id order when NO node carries the attribute', () => {
    const nodes = [{ node_id: 'f' }, { node_id: 'a' }, { node_id: 'b' }];
    const edges = [edge('f', 'a'), edge('f', 'b')];

    const degraded = computeTreeLayout(nodes, edges, {
      ...radialOpts,
      focusNodeId: 'f',
      ringOrdering: 'property',
      ringOrderingKey: 'jurisdiction',
    });
    const byId = computeTreeLayout(nodes, edges, { ...radialOpts, focusNodeId: 'f', ringOrdering: 'id' });

    expect(degraded.ringOrderingDegraded).toBe(true);
    for (const n of nodes) {
      expect(degraded.positions.get(n.node_id)).toEqual(byId.positions.get(n.node_id));
    }
  });

  it('property: sectors by property value and accepts the prop: prefix', () => {
    const nodes = [
      node('f', 'Focus'),
      node('a', 'Merchant', { mcc: 'fuel' }),
      node('b', 'Merchant', { mcc: 'food' }),
      node('c', 'Merchant', { mcc: 'fuel' }),
      node('d', 'Merchant', { mcc: 'food' }),
    ];
    const edges = ['a', 'b', 'c', 'd'].map((id) => edge('f', id));

    const bare = computeTreeLayout(nodes, edges, {
      ...radialOpts, focusNodeId: 'f', ringOrdering: 'property', ringOrderingKey: 'mcc',
    });
    const prefixed = computeTreeLayout(nodes, edges, {
      ...radialOpts, focusNodeId: 'f', ringOrdering: 'property', ringOrderingKey: 'prop:mcc',
    });

    for (const n of nodes) {
      expect(bare.positions.get(n.node_id)).toEqual(prefixed.positions.get(n.node_id));
    }
    const transitions = circularTransitions(bare, ['a', 'c', 'b', 'd'], (id) =>
      id === 'a' || id === 'c' ? 'fuel' : 'food'
    );
    expect(transitions).toBe(2);
  });

  it('community: sectors by community, and an empty map degrades to id order', () => {
    const nodes = [node('f'), node('a'), node('b'), node('c'), node('d')];
    const edges = ['a', 'b', 'c', 'd'].map((id) => edge('f', id));
    const communityMap = new Map([['a', 1], ['b', 0], ['c', 1], ['d', 0]]);

    const grouped = computeTreeLayout(nodes, edges, {
      ...radialOpts, focusNodeId: 'f', ringOrdering: 'community', communityMap,
    });
    const empty = computeTreeLayout(nodes, edges, {
      ...radialOpts, focusNodeId: 'f', ringOrdering: 'community', communityMap: new Map(),
    });
    const byId = computeTreeLayout(nodes, edges, { ...radialOpts, focusNodeId: 'f', ringOrdering: 'id' });

    const transitions = circularTransitions(grouped, ['a', 'c', 'b', 'd'], (id) =>
      String(communityMap.get(id))
    );
    expect(transitions).toBe(2);

    expect(empty.ringOrderingDegraded).toBe(true);
    for (const n of nodes) {
      expect(empty.positions.get(n.node_id)).toEqual(byId.positions.get(n.node_id));
    }
  });

  it('unreachable ring: non-id ordering parks orphans near the neighbours they do have', () => {
    // 'island' connects only via an edge type excluded from traversal, so it is
    // unreachable, but it still has a drawn neighbour whose angle it should track.
    const nodes = [node('f'), node('a'), node('b'), node('c'), node('island')];
    const edges = [
      edge('f', 'a'), edge('f', 'b'), edge('f', 'c'),
      edge('island', 'c', 'SIMILAR'),
    ];
    const opts = { ...radialOpts, focusNodeId: 'f', edgeTypes: ['TRANSFER'] };

    const result = computeTreeLayout(nodes, edges, { ...opts, ringOrdering: 'barycenter' });

    expect(result.unreachable.has('island')).toBe(true);
    // Placed on the dedicated outer ring, still drawn
    expect(result.positions.has('island')).toBe(true);
    expect(result.levels.get('island')).toBe(result.maxLevel + 1);
  });

  it('honours nodeSpacing as a real minimum on a lopsided ring', () => {
    // Regression: ring radius used to be sized by count alone, which assumes an
    // even angular spread. The tidy-tree allocates angular width per LEAF, so a
    // ring mixing a deep bushy subtree with a shallow one packed the shallow side
    // far tighter than the average implied — measured 13.7 units of arc against a
    // contract of 26. Convergence stars like this are the common fraud shape.
    const nodes: { node_id: string }[] = [{ node_id: 'f' }, { node_id: 'h' }, { node_id: 'c' }];
    const edges = [edge('f', 'h'), edge('f', 'c')];
    for (let i = 0; i < 10; i++) {
      const mid = `m${String(i).padStart(2, '0')}`;
      nodes.push({ node_id: mid });
      edges.push(edge('h', mid));
      for (let j = 0; j < 5; j++) {
        nodes.push({ node_id: `${mid}_l${j}` });
        edges.push(edge(mid, `${mid}_l${j}`));
      }
    }
    for (let j = 0; j < 5; j++) {
      nodes.push({ node_id: `c_l${j}` });
      edges.push(edge('c', `c_l${j}`));
    }

    const nodeSpacing = 26;
    const result = computeTreeLayout(nodes, edges, {
      ...radialOpts, focusNodeId: 'f', nodeSpacing, ringOrdering: 'id',
    });

    for (const level of [2, 3]) {
      const radius = result.levelStats.find((s) => s.level === level)!.offset;
      const angles = [...result.levels.entries()]
        .filter(([, l]) => l === level)
        .map(([id]) => angleOf(result, id))
        .sort((a, b) => a - b);
      let minGap = angles[0] + 2 * Math.PI - angles[angles.length - 1]; // wraparound
      for (let i = 1; i < angles.length; i++) minGap = Math.min(minGap, angles[i] - angles[i - 1]);

      expect(minGap * radius).toBeGreaterThanOrEqual(nodeSpacing - 1e-6);
    }
  });

  it('reports non-tree and same-ring edge counts', () => {
    // A pure convergence star has no non-tree edges — crossing reduction is a
    // no-op there, which the panel explains instead of silently doing nothing.
    const starNodes = [node('f'), node('a'), node('b'), node('c')];
    const starEdges = ['a', 'b', 'c'].map((id) => edge('f', id));
    const star = computeTreeLayout(starNodes, starEdges, { ...radialOpts, focusNodeId: 'f' });

    expect(star.nonTreeEdgeCount).toBe(0);
    expect(star.sameRingEdgeCount).toBe(0);

    // 'd' hangs off 'c' so it sits on ring 2: a–b is the only same-ring edge,
    // while b–d spans rings (non-tree, but not arced along a ring).
    const lateral = computeTreeLayout(
      [...starNodes, node('d')],
      [...starEdges, edge('c', 'd'), edge('a', 'b'), edge('b', 'd')],
      { ...radialOpts, focusNodeId: 'f' }
    );

    expect(lateral.levels.get('d')).toBe(2);
    expect(lateral.sameRingEdgeCount).toBe(1); // a–b, both on ring 1
    expect(lateral.nonTreeEdgeCount).toBe(2); // a–b and b–d
  });

  it('every strategy is deterministic across runs', () => {
    const nodes = [
      node('f', 'Focus'),
      node('a', 'Person', { seg: 'x' }), node('b', 'Company', { seg: 'y' }),
      node('c', 'Person', { seg: 'y' }), node('d', 'Company', { seg: 'x' }),
    ];
    const edges = [
      ...['a', 'b', 'c', 'd'].map((id) => edge('f', id)),
      edge('a', 'd'), edge('b', 'c'),
    ];
    const communityMap = new Map([['a', 0], ['b', 1], ['c', 0], ['d', 1]]);
    const strategies = ['id', 'barycenter', 'node-type', 'community', 'property'] as const;

    for (const ringOrdering of strategies) {
      const opts = {
        ...radialOpts, focusNodeId: 'f', ringOrdering, ringOrderingKey: 'seg', communityMap,
      };
      const first = computeTreeLayout(nodes, edges, opts);
      const second = computeTreeLayout(nodes, edges, opts);
      for (const n of nodes) {
        expect(first.positions.get(n.node_id)).toEqual(second.positions.get(n.node_id));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// computeEgoLinkCurvatures
// ---------------------------------------------------------------------------

describe('computeEgoLinkCurvatures', () => {
  /** Peak radius of the quadratic Bézier the renderer builds for a given curvature. */
  function arcPeakRadius(
    source: { x: number; y: number },
    target: { x: number; y: number },
    curvature: number
  ) {
    // calcLinkCurve: control = midpoint + curvature * (dy, -dx); B(0.5) = M/2 + C/2
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const mid = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
    const control = { x: mid.x + curvature * dy, y: mid.y - curvature * dx };
    const peak = { x: mid.x / 2 + control.x / 2, y: mid.y / 2 + control.y / 2 };
    return Math.hypot(peak.x, peak.y);
  }

  /** Two nodes on a ring of radius r, plus the deps a same-ring case needs. */
  function ringFixture(radius: number, angleA: number, angleB: number, gap = 60) {
    const positions = new Map([
      ['a', { x: radius * Math.cos(angleA), y: radius * Math.sin(angleA) }],
      ['b', { x: radius * Math.cos(angleB), y: radius * Math.sin(angleB) }],
    ]);
    return {
      positions,
      levels: new Map([['a', 1], ['b', 1]]),
      parents: new Map<string, string>(),
      levelStats: [
        { level: 1, offset: radius, count: 2, unreachable: false },
        { level: 2, offset: radius + gap, count: 0, unreachable: false },
      ],
    };
  }

  it('keeps BFS tree edges perfectly straight (the radial skeleton)', () => {
    const link = { source: 'f', target: 'a' };
    const deps = {
      positions: new Map([['f', { x: 0, y: 0 }], ['a', { x: 100, y: 0 }]]),
      levels: new Map([['f', 0], ['a', 1]]),
      parents: new Map([['a', 'f']]),
      levelStats: [{ level: 1, offset: 100, count: 1, unreachable: false }],
    };

    expect(computeEgoLinkCurvatures([link], deps).get(link)).toBe(0);
  });

  it('same-ring arc peaks outside its own ring but never reaches the next one', () => {
    const radius = 200;
    const gap = 60;
    for (const separation of [Math.PI / 6, Math.PI / 2, Math.PI * 0.9]) {
      const deps = ringFixture(radius, 0, separation, gap);
      const link = { source: 'a', target: 'b' };

      const curvature = computeEgoLinkCurvatures([link], deps).get(link)!;
      const peak = arcPeakRadius(deps.positions.get('a')!, deps.positions.get('b')!, curvature);

      expect(peak).toBeGreaterThan(radius - 1e-6);
      expect(peak).toBeLessThanOrEqual(radius + 0.6 * gap + 1e-6);
    }
  });

  it('bulges outward regardless of travel direction (sign flips with the endpoints)', () => {
    const deps = ringFixture(200, 0, Math.PI / 3);
    const forward = { source: 'a', target: 'b' };
    const reverse = { source: 'b', target: 'a' };

    const result = computeEgoLinkCurvatures([forward, reverse], deps);

    expect(result.get(forward)).toBeCloseTo(-result.get(reverse)!, 9);
    // Both still peak outside the ring — the renderer's perpendicular flips too
    for (const [link, [from, to]] of [[forward, ['a', 'b']], [reverse, ['b', 'a']]] as const) {
      const peak = arcPeakRadius(deps.positions.get(from)!, deps.positions.get(to)!, result.get(link)!);
      expect(peak).toBeGreaterThan(200 - 1e-6);
    }
  });

  it('gives cross-ring shortcuts a gentle, bounded fan', () => {
    const link = { source: 'a', target: 'b' };
    const deps = {
      positions: new Map([['a', { x: 100, y: 0 }], ['b', { x: 0, y: 300 }]]),
      levels: new Map([['a', 1], ['b', 3]]),
      parents: new Map<string, string>(),
      levelStats: [
        { level: 1, offset: 100, count: 1, unreachable: false },
        { level: 3, offset: 300, count: 1, unreachable: false },
      ],
    };

    const curvature = computeEgoLinkCurvatures([link], deps).get(link)!;

    expect(Math.abs(curvature)).toBeGreaterThan(0);
    expect(Math.abs(curvature)).toBeLessThanOrEqual(0.3);
  });

  it('composes with the multi-edge fan so parallel edges stay apart', () => {
    const deps = ringFixture(200, 0, Math.PI / 3);
    const first = { source: 'a', target: 'b' };
    const second = { source: 'a', target: 'b' };
    const bases = new Map([[first, 0.15], [second, 0.3]]);

    const withFan = computeEgoLinkCurvatures([first, second], {
      ...deps,
      baseCurvature: (link) => bases.get(link as typeof first) ?? 0,
    });
    const withoutFan = computeEgoLinkCurvatures([first], deps).get(first)!;

    // Parallel edges stay distinct and ordered, offset from the plain arc in the
    // same direction as their fan value (magnitudes may be compressed to fit the
    // ring corridor — see the headroom test below).
    expect(withFan.get(first)).toBeGreaterThan(withoutFan);
    expect(withFan.get(second)).toBeGreaterThan(withFan.get(first)!);
  });

  it('keeps arc + multi-edge fan inside the ring corridor', () => {
    // Regression: the fan used to be added AFTER the arc was clamped, pushing the
    // peak well past the neighbouring ring (measured 343.8 with the next ring at
    // 260). Parallel transfers are the norm in transaction graphs, so this fired
    // constantly.
    const radius = 200;
    const gap = 60;
    const deps = ringFixture(radius, 0, Math.PI * 0.9, gap);
    const link = { source: 'a', target: 'b' };

    const curvature = computeEgoLinkCurvatures([link], {
      ...deps,
      baseCurvature: () => 0.6, // the CAP in getMultiEdgeCurvature3D
    }).get(link)!;
    const peak = arcPeakRadius(deps.positions.get('a')!, deps.positions.get('b')!, curvature);

    expect(peak).toBeLessThanOrEqual(radius + 0.9 * gap + 1e-6);
    expect(peak).toBeLessThan(radius + gap); // never reaches the next ring
  });

  it('still arcs when the ego graph has only one ring', () => {
    // Regression: a lone levelStat left gapByLevel at 0, so peakLimit collapsed to
    // the ring radius and the arc flattened onto it. maxHops=1 hits this.
    const radius = 200;
    const link = { source: 'a', target: 'b' };
    const deps = {
      positions: new Map([
        ['a', { x: radius, y: 0 }],
        ['b', { x: radius * Math.cos(Math.PI / 6), y: radius * Math.sin(Math.PI / 6) }],
      ]),
      levels: new Map([['a', 1], ['b', 1]]),
      parents: new Map<string, string>(),
      levelStats: [{ level: 1, offset: radius, count: 2, unreachable: false }],
      levelSpacing: 60,
    };

    const curvature = computeEgoLinkCurvatures([link], deps).get(link)!;
    const peak = arcPeakRadius(deps.positions.get('a')!, deps.positions.get('b')!, curvature);

    expect(peak).toBeGreaterThan(radius);
  });

  it('holds the arc on one side for near-antipodal endpoints', () => {
    // delta sits at the wrap seam; sub-pixel jitter must not flip the arc over
    const radius = 200;
    const nudge = 1e-9;
    const sides = [Math.PI - nudge, Math.PI, Math.PI + nudge].map((sep) => {
      const deps = ringFixture(radius, 0, sep);
      const link = { source: 'a', target: 'b' };
      return Math.sign(computeEgoLinkCurvatures([link], deps).get(link)!);
    });

    expect(new Set(sides).size).toBe(1);
  });

  it('caps how far a long cross-ring edge may bow', () => {
    // A ring-1 → ring-5 chord is long enough that a curvature of 0.3 displaces it
    // across every ring in between; the bow is bounded in world units instead.
    const levelSpacing = 60;
    const link = { source: 'a', target: 'b' };
    const source = { x: 145, y: 0 };
    const target = { x: 0, y: 500 };
    const deps = {
      positions: new Map([['a', source], ['b', target]]),
      levels: new Map([['a', 1], ['b', 5]]),
      parents: new Map<string, string>(),
      levelStats: [
        { level: 1, offset: 145, count: 1, unreachable: false },
        { level: 5, offset: 500, count: 1, unreachable: false },
      ],
      levelSpacing,
    };

    const curvature = computeEgoLinkCurvatures([link], deps).get(link)!;
    const chord = Math.hypot(target.x - source.x, target.y - source.y);

    expect(Math.abs(curvature) * chord).toBeLessThanOrEqual(0.5 * levelSpacing + 1e-6);
  });

  it('skips self-loops and endpoints missing from positions', () => {
    const deps = ringFixture(200, 0, Math.PI / 3);
    const selfLoop = { source: 'a', target: 'a' };
    const synthetic = { source: 'a', target: 'cluster_x' };

    const result = computeEgoLinkCurvatures([selfLoop, synthetic], deps);

    expect(result.has(selfLoop)).toBe(false);
    expect(result.has(synthetic)).toBe(false);
  });

  it('is deterministic for radially collinear endpoints (no meaningful side)', () => {
    const link = { source: 'a', target: 'b' };
    const deps = {
      positions: new Map([['a', { x: 100, y: 0 }], ['b', { x: 200, y: 0 }]]),
      levels: new Map([['a', 1], ['b', 2]]),
      parents: new Map<string, string>(),
      levelStats: [
        { level: 1, offset: 100, count: 1, unreachable: false },
        { level: 2, offset: 200, count: 1, unreachable: false },
      ],
    };

    const first = computeEgoLinkCurvatures([link], deps).get(link);
    const second = computeEgoLinkCurvatures([link], deps).get(link);

    expect(first).toBe(second);
    expect(Math.abs(first!)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Crossing-reduction heuristics
// ---------------------------------------------------------------------------

describe('crossing heuristics', () => {
  const radialOpts = {
    mode: 'radial' as const,
    focusNodeId: 'f',
    direction: 'both' as const,
    edgeTypes: null,
    levelSpacing: 60,
    nodeSpacing: 26,
    orphanPolicy: 'outer-ring' as const,
  };

  /** A convergence star: one focus, N alters on ring 1, plus lateral chords. */
  function star(n: number, lateralCount: number, seed0 = 42) {
    const nodes = [{ node_id: 'f' }];
    const edges: { src: string; dst: string; relationship_type: string }[] = [];
    const id = (i: number) => `n${String(i).padStart(3, '0')}`;
    for (let i = 0; i < n; i++) {
      nodes.push({ node_id: id(i) });
      edges.push({ src: 'f', dst: id(i), relationship_type: 'T' });
    }
    let seed = seed0;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let k = 0; k < lateralCount; k++) {
      const a = Math.floor(rnd() * n);
      const b = Math.floor(rnd() * n);
      if (a !== b) edges.push({ src: id(a), dst: id(b), relationship_type: 'T' });
    }
    return { nodes, edges };
  }

  /** Geometric crossing count over the drawn non-tree edges. */
  function countCrossings(
    result: { positions: Map<string, { x: number; y: number }>; parents: Map<string, string> },
    edges: { src: string; dst: string }[]
  ) {
    const segments: { a: { x: number; y: number }; b: { x: number; y: number }; s: string; t: string }[] = [];
    for (const e of edges) {
      if (result.parents.get(e.dst) === e.src || result.parents.get(e.src) === e.dst) continue;
      const a = result.positions.get(e.src);
      const b = result.positions.get(e.dst);
      if (a && b) segments.push({ a, b, s: e.src, t: e.dst });
    }
    const ccw = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) =>
      (r.y - p.y) * (q.x - p.x) > (q.y - p.y) * (r.x - p.x);
    let total = 0;
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const u = segments[i];
        const v = segments[j];
        if (u.s === v.s || u.s === v.t || u.t === v.s || u.t === v.t) continue;
        if (ccw(u.a, v.a, v.b) !== ccw(u.b, v.a, v.b) && ccw(u.a, u.b, v.a) !== ccw(u.a, u.b, v.b)) total++;
      }
    }
    return total;
  }

  it('sifting massively outperforms the sweeps on a convergence star', () => {
    // The sweeps can only reorder siblings by an angle estimate; with one parent
    // that is almost no freedom (measured 455 → 443, ~2.6%). Sifting tries each
    // node at every position against a real crossing count.
    const { nodes, edges } = star(40, 60);

    const byId = computeTreeLayout(nodes, edges, { ...radialOpts, ringOrdering: 'id' });
    const bySweep = computeTreeLayout(nodes, edges, { ...radialOpts, ringOrdering: 'barycenter' });
    const bySifting = computeTreeLayout(nodes, edges, {
      ...radialOpts, ringOrdering: 'barycenter', crossingHeuristic: 'sifting',
    });

    const idCount = countCrossings(byId, edges);
    const siftCount = countCrossings(bySifting, edges);

    expect(siftCount).toBeLessThan(countCrossings(bySweep, edges));
    expect(siftCount).toBeLessThan(idCount * 0.5); // in practice ~85% fewer
  });

  it('median never does worse than the mean on the same fixture', () => {
    const { nodes, edges } = star(40, 60);

    const mean = computeTreeLayout(nodes, edges, { ...radialOpts, ringOrdering: 'barycenter' });
    const median = computeTreeLayout(nodes, edges, {
      ...radialOpts, ringOrdering: 'barycenter', crossingHeuristic: 'median',
    });

    expect(countCrossings(median, edges)).toBeLessThanOrEqual(countCrossings(mean, edges));
  });

  it('every heuristic is deterministic', () => {
    const { nodes, edges } = star(20, 30);
    for (const crossingHeuristic of ['barycenter', 'median', 'sifting'] as const) {
      const opts = { ...radialOpts, ringOrdering: 'barycenter' as const, crossingHeuristic };
      const first = computeTreeLayout(nodes, edges, opts);
      const second = computeTreeLayout(nodes, edges, opts);
      for (const n of nodes) {
        expect(first.positions.get(n.node_id)).toEqual(second.positions.get(n.node_id));
      }
    }
  });

  it('skips sifting when a ring is too DENSE, not just too large', () => {
    // Cost scales with size AND density: a 100-node ring is ~66ms sparse but
    // ~440ms dense. A size-only cap would wave the dense one through.
    const sparse = star(30, 5);
    const dense = star(30, 200);

    const sparseResult = computeTreeLayout(sparse.nodes, sparse.edges, {
      ...radialOpts, ringOrdering: 'barycenter', crossingHeuristic: 'sifting',
      siftingMaxRingSize: 1000, siftingWorkBudget: 2000,
    });
    const denseResult = computeTreeLayout(dense.nodes, dense.edges, {
      ...radialOpts, ringOrdering: 'barycenter', crossingHeuristic: 'sifting',
      siftingMaxRingSize: 1000, siftingWorkBudget: 2000,
    });

    // Same ring size, same size cap — only the chord count differs
    expect(sparseResult.siftingSkippedLargeRing).toBe(false);
    expect(denseResult.siftingSkippedLargeRing).toBe(true);
  });

  it('skips sifting on rings past the size budget and reports it', () => {
    // Sifting cost grows steeply with ring size, and the layout re-runs inside a
    // 150ms debounce — a huge ring must fall back rather than stall the UI.
    const { nodes, edges } = star(30, 20);

    const within = computeTreeLayout(nodes, edges, {
      ...radialOpts, ringOrdering: 'barycenter', crossingHeuristic: 'sifting', siftingMaxRingSize: 100,
    });
    const exceeded = computeTreeLayout(nodes, edges, {
      ...radialOpts, ringOrdering: 'barycenter', crossingHeuristic: 'sifting', siftingMaxRingSize: 10,
    });
    const sweepOnly = computeTreeLayout(nodes, edges, { ...radialOpts, ringOrdering: 'barycenter' });

    expect(within.siftingSkippedLargeRing).toBe(false);
    expect(exceeded.siftingSkippedLargeRing).toBe(true);
    // Skipped means it kept the cheap sweep result verbatim
    for (const n of nodes) {
      expect(exceeded.positions.get(n.node_id)).toEqual(sweepOnly.positions.get(n.node_id));
    }
  });

  it('crossingSweeps tunes the sweep count, and 0 disables the sweeps', () => {
    const { nodes, edges } = star(20, 30);

    const zero = computeTreeLayout(nodes, edges, {
      ...radialOpts, ringOrdering: 'barycenter', crossingSweeps: 0,
    });
    const byId = computeTreeLayout(nodes, edges, { ...radialOpts, ringOrdering: 'id' });
    const many = computeTreeLayout(nodes, edges, {
      ...radialOpts, ringOrdering: 'barycenter', crossingSweeps: 8,
    });

    // Zero sweeps leaves the id ordering untouched
    for (const n of nodes) {
      expect(zero.positions.get(n.node_id)).toEqual(byId.positions.get(n.node_id));
    }
    expect(many.positions.size).toBe(byId.positions.size);
  });

  it('circularMedian ignores outliers the mean chases', () => {
    // Three angles clustered near 0 and one far away: the median stays with the
    // cluster, the mean is dragged toward the outlier.
    const angles = [0.05, 0, -0.05, 2.5];

    const median = circularMedian(angles)!;
    const mean = circularMean(angles)!;

    expect(Math.abs(median)).toBeLessThan(0.1);
    expect(Math.abs(mean)).toBeGreaterThan(Math.abs(median));
  });

  it('circularMedian is wraparound-safe and handles small inputs', () => {
    expect(circularMedian([])).toBeNull();
    expect(circularMedian([1.2])!).toBeCloseTo(1.2, 9);
    expect(Math.abs(circularMedian([0.1, -0.1, 0.05, 2 * Math.PI - 0.05])!)).toBeLessThan(0.2);
  });
});
