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
import { defaultLayoutModeConfig, useGraphStore } from '@/stores/graph';
import { useCommunityStore } from '@/stores/community';
import { useMetricsStore } from '@/stores/metrics';
import { DEFAULT_VISUAL_MAPPING } from '@/types/metrics';
import {
  parseLayoutOverrides,
  settableFieldNames,
} from '@/utils/layoutUrlOverrides';

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

  it('carries nothing about which data is loaded', () => {
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
    ]) {
      expect(preset).not.toHaveProperty(forbidden);
    }
  });

  it('captures behaviors and the property allowlist', () => {
    const store = useGraphStore();
    store.updateBehaviors({ focusDepth: 3 });
    store.setPropertyVisibility('node', ['name', 'age']);

    const preset = store.buildStylePreset();

    expect(preset.behaviors).toMatchObject({ focusDepth: 3 });
    expect(preset.property_visibility).toEqual({
      nodeProperties: ['name', 'age'],
      edgeProperties: null,
    });
  });

  it('captures the hide-empty-values details toggle', () => {
    const store = useGraphStore();
    expect(store.buildStylePreset().aesthetics).toMatchObject({ hideEmptyValues: true });

    store.updateAesthetics({ hideEmptyValues: false });

    expect(store.buildStylePreset().aesthetics).toMatchObject({ hideEmptyValues: false });
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

  it('round-trips the tooltip templates', () => {
    const store = useGraphStore();
    store.updateTextFormatDefaults({
      nodeTooltipTemplate: '{prop:name}{br}{prop:email}',
      edgeTooltipTemplate: '{src} -> {dst}',
    });
    const saved = store.buildStylePreset();

    store.updateTextFormatDefaults({ nodeTooltipTemplate: '', edgeTooltipTemplate: '' });
    store.applyStylePreset(saved);

    expect(store.textFormatDefaults.nodeTooltipTemplate).toBe('{prop:name}{br}{prop:email}');
    expect(store.textFormatDefaults.edgeTooltipTemplate).toBe('{src} -> {dst}');
  });

  it('a preset saved before tooltip templates resets them to the stock look', () => {
    // Same replace-not-merge contract the labels already have: applying a
    // preset gives you exactly the look it was saved with.
    const store = useGraphStore();
    store.updateTextFormatDefaults({ nodeTooltipTemplate: '{prop:name}' });

    store.applyStylePreset(makeSettings());

    expect(store.textFormatDefaults.nodeTooltipTemplate).toBe('');
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

  it('round-trips the hide-empty-values toggle, including a saved false', () => {
    const store = useGraphStore();
    store.updateAesthetics({ hideEmptyValues: false });
    const saved = store.buildStylePreset();

    store.updateAesthetics({ hideEmptyValues: true });
    store.applyStylePreset(saved);

    expect(store.aesthetics.hideEmptyValues).toBe(false);
  });

  it('round-trips behaviors and the property allowlist', () => {
    const store = useGraphStore();
    store.updateBehaviors({ focusDepth: 4, edgeLensMode: 'hide' });
    store.setPropertyVisibility('edge', ['amount']);
    const saved = store.buildStylePreset();

    store.updateBehaviors({ focusDepth: 1, edgeLensMode: 'dim' });
    store.setPropertyVisibility('edge', null);

    store.applyStylePreset(saved);

    expect(store.behaviors.focusDepth).toBe(4);
    expect(store.behaviors.edgeLensMode).toBe('hide');
    expect(store.propertyVisibility.edgeProperties).toEqual(['amount']);
  });

  it('a pre-feature preset leaves behaviors alone but resets the allowlist', () => {
    // Absent behaviors = the preset predates them; "reset" would need a baseline
    // from the precedence chain and would stomp panel edits. Absent
    // property_visibility = its author saw every property, so show-all IS the
    // faithful restore. Both directions pinned on purpose.
    const store = useGraphStore();
    store.updateBehaviors({ focusDepth: 5 });
    store.setPropertyVisibility('node', ['name']);

    store.applyStylePreset(makeSettings()); // no behaviors, no property_visibility

    expect(store.behaviors.focusDepth).toBe(5);
    expect(store.propertyVisibility).toEqual({ nodeProperties: null, edgeProperties: null });
  });

  it('validates preset behaviors instead of trusting them', () => {
    const store = useGraphStore();
    const before = store.behaviors.focusDepth;

    store.applyStylePreset(
      makeSettings({
        behaviors: {
          notAThing: true,           // unknown key
          focusDepth: 'deep',        // wrong type
          viewMode: 'banana',        // enum violation
          edgeLensMode: 'hide',      // valid
        },
      }),
    );

    expect(store.behaviors).not.toHaveProperty('notAThing');
    expect(store.behaviors.focusDepth).toBe(before);
    expect(store.behaviors.viewMode).not.toBe('banana');
    expect(store.behaviors.edgeLensMode).toBe('hide');
  });

  it('normalizes a corrupt property_visibility to show-all, key by key', () => {
    const store = useGraphStore();

    store.applyStylePreset(
      makeSettings({
        property_visibility: {
          nodeProperties: ['name', 42, null, 'age'], // non-strings dropped
          edgeProperties: 'everything',              // not an array → null
        },
      }),
    );

    expect(store.propertyVisibility.nodeProperties).toEqual(['name', 'age']);
    expect(store.propertyVisibility.edgeProperties).toBeNull();
  });

  it('preserves an empty allowlist — [] hides all, null shows all', () => {
    const store = useGraphStore();
    store.applyStylePreset(
      makeSettings({ property_visibility: { nodeProperties: [], edgeProperties: null } }),
    );
    expect(store.propertyVisibility.nodeProperties).toEqual([]);
    expect(store.propertyVisibility.edgeProperties).toBeNull();
  });

  it('round-trips the metric visual mapping', () => {
    const store = useGraphStore();
    const metricsStore = useMetricsStore();
    metricsStore.updateNodeSizeMapping({ metricId: 'pagerank', maxSize: 30, scale: 'log' });
    const saved = store.buildStylePreset();
    expect(saved.visual_mapping).toMatchObject({ nodeSize: { metricId: 'pagerank' } });

    metricsStore.resetVisualMapping();
    store.applyStylePreset(saved);

    expect(metricsStore.visualMapping.nodeSize.metricId).toBe('pagerank');
    expect(metricsStore.visualMapping.nodeSize.maxSize).toBe(30);
    expect(metricsStore.visualMapping.nodeSize.scale).toBe('log');
  });

  it('a pre-feature preset resets the visual mapping to defaults', () => {
    const store = useGraphStore();
    const metricsStore = useMetricsStore();
    metricsStore.updateNodeSizeMapping({ metricId: 'pagerank', maxSize: 30 });

    store.applyStylePreset(makeSettings()); // no visual_mapping

    expect(metricsStore.visualMapping.nodeSize).toEqual(DEFAULT_VISUAL_MAPPING.nodeSize);
  });

  it('validates a saved visual mapping key by key instead of trusting it', () => {
    const store = useGraphStore();
    const metricsStore = useMetricsStore();

    store.applyStylePreset(
      makeSettings({
        visual_mapping: {
          nodeSize: { metricId: 'pagerank', minSize: 'big', scale: 'banana' },
          edgeWeight: 'not-an-object',
          enableRealTimeUpdates: 'yes',
        },
      }),
    );

    const vm = metricsStore.visualMapping;
    expect(vm.nodeSize.metricId).toBe('pagerank');                      // valid: kept
    expect(vm.nodeSize.minSize).toBe(DEFAULT_VISUAL_MAPPING.nodeSize.minSize); // wrong type
    expect(vm.nodeSize.scale).toBe('linear');                           // enum violation
    expect(vm.edgeWeight).toEqual(DEFAULT_VISUAL_MAPPING.edgeWeight);   // not an object
    expect(vm.enableRealTimeUpdates).toBe(DEFAULT_VISUAL_MAPPING.enableRealTimeUpdates);
  });
});

describe('property visibility helpers', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('passes every key through when no allowlist is set', () => {
    const store = useGraphStore();
    expect(store.visiblePropKeys('node', ['a', 'b'])).toEqual(['a', 'b']);
    expect(store.isPropertyVisible('edge', 'anything')).toBe(true);
  });

  it('filters to the allowlist, preserving the incoming order', () => {
    const store = useGraphStore();
    store.setPropertyVisibility('node', ['c', 'a']);
    expect(store.visiblePropKeys('node', ['a', 'b', 'c'])).toEqual(['a', 'c']);
    expect(store.isPropertyVisible('node', 'b')).toBe(false);
    // Edge list untouched by the node list
    expect(store.visiblePropKeys('edge', ['b'])).toEqual(['b']);
  });

  it('an empty allowlist hides every property', () => {
    const store = useGraphStore();
    store.setPropertyVisibility('edge', []);
    expect(store.visiblePropKeys('edge', ['a', 'b'])).toEqual([]);
    expect(store.isPropertyVisible('edge', 'a')).toBe(false);
  });

  it('tolerates allowlisted keys the graph does not have', () => {
    const store = useGraphStore();
    store.setPropertyVisibility('node', ['ghost', 'name']);
    expect(store.visiblePropKeys('node', ['name'])).toEqual(['name']);
  });

  it('resets on clear()', () => {
    const store = useGraphStore();
    store.setPropertyVisibility('node', ['name']);
    store.clear();
    expect(store.propertyVisibility).toEqual({ nodeProperties: null, edgeProperties: null });
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
    // Unlike a missing ?precomputed=, a missing ?style= costs only the styling, so the
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

  it('survives a precomputed graph being swapped in', async () => {
    const store = useGraphStore();
    vi.mocked(api.getStylePreset).mockResolvedValue(makePreset());
    await store.loadStylePreset(CONTEXT_ID, 'investigacao');

    vi.mocked((api as any).getPrecomputedGraph = vi.fn()).mockResolvedValue({
      payload_version: 1,
      provider: 'volume',
      params: {},
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

    await store.loadPrecomputedGraph(CONTEXT_ID, 'c1');

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

/**
 * URL layout overrides compose with a preset. The parser is tested on its own in
 * utils/__tests__/layoutUrlOverrides.test.ts; what matters here is the seam —
 * that its output is shaped to survive `updateLayoutModeConfig`, and that the
 * ordering the view relies on is the only one that works.
 */
describe('layout overrides compose with a preset', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('a URL override survives the preset it is applied after', () => {
    const store = useGraphStore();
    store.applyStylePreset(
      makeSettings({
        layout_algorithm: 'ego',
        layout_mode_config: {
          ego: { focusNodeId: 'from-preset', maxHops: 1, direction: 'out' },
        },
      }) as never,
    );

    const { modeConfig } = parseLayoutOverrides({
      'layout.ego.focusNodeId': 'from-url',
    });
    store.updateLayoutModeConfig(modeConfig);

    expect(store.layoutModeConfig.ego.focusNodeId).toBe('from-url');
    // Everything the URL did not name keeps the preset's value — that is what
    // makes "that look, this suspect" possible without a preset per suspect.
    expect(store.layoutModeConfig.ego.maxHops).toBe(1);
    expect(store.layoutModeConfig.ego.direction).toBe('out');
  });

  it('the preset would erase overrides applied before it', () => {
    const store = useGraphStore();
    store.updateLayoutModeConfig(
      parseLayoutOverrides({ 'layout.ego.focusNodeId': 'from-url' }).modeConfig,
    );
    store.applyStylePreset(
      makeSettings({
        layout_algorithm: 'ego',
        layout_mode_config: { ego: { focusNodeId: 'from-preset' } },
      }) as never,
    );

    // Documents why the view applies overrides AFTER applyStyleFromRoute: this
    // ordering is load-bearing, not cosmetic.
    expect(store.layoutModeConfig.ego.focusNodeId).toBe('from-preset');
  });

  it('leaves untouched modes alone', () => {
    const store = useGraphStore();
    const before = store.layoutModeConfig.hive.axisKey;
    store.updateLayoutModeConfig(
      parseLayoutOverrides({ 'layout.ego.maxHops': '3' }).modeConfig,
    );
    expect(store.layoutModeConfig.hive.axisKey).toBe(before);
  });

  it('setLayoutAlgorithm from a URL disables community radial', () => {
    const store = useGraphStore();
    const community = useCommunityStore();
    community.radialLayoutEnabled = true;

    const { algorithm } = parseLayoutOverrides({ layout: 'ego' });
    store.setLayoutAlgorithm(algorithm!);

    // Two global positional constraints must not stack. Pinned here so a
    // refactor of the override path notices if the invariant moves.
    expect(community.radialLayoutEnabled).toBe(false);
  });

  it('every allowlisted field exists on the real layout config', () => {
    const defaults = defaultLayoutModeConfig();
    for (const mode of ['ego', 'hive', 'hierarchical'] as const) {
      for (const field of settableFieldNames(mode)) {
        expect(defaults[mode], `${mode}.${field}`).toHaveProperty(field);
      }
    }
  });
});
