import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useContextMenuActionsStore } from '@/stores/contextMenuActions';
import { useGraphStore } from '@/stores/graph';
import { api } from '@/services/api';
import type { ContextMenuActionConfig } from '@/types/contextMenuActions';
import type { GraphContext } from '@/types/graph';

vi.mock('@/services/api', () => ({
  api: {
    updateGraphContext: vi.fn(),
  },
}));

const mockedUpdate = vi.mocked(api.updateGraphContext);

function makeConfig(id = 'a1'): ContextMenuActionConfig {
  return {
    id,
    label: 'Search',
    enabled: true,
    kind: 'open-url',
    urlTemplate: 'https://x.com/{prop:q}',
    openIn: 'new-tab',
    match: { target: 'node' },
  };
}

function makeContext(overrides: Partial<GraphContext> = {}): GraphContext {
  return {
    id: 'ctx-1',
    title: 'Ctx',
    tags: [],
    edge_table_name: 'edges',
    node_table_name: 'nodes',
    edge_structure: {
      edge_id_col: 'edge_id',
      src_col: 'src',
      dst_col: 'dst',
      relationship_type_col: 'relationship_type',
    },
    node_structure: { node_id_col: 'node_id', node_type_col: 'node_type' },
    edge_properties: [],
    node_properties: [],
    node_types: [],
    relationship_types: [],
    owner_email: 'me@example.com',
    shared_with: [],
    has_write_access: true,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  mockedUpdate.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('contextMenuActions store', () => {
  it('hydrateFromContext replaces configs and never triggers a PUT', () => {
    const store = useContextMenuActionsStore();
    useGraphStore().currentContext = makeContext();
    store.hydrateFromContext([makeConfig()]);
    vi.runAllTimers();
    expect(store.actionConfigs).toHaveLength(1);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it('addConfig persists debounced with the full list', async () => {
    const store = useContextMenuActionsStore();
    const context = makeContext();
    useGraphStore().currentContext = context;
    mockedUpdate.mockResolvedValue(context);

    store.addConfig(makeConfig('a'));
    store.addConfig(makeConfig('b'));
    expect(mockedUpdate).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    // Debounce collapses the two edits into one PUT
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    expect(mockedUpdate).toHaveBeenCalledWith('ctx-1', {
      context_menu_actions: store.actionConfigs,
    });
  });

  it('does not PUT without write access', async () => {
    const store = useContextMenuActionsStore();
    useGraphStore().currentContext = makeContext({ has_write_access: false });

    store.addConfig(makeConfig());
    await vi.runAllTimersAsync();
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it('updateConfig / removeConfig / setEnabled mutate and persist', async () => {
    const store = useContextMenuActionsStore();
    const context = makeContext();
    useGraphStore().currentContext = context;
    mockedUpdate.mockResolvedValue(context);

    store.hydrateFromContext([makeConfig('a')]);
    store.setEnabled('a', false);
    expect(store.actionConfigs[0].enabled).toBe(false);

    store.updateConfig({ ...makeConfig('a'), label: 'Renamed' });
    expect(store.actionConfigs[0].label).toBe('Renamed');

    store.removeConfig('a');
    expect(store.actionConfigs).toHaveLength(0);

    await vi.runAllTimersAsync();
    expect(mockedUpdate).toHaveBeenCalled();
  });

  it('flushPersist runs a pending save immediately', async () => {
    const store = useContextMenuActionsStore();
    const context = makeContext();
    useGraphStore().currentContext = context;
    mockedUpdate.mockResolvedValue(context);

    store.addConfig(makeConfig());
    await store.flushPersist();
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    // Nothing pending afterwards
    await vi.runAllTimersAsync();
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
  });

  it('keeps the local context record in sync with the PUT response', async () => {
    const store = useContextMenuActionsStore();
    const graphStore = useGraphStore();
    const context = makeContext();
    graphStore.currentContext = context;
    const updated = makeContext({ context_menu_actions: [makeConfig()] });
    mockedUpdate.mockResolvedValue(updated);

    store.addConfig(makeConfig());
    await vi.runAllTimersAsync();
    expect(graphStore.currentContext?.context_menu_actions).toHaveLength(1);
  });

  it('a failed PUT sets error and does not throw', async () => {
    const store = useContextMenuActionsStore();
    useGraphStore().currentContext = makeContext();
    mockedUpdate.mockRejectedValue(new Error('network'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    store.addConfig(makeConfig());
    await vi.runAllTimersAsync();
    expect(store.error).toContain('Failed to save');
    warnSpy.mockRestore();
  });
});
