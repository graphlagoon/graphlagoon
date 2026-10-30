import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useGraphStore } from '@/stores/graph';
import { api } from '@/services/api';
import type { Exploration, GraphContext, GraphSnapshot } from '@/types/graph';

/** Live refresh: what an agent saves into the open exploration lands in place, and a stale save merges first. */

const state = (over: Record<string, unknown> = {}) => ({
  has_snapshot: true,
  filters: { node_types: [], edge_types: [] },
  viewport: { zoom: 1, center_x: 0, center_y: 0 },
  ...over,
});

const SAVED: GraphSnapshot = {
  nodes: [
    { id: 'a', type: 'Conta', properties: { titular: 'Ana' }, x: 5, y: 6 },
    { id: 'b', type: 'Conta', properties: { titular: 'Bia' } },
  ],
  edges: [{ id: 'e1', source: 'a', target: 'b', type: 'PIX', properties: {} }],
};

const BY_AGENT: GraphSnapshot = {
  nodes: [
    { id: 'a', type: 'Conta', properties: { titular: 'Ana', risco: 'alto' }, x: 5, y: 6 },
    { id: 'c', type: 'Conta', properties: { titular: 'Caio' } },
  ],
  edges: [{ id: 'e2', source: 'a', target: 'c', type: 'PIX', properties: {} }],
};

const exploration = (revision: number, over: Record<string, unknown> = {}) =>
  ({ id: 'x1', title: 'Pix', graph_context_id: 'c1', has_write_access: true, state: state({ revision, ...over }) }) as unknown as Exploration;

async function openExploration() {
  const store = useGraphStore();
  store.currentContext = { id: 'c1', title: 'Bank' } as GraphContext;
  vi.spyOn(api, 'getExploration').mockResolvedValueOnce(exploration(0));
  vi.spyOn(api, 'getExplorationSnapshot').mockResolvedValueOnce(structuredClone(SAVED));
  await store.loadExploration('x1');
  return store;
}

describe('graph store — live refresh of the open exploration', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('applies an agent change in place: new and removed nodes, new properties, same objects', async () => {
    const store = await openExploration();
    const a = store.nodes.find((n) => n.node_id === 'a')!;
    expect(store.isExplorationDirty).toBe(false);
    vi.mocked(api.getExploration).mockResolvedValueOnce(
      exploration(1, { last_change: { by: 'me@x.com', author_kind: 'agent', tool: 'edit_exploration', summary: { added_nodes: 1, removed_nodes: 1 } } }),
    );
    vi.mocked(api.getExplorationSnapshot).mockResolvedValueOnce(structuredClone(BY_AGENT));
    store.selectNode('b');

    const change = await store.applyRemoteChange();

    expect(change?.tool).toBe('edit_exploration');
    expect(store.nodes.map((n) => n.node_id)).toEqual(['a', 'c']);
    expect(store.nodes[0]).toBe(a);
    expect(a.properties).toEqual({ titular: 'Ana', risco: 'alto' });
    expect(store.edges.map((e) => e.edge_id)).toEqual(['e2']);
    expect(store.selectedNodeIds.has('b')).toBe(false);
    expect(store.currentExploration?.state.revision).toBe(1);
    expect(store.isExplorationDirty).toBe(false);
  });

  it('a save from an old revision merges what the agent saved and saves both', async () => {
    const store = await openExploration();
    store.nodes = [...store.nodes, { node_id: 'z', node_type: 'Conta', properties: {} }]; // expanded by the person
    const put = vi.spyOn(api, 'updateExploration')
      .mockRejectedValueOnce({ response: { status: 409, data: { detail: { error: { code: 'EXPLORATION_CHANGED' } } } } })
      .mockResolvedValueOnce(exploration(2));
    vi.spyOn(api, 'putExplorationOverlay').mockResolvedValue(exploration(2));
    vi.mocked(api.getExploration).mockResolvedValueOnce(exploration(1));
    vi.mocked(api.getExplorationSnapshot).mockResolvedValueOnce(structuredClone(BY_AGENT));

    const result = await store.saveExploration('Pix');

    expect(result.success).toBe(true);
    expect(result.warning).toContain('merged');
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0][1].expected_revision).toBe(0);
    expect(put.mock.calls[1][1].expected_revision).toBe(1);
    const saved = put.mock.calls[1][1].snapshot!.nodes.map((n) => n.id);
    expect(saved).toEqual(['a', 'z', 'c']); // the agent's node and the person's expansion; b is gone
  });

  it('another error on save is not swallowed', async () => {
    const store = await openExploration();
    vi.spyOn(api, 'updateExploration').mockRejectedValueOnce({ response: { status: 409, data: { detail: 'An exploration named Pix already exists' } } });
    const result = await store.saveExploration('Pix');
    expect(result.success).toBe(false);
  });
});
