import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { useGraphLayout } from '../useGraphLayout';
import type { GraphNode } from '@/types/graph3d';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string): GraphNode {
  return {
    id,
    label: id,
    nodeType: 'T',
    color: '#fff',
    size: 5,
    x: 10, y: 20, z: 30,
    fx: 10, fy: 20, fz: 30,
    vx: 0, vy: 0, vz: 0,
  } as GraphNode;
}

function makeGraph3d(nodes: GraphNode[]) {
  const data = { nodes, links: [] as unknown[] };
  return {
    graphData: vi.fn((next?: typeof data) => (next ? undefined : data)),
    cooldownTicks: vi.fn(),
    ticksPerFrame: vi.fn(),
    d3ReheatSimulation: vi.fn(),
    onEngineStop: vi.fn(),
  };
}

function setup(options: { staticLayout?: boolean; is2D?: boolean } = {}) {
  const nodes = [makeNode('a'), makeNode('b')];
  const graph3d = makeGraph3d(nodes);
  const layout = useGraphLayout(
    () => graph3d,
    {
      isLayoutRunning: ref(false),
      layoutStabilized: ref(false),
      initialLayoutDone: ref(false),
    },
    { setLabelsVisible: vi.fn(), updateLabels: vi.fn() },
    undefined,
    () => options.is2D ?? false,
    () => options.staticLayout ?? false,
  );
  return { nodes, graph3d, layout };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useGraphLayout — static layout mode', () => {
  it('startLayout unpins all nodes in normal (force) mode', () => {
    const { nodes, layout } = setup();

    layout.startLayout();

    expect(nodes[0].fx).toBeNull();
    expect(nodes[0].fy).toBeNull();
    expect(nodes[0].fz).toBeNull();
  });

  it('startLayout preserves pinned positions when the layout is static (hive)', () => {
    const { nodes, graph3d, layout } = setup({ staticLayout: true });

    layout.startLayout();

    expect(nodes[0].fx).toBe(10);
    expect(nodes[0].fy).toBe(20);
    expect(nodes[0].fz).toBe(30);
    // Simulation still reheats (harmless with everything pinned)
    expect(graph3d.d3ReheatSimulation).toHaveBeenCalled();
  });

  it('reheatLayout does not perturb positions when the layout is static', () => {
    const { nodes, layout } = setup({ staticLayout: true });

    layout.reheatLayout();

    expect(nodes[0].x).toBe(10);
    expect(nodes[0].y).toBe(20);
    expect(nodes[0].fx).toBe(10);
  });

  it('scrambleLayout is a no-op when the layout is static', () => {
    const { nodes, graph3d, layout } = setup({ staticLayout: true });

    layout.scrambleLayout();

    expect(nodes[0].x).toBe(10);
    expect(nodes[0].fx).toBe(10);
    expect(graph3d.d3ReheatSimulation).not.toHaveBeenCalled();
  });

  it('startLayout pins z to 0 in 2D mode', () => {
    const { nodes, layout } = setup({ is2D: true });

    layout.startLayout();

    expect(nodes[0].fx).toBeNull();
    expect(nodes[0].z).toBe(0);
    expect(nodes[0].fz).toBe(0);
  });
});
