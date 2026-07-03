import { describe, it, expect } from 'vitest';
import { settleLayoutHeadless, type SettleNode, type SettleLink } from '../headlessLayout';
import type { Force3DSettings } from '../forceConfig3D';

// Mirrors the store's force3DSettings defaults
function makeSettings(overrides: Partial<Force3DSettings> = {}): Force3DSettings {
  return {
    d3AlphaDecay: 0.0228,
    d3VelocityDecay: 0.4,
    d3AlphaMin: 0.001,
    d3AlphaTarget: 0,
    d3ChargeStrength: -80,
    d3Theta: 0.9,
    d3DistanceMin: 1,
    d3DistanceMax: Infinity,
    d3LinkDistance: 30,
    d3CenterStrength: 1,
    d3GravityStrength: 0.03,
    d3CollideEnabled: true,
    d3CollideRadius: 10,
    d3CollideStrength: 0.7,
    d3CollideIterations: 1,
    pointerRepulsionEnabled: true,
    pointerVacuumEnabled: false,
    pointerRepulsionStrength: 150,
    pointerRepulsionRange: 200,
    pointerSizeInertia: true,
    clippingPlaneEnabled: false,
    clippingPlaneDistance: 0,
    ...overrides,
  };
}

function makeGraph(n: number): { nodes: SettleNode[]; links: SettleLink[] } {
  const nodes: SettleNode[] = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, size: 1 }));
  const links: SettleLink[] = Array.from({ length: n - 1 }, (_, i) => ({
    source: `n${i}`,
    target: `n${i + 1}`,
  }));
  return { nodes, links };
}

// Immediate yield so tests don't wait on real timers
const immediate = () => Promise.resolve();

const allFinite = (nodes: SettleNode[], keys: (keyof SettleNode)[]) =>
  nodes.every((node) => keys.every((k) => Number.isFinite(node[k] as number)));

describe('settleLayoutHeadless', () => {
  it('settles a 2D graph: finite x/y, z stays 0, returns ticks', async () => {
    const { nodes, links } = makeGraph(40);
    const ticks = await settleLayoutHeadless(nodes, links, makeSettings(), {
      numDimensions: 2,
      yieldToEventLoop: immediate,
    });

    expect(ticks).toBeGreaterThan(0);
    expect(allFinite(nodes, ['x', 'y'])).toBe(true);
    // 2D: z should be absent/zero for every node
    expect(nodes.every((node) => (node.z ?? 0) === 0)).toBe(true);
    // Nodes must not all collapse to the same point
    const uniqueX = new Set(nodes.map((node) => Math.round(node.x!)));
    expect(uniqueX.size).toBeGreaterThan(1);
  });

  it('settles a 3D graph: z becomes non-trivial', async () => {
    const { nodes, links } = makeGraph(40);
    await settleLayoutHeadless(nodes, links, makeSettings(), {
      numDimensions: 3,
      yieldToEventLoop: immediate,
    });

    expect(allFinite(nodes, ['x', 'y', 'z'])).toBe(true);
    expect(nodes.some((node) => Math.abs(node.z!) > 0.001)).toBe(true);
  });

  it('does NOT mutate the caller links (source/target stay strings)', async () => {
    const { nodes, links } = makeGraph(20);
    await settleLayoutHeadless(nodes, links, makeSettings(), {
      yieldToEventLoop: immediate,
    });

    expect(links.every((l) => typeof l.source === 'string' && typeof l.target === 'string')).toBe(true);
  });

  it('reports progress ending at 1', async () => {
    const { nodes, links } = makeGraph(15);
    const progress: number[] = [];
    await settleLayoutHeadless(nodes, links, makeSettings(), {
      yieldToEventLoop: immediate,
      onProgress: (f) => progress.push(f),
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.every((f) => f >= 0 && f <= 1)).toBe(true);
  });

  it('handles an empty graph without ticking', async () => {
    const ticks = await settleLayoutHeadless([], [], makeSettings(), {
      yieldToEventLoop: immediate,
    });
    expect(ticks).toBe(0);
  });

  it('respects maxTicks as a hard cap', async () => {
    const { nodes, links } = makeGraph(30);
    const ticks = await settleLayoutHeadless(nodes, links, makeSettings(), {
      yieldToEventLoop: immediate,
      maxTicks: 10,
      ticksPerChunk: 5,
    });
    expect(ticks).toBeLessThanOrEqual(10);
  });

  it('stops early when shouldAbort returns true', async () => {
    const { nodes, links } = makeGraph(30);
    let calls = 0;
    const ticks = await settleLayoutHeadless(nodes, links, makeSettings(), {
      yieldToEventLoop: immediate,
      ticksPerChunk: 5,
      shouldAbort: () => ++calls >= 2, // abort after the 2nd chunk boundary
    });
    expect(ticks).toBeLessThan(300);
  });

  it('works with collide disabled', async () => {
    const { nodes, links } = makeGraph(25);
    const ticks = await settleLayoutHeadless(
      nodes,
      links,
      makeSettings({ d3CollideEnabled: false, d3GravityStrength: 0 }),
      { yieldToEventLoop: immediate },
    );
    expect(ticks).toBeGreaterThan(0);
    expect(allFinite(nodes, ['x', 'y'])).toBe(true);
  });
});
