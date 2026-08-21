/**
 * Style presets in the graph store.
 *
 * The load-bearing property is that presets and explorations share one
 * serialization: `buildStylePreset()` produces the block, `applyStylePreset()`
 * consumes it, and `getExplorationState()`/`loadExploration()` go through both.
 * A second copy would drift the first time a field is added.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useGraphStore } from '@/stores/graph';

vi.mock('@/services/api', () => ({
  api: {
    getGraphContext: vi.fn(),
    getSubgraph: vi.fn(),
    getNodesBatch: vi.fn(),
    getStylePreset: vi.fn(),
    putStylePreset: vi.fn(),
    listStylePresets: vi.fn(),
    deleteStylePreset: vi.fn(),
  },
}));

import { api } from '@/services/api';

const CONTEXT_ID = 'ctx-1';

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    aesthetics: { nodeSize: 9 },
    nodeTypeColors: { Account: '#ff0000' },
    edgeTypeColors: { SENT: '#0000ff' },
    nodeTypeIcons: { Account: 'user' },
    edgeTypeIcons: { SENT: 'arrow' },
    nodePropertyIconConfigs: {},
    textFormat: { rules: [], defaults: { nodeTemplate: '{name}' } },
    layout_algorithm: 'hive',
    layout_mode_config: { ego: {}, hive: {}, hierarchical: {} },
    force3d_settings: {},
    ...overrides,
  } as any;
}

function makePreset(overrides: Record<string, unknown> = {}) {
  return {
    preset_version: 1,
    name: 'investigacao',
    context_id: CONTEXT_ID,
    created_at: '2026-08-20T12:00:00Z',
    created_by: 'owner@example.com',
    updated_at: null,
    description: 'Fraud review look',
    settings: makeSettings(),
    ...overrides,
  } as any;
}

describe('buildStylePreset', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('captures style, labels and layout', () => {
    const store = useGraphStore();
    store.setNodeTypeColor('Account', '#123456');
    store.layoutAlgorithm = 'hive';

    const preset = store.buildStylePreset();

    expect(preset.nodeTypeColors).toEqual({ Account: '#123456' });
    expect(preset.layout_algorithm).toBe('hive');
    expect(preset.aesthetics).toBeDefined();
    expect(preset.textFormat).toBeDefined();
    expect(preset.force3d_settings).toBeDefined();
    expect(preset.layout_mode_config).toBeDefined();
  });

  it('carries nothing about which data is shown', () => {
    // A preset that could hide nodes would make a styled graph look like it came
    // back incomplete from the server.
    const preset = useGraphStore().buildStylePreset() as unknown as Record<string, unknown>;

    for (const forbidden of [
      'nodes',
      'edges',
      'filters',
      'viewport',
      'graph_query',
      'clusters',
      'community',
      'similarity',
      'behaviors',
    ]) {
      expect(preset).not.toHaveProperty(forbidden);
    }
  });

  it('feeds the exploration state, rather than being rebuilt for it', () => {
    const store = useGraphStore();
    store.setNodeTypeColor('Device', '#abcdef');
    store.layoutAlgorithm = 'hierarchical';

    const preset = store.buildStylePreset();
    const exploration = store.getExplorationState() as unknown as Record<string, unknown>;

    for (const [key, value] of Object.entries(preset)) {
      expect(exploration[key]).toEqual(value);
    }
  });
});

describe('applyStylePreset', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('round-trips through build', () => {
    const store = useGraphStore();
    store.setNodeTypeColor('Account', '#ff0000');
    store.layoutAlgorithm = 'ego';
    const saved = store.buildStylePreset();

    store.setNodeTypeColor('Account', '#00ff00');
    store.layoutAlgorithm = 'force';

    store.applyStylePreset(saved);

    expect(store.getNodeTypeColor('Account')).toBe('#ff0000');
    expect(store.layoutAlgorithm).toBe('ego');
  });

  it('replaces rather than merges, so the look is exactly what was saved', () => {
    const store = useGraphStore();
    const saved = store.buildStylePreset(); // no colors set

    store.setNodeTypeColor('Leftover', '#123123');
    store.applyStylePreset(saved);

    expect(store.nodeTypeColors.size).toBe(0);
  });

  it('falls back to force for an unknown layout', () => {
    const store = useGraphStore();
    store.applyStylePreset(makeSettings({ layout_algorithm: 'teleportation' }));
    expect(store.layoutAlgorithm).toBe('force');
  });

  it('requests a fresh layout, since a new one needs the simulation restarted', () => {
    const store = useGraphStore();
    store.freshLayoutRequested = false;
    store.applyStylePreset(makeSettings());
    expect(store.freshLayoutRequested).toBe(true);
  });

  it('leaves the graph itself untouched', () => {
    const store = useGraphStore();
    store.nodes = [{ node_id: 'n1', node_type: 'A', properties: {} }] as any;
    store.edges = [
      { edge_id: 'e1', src: 'n1', dst: 'n1', relationship_type: 'R', properties: {} },
    ] as any;

    store.applyStylePreset(makeSettings());

    expect(store.nodes).toHaveLength(1);
    expect(store.edges).toHaveLength(1);
  });

  it('ignores undefined', () => {
    const store = useGraphStore();
    store.layoutAlgorithm = 'hive';
    store.applyStylePreset(undefined);
    expect(store.layoutAlgorithm).toBe('hive');
  });
});

describe('loadStylePreset', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('applies the fetched preset and records it', async () => {
    const store = useGraphStore();
    vi.mocked(api.getStylePreset).mockResolvedValue(makePreset());

    await store.loadStylePreset(CONTEXT_ID, 'investigacao');

    expect(store.layoutAlgorithm).toBe('hive');
    expect(store.getNodeTypeColor('Account')).toBe('#ff0000');
    expect(store.currentStylePreset?.name).toBe('investigacao');
    expect(store.stylePresetError).toBeNull();
  });

  it('leaves the graph and its look alone when the preset is missing', async () => {
    // Unlike a missing ?graph=, a missing ?style= costs only the styling, so the
    // view must stay exactly as usable as it was.
    const store = useGraphStore();
    store.nodes = [{ node_id: 'n1', node_type: 'A', properties: {} }] as any;
    store.setNodeTypeColor('Account', '#abcabc');
    store.layoutAlgorithm = 'hive';

    vi.mocked(api.getStylePreset).mockRejectedValue(new Error('404'));

    const result = await store.loadStylePreset(CONTEXT_ID, 'gone');

    expect(result).toBeNull();
    expect(store.nodes).toHaveLength(1);
    expect(store.getNodeTypeColor('Account')).toBe('#abcabc');
    expect(store.layoutAlgorithm).toBe('hive');
  });

  it('reports why it could not apply, rather than failing silently', async () => {
    const store = useGraphStore();
    vi.mocked(api.getStylePreset).mockRejectedValue(new Error('boom'));

    await store.loadStylePreset(CONTEXT_ID, 'gone');

    expect(store.stylePresetError).toBeTruthy();
    expect(store.currentStylePreset).toBeNull();
  });

  it('does not raise — a bad ?style= must not break the page', async () => {
    const store = useGraphStore();
    vi.mocked(api.getStylePreset).mockRejectedValue(new Error('boom'));
    await expect(store.loadStylePreset(CONTEXT_ID, 'gone')).resolves.toBeNull();
  });

  it('clears a previous error on a later success', async () => {
    const store = useGraphStore();
    vi.mocked(api.getStylePreset).mockRejectedValue(new Error('boom'));
    await store.loadStylePreset(CONTEXT_ID, 'gone');
    expect(store.stylePresetError).toBeTruthy();

    vi.mocked(api.getStylePreset).mockResolvedValue(makePreset());
    await store.loadStylePreset(CONTEXT_ID, 'investigacao');
    expect(store.stylePresetError).toBeNull();
  });
});

describe('saveStylePreset', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(api.putStylePreset).mockResolvedValue(makePreset());
  });

  it('sends the current look', async () => {
    const store = useGraphStore();
    store.currentContext = { id: CONTEXT_ID, title: 'ctx' } as any;
    store.setNodeTypeColor('Account', '#ff0000');
    store.layoutAlgorithm = 'hive';

    await store.saveStylePreset('investigacao', 'Fraud review look');

    const [contextId, name, body] = vi.mocked(api.putStylePreset).mock.calls[0];
    expect(contextId).toBe(CONTEXT_ID);
    expect(name).toBe('investigacao');
    expect(body.settings.nodeTypeColors).toEqual({ Account: '#ff0000' });
    expect(body.settings.layout_algorithm).toBe('hive');
    expect(body.description).toBe('Fraud review look');
  });

  it('marks the saved preset as the active one', async () => {
    const store = useGraphStore();
    store.currentContext = { id: CONTEXT_ID, title: 'ctx' } as any;

    await store.saveStylePreset('investigacao');

    expect(store.currentStylePreset?.name).toBe('investigacao');
  });

  it('refuses without a context', async () => {
    await expect(useGraphStore().saveStylePreset('p1')).rejects.toThrow(/context/i);
    expect(api.putStylePreset).not.toHaveBeenCalled();
  });
});

describe('a style outlives the graph it was applied to', () => {
  // The requirement: a preset applies to the graph on screen *or the one loaded
  // next*. Style is store state that no graph load resets, so this holds by
  // construction — but only as long as nothing clears it on the way.
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('survives loading a different graph', async () => {
    const store = useGraphStore();
    vi.mocked(api.getStylePreset).mockResolvedValue(makePreset());
    await store.loadStylePreset(CONTEXT_ID, 'investigacao');

    // A completely different graph arrives.
    store.nodes = [{ node_id: 'x', node_type: 'B', properties: {} }] as any;
    store.edges = [];

    expect(store.currentStylePreset?.name).toBe('investigacao');
    expect(store.getNodeTypeColor('Account')).toBe('#ff0000');
    expect(store.layoutAlgorithm).toBe('hive');
  });

  it('survives a cached graph being swapped in', async () => {
    const store = useGraphStore();
    vi.mocked(api.getStylePreset).mockResolvedValue(makePreset());
    await store.loadStylePreset(CONTEXT_ID, 'investigacao');

    vi.mocked((api as any).getGraphCache = vi.fn()).mockResolvedValue({
      cache_version: 1,
      name: 'c1',
      context_id: CONTEXT_ID,
      created_at: '2026-08-20T12:00:00Z',
      created_by: 'owner@example.com',
      node_count: 1,
      edge_count: 0,
      properties_complete: true,
      source: { kind: 'manual' },
      graph: {
        nodes: [{ node_id: 'x', node_type: 'B', properties: {} }],
        edges: [],
        truncated: false,
        properties_deferred: false,
      },
    } as any);

    await store.loadGraphCache(CONTEXT_ID, 'c1');

    expect(store.currentStylePreset?.name).toBe('investigacao');
    expect(store.getNodeTypeColor('Account')).toBe('#ff0000');
  });
});

describe('clear()', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('forgets the applied preset and any error', async () => {
    const store = useGraphStore();
    vi.mocked(api.getStylePreset).mockResolvedValue(makePreset());
    await store.loadStylePreset(CONTEXT_ID, 'investigacao');

    store.clear();

    expect(store.currentStylePreset).toBeNull();
    expect(store.stylePresetError).toBeNull();
  });
});
