import { describe, it, expect } from 'vitest';
import {
  computeEgoHops,
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
    expect(spec.rings.map((r) => r.label)).toEqual(['1', '2', '3']);
    expect(spec.rings.every((r) => !r.dashed)).toBe(true);
  });

  it('renders the unreachable level as a dashed ring', () => {
    const spec = computeRingGuideSpec({
      levelStats: stats([[1, 60, false], [2, 120, true]]),
      maxHops: null,
    });

    expect(spec.rings[1].dashed).toBe(true);
    expect(spec.rings[1].label).toBe('unreachable');
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
