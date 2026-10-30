/**
 * The look as store state: a reset that leaves nothing of the previous page
 * behind, a re-apply that keeps positions when only colors change, and the
 * default focus / saved camera an exploration opens with.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useGraphStore } from '@/stores/graph';
import { api } from '@/services/api';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});

function dressUp(store: ReturnType<typeof useGraphStore>) {
  store.applyStylePreset({
    aesthetics: { nodeSize: 20 },
    nodeTypeColors: { Person: '#ff0000' },
    edgeTypeIcons: { KNOWS: 'link' },
    textFormat: { rules: [], defaults: { nodeTemplate: '{name}', edgeTemplate: '{relationship_type}' } },
    layout_algorithm: 'hive',
  } as never);
}

describe('resetLook', () => {
  it('puts the stock look back: aesthetics, type maps, labels and layout', () => {
    const store = useGraphStore();
    dressUp(store);
    expect(store.aesthetics.nodeSize).toBe(20);

    store.resetLook();

    expect(store.aesthetics.nodeSize).toBe(store.defaultAesthetics().nodeSize);
    expect(store.nodeTypeColors.size).toBe(0);
    expect(store.edgeTypeIcons.size).toBe(0);
    expect(store.textFormatDefaults.nodeTemplate).toContain('{node_id');
    expect(store.layoutAlgorithm).toBe('force');
  });

  it('leaves behaviors alone (they come from the precedence chain, not the look)', () => {
    const store = useGraphStore();
    store.updateBehaviors({ focusDepth: 3 });
    store.resetLook();
    expect(store.behaviors.focusDepth).toBe(3);
  });
});

describe('clear()', () => {
  it('drops the look too, so the next page never inherits colors or labels', () => {
    const store = useGraphStore();
    dressUp(store);
    store.focusNodeId = 'a';
    store.pendingFocusNodeId = 'a';

    store.clear();

    expect(store.nodeTypeColors.size).toBe(0);
    expect(store.aesthetics.nodeSize).toBe(store.defaultAesthetics().nodeSize);
    expect(store.textFormatRules).toEqual([]);
    expect(store.focusNodeId).toBeNull();
    expect(store.pendingFocusNodeId).toBeNull();
  });
});

describe('applyStylePreset({ freshLayout })', () => {
  it('asks for a fresh layout by default and not when told the layout did not change', () => {
    const store = useGraphStore();
    store.freshLayoutRequested = false;
    store.applyStylePreset({ nodeTypeColors: { Person: '#00ff00' } });
    expect(store.freshLayoutRequested).toBe(true);

    store.freshLayoutRequested = false;
    store.applyStylePreset({ nodeTypeColors: { Person: '#0000ff' } }, { freshLayout: false });
    expect(store.freshLayoutRequested).toBe(false);
    expect(store.nodeTypeColors.get('Person')).toBe('#0000ff');
  });
});

describe('default focus and camera', () => {
  it('the focus is the exploration\'s, never the preset\'s', () => {
    const store = useGraphStore();
    store.focusNodeId = 'a';
    expect(store.buildStylePreset()).not.toHaveProperty('focus_node_id');
    expect(store.getExplorationState().focus_node_id).toBe('a');
  });

  it('changing the focus dirties the exploration; moving the camera does not', () => {
    const store = useGraphStore();
    store.currentExploration = { id: 'x1', title: 'T', has_write_access: true, state: {} } as never;
    store.markExplorationSaved();
    expect(store.isExplorationDirty).toBe(false);

    store.viewport = { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, zoom: 2, mode: '2d-proj' };
    expect(store.isExplorationDirty).toBe(false);

    store.focusNodeId = 'a';
    expect(store.isExplorationDirty).toBe(true);
  });

  it('loading an exploration arms the focus and the saved camera for the canvas', async () => {
    const store = useGraphStore();
    vi.spyOn(api, 'getExploration').mockResolvedValue({
      id: 'x1', title: 'Pix', has_write_access: true,
      state: {
        has_snapshot: true,
        filters: { node_types: [], edge_types: [] },
        viewport: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, zoom: 2, mode: '2d-proj' },
        focus_node_id: 'a',
      },
    } as never);
    vi.spyOn(api, 'getExplorationSnapshot').mockResolvedValue({
      nodes: [{ id: 'a', type: 'Account', properties: {} }, { id: 'b', type: 'Account', properties: {} }], edges: [],
    } as never);

    await store.loadExploration('x1');

    expect(store.focusNodeId).toBe('a');
    expect(store.pendingFocusNodeId).toBe('a');
    expect(store.pendingViewport?.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(store.isExplorationDirty).toBe(false);
  });

  it('an exploration saved before the camera existed opens with nothing pending', async () => {
    const store = useGraphStore();
    vi.spyOn(api, 'getExploration').mockResolvedValue({
      id: 'x1', title: 'Pix', has_write_access: true,
      state: { has_snapshot: true, filters: { node_types: [], edge_types: [] }, viewport: { zoom: 1, center_x: 0, center_y: 0 } },
    } as never);
    vi.spyOn(api, 'getExplorationSnapshot').mockResolvedValue({ nodes: [{ id: 'a', type: 'Account', properties: {} }], edges: [] } as never);

    await store.loadExploration('x1');

    expect(store.focusNodeId).toBeNull();
    expect(store.pendingFocusNodeId).toBeNull();
    expect(store.pendingViewport).toBeNull();
  });
});
