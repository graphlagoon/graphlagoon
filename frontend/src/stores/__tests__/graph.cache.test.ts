import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { useGraphStore } from '@/stores/graph';
import { useCommunityStore } from '@/stores/community';

vi.mock('@/services/api', () => ({
  api: {
    getGraphContext: vi.fn(),
    getSubgraph: vi.fn(),
    getNodesBatch: vi.fn(),
    getGraphCache: vi.fn(),
    putGraphCache: vi.fn(),
    listGraphCaches: vi.fn(),
    deleteGraphCache: vi.fn(),
    submitGraphQueryJob: vi.fn(),
    getGraphQueryJob: vi.fn(),
  },
}));

import { api } from '@/services/api';

const CONTEXT_ID = 'ctx-1';

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTEXT_ID,
    title: 'ctx',
    edge_table_name: 'e',
    node_table_name: 'n',
    ...overrides,
  } as any;
}

function makeNode(id: string, props: Record<string, unknown> | null = { a: 1 }) {
  return { node_id: id, node_type: 'Account', properties: props } as any;
}

function makeEdge(id: string, src: string, dst: string) {
  return {
    edge_id: id,
    src,
    dst,
    relationship_type: 'SENT',
    properties: {},
  } as any;
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    cache_version: 1,
    name: 'fraude-2024',
    context_id: CONTEXT_ID,
    created_at: '2026-08-20T12:00:00Z',
    created_by: 'owner@example.com',
    node_count: 2,
    edge_count: 1,
    properties_complete: true,
    source: { kind: 'cypher', query: 'MATCH (n) RETURN n' },
    graph: {
      nodes: [makeNode('n1'), makeNode('n2')],
      edges: [makeEdge('e1', 'n1', 'n2')],
      truncated: false,
      properties_deferred: false,
    },
    ...overrides,
  } as any;
}

describe('graph store — loadGraphCache', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('replays the cached nodes and edges', async () => {
    const store = useGraphStore();
    vi.mocked(api.getGraphCache).mockResolvedValue(makePayload());

    await store.loadGraphCache(CONTEXT_ID, 'fraude-2024');

    expect(store.nodes.map((n) => n.node_id)).toEqual(['n1', 'n2']);
    expect(store.edges.map((e) => e.edge_id)).toEqual(['e1']);
    expect(store.truncated).toBe(false);
    expect(api.getGraphCache).toHaveBeenCalledWith(CONTEXT_ID, 'fraude-2024');
  });

  it('records the active cache for the status chip', async () => {
    const store = useGraphStore();
    vi.mocked(api.getGraphCache).mockResolvedValue(makePayload());

    await store.loadGraphCache(CONTEXT_ID, 'fraude-2024');

    expect(store.currentGraphCache?.name).toBe('fraude-2024');
    expect(store.currentGraphCache?.created_by).toBe('owner@example.com');
  });

  it('surfaces the originating query so the query panel is not blank', async () => {
    const store = useGraphStore();
    vi.mocked(api.getGraphCache).mockResolvedValue(makePayload());

    await store.loadGraphCache(CONTEXT_ID, 'fraude-2024');

    expect(store.graphQuery).toBe('MATCH (n) RETURN n');
  });

  it('carries truncated through', async () => {
    const store = useGraphStore();
    vi.mocked(api.getGraphCache).mockResolvedValue(
      makePayload({
        graph: {
          nodes: [makeNode('n1')],
          edges: [],
          truncated: true,
          properties_deferred: false,
        },
      }),
    );

    await store.loadGraphCache(CONTEXT_ID, 'c1');
    expect(store.truncated).toBe(true);
  });

  it('requests a fresh layout', async () => {
    const store = useGraphStore();
    vi.mocked(api.getGraphCache).mockResolvedValue(makePayload());

    await store.loadGraphCache(CONTEXT_ID, 'c1');

    expect(store.freshLayoutRequested).toBe(true);
  });

  it('clears selections', async () => {
    const store = useGraphStore();
    store.selectedNodeIds.add('old');
    store.selectedEdgeIds.add('old-e');
    vi.mocked(api.getGraphCache).mockResolvedValue(makePayload());

    await store.loadGraphCache(CONTEXT_ID, 'c1');

    expect(store.selectedNodeIds.size).toBe(0);
    expect(store.selectedEdgeIds.size).toBe(0);
  });

  it('never fetches node properties — the cache is already complete', async () => {
    const store = useGraphStore();
    vi.mocked(api.getGraphCache).mockResolvedValue(makePayload());

    await store.loadGraphCache(CONTEXT_ID, 'c1');
    await nextTick();

    expect(api.getNodesBatch).not.toHaveBeenCalled();
    expect(store.pendingPropertyNodeIds.size).toBe(0);
  });

  it('abandons enrichment left over from the previous graph', async () => {
    // A stale enrichment patches by node id, so without the token bump it would
    // write the previous graph's properties onto same-named cached nodes.
    const store = useGraphStore();
    store.currentContext = makeContext();
    store.pendingPropertyNodeIds.add('n1');

    vi.mocked(api.getGraphCache).mockResolvedValue(makePayload());
    await store.loadGraphCache(CONTEXT_ID, 'c1');

    expect(store.pendingPropertyNodeIds.size).toBe(0);
    expect(api.getNodesBatch).not.toHaveBeenCalled();
  });

  it('replaces the edges even when the node ids match the previous graph', async () => {
    // Guards the applyGraphResponse patch branch, which updates properties
    // without reassigning edges. Same node ids, different edges.
    const store = useGraphStore();
    store.nodes = [makeNode('n1'), makeNode('n2')];
    store.edges = [makeEdge('stale', 'n1', 'n2')];

    vi.mocked(api.getGraphCache).mockResolvedValue(makePayload());
    await store.loadGraphCache(CONTEXT_ID, 'fraude-2024');

    expect(store.edges.map((e) => e.edge_id)).toEqual(['e1']);
  });

  it('does not run the query as a fallback when the cache is missing', async () => {
    const store = useGraphStore();
    store.currentContext = makeContext();
    vi.mocked(api.getGraphCache).mockRejectedValue(new Error('404'));

    await expect(store.loadGraphCache(CONTEXT_ID, 'gone')).rejects.toThrow();

    expect(api.submitGraphQueryJob).not.toHaveBeenCalled();
    expect(api.getSubgraph).not.toHaveBeenCalled();
  });

  it('reports the failure and leaves no stale active cache', async () => {
    const store = useGraphStore();
    vi.mocked(api.getGraphCache).mockResolvedValue(makePayload());
    await store.loadGraphCache(CONTEXT_ID, 'good');

    vi.mocked(api.getGraphCache).mockRejectedValue(new Error('boom'));
    await expect(store.loadGraphCache(CONTEXT_ID, 'gone')).rejects.toThrow();

    expect(store.queryError).toBeTruthy();
    expect(store.currentGraphCache).toBeNull();
  });

  it('drops the loading flag on both success and failure', async () => {
    const store = useGraphStore();

    vi.mocked(api.getGraphCache).mockResolvedValue(makePayload());
    await store.loadGraphCache(CONTEXT_ID, 'c1');
    expect(store.loading).toBe(false);

    vi.mocked(api.getGraphCache).mockRejectedValue(new Error('boom'));
    await expect(store.loadGraphCache(CONTEXT_ID, 'c2')).rejects.toThrow();
    expect(store.loading).toBe(false);
  });

  it('does not disturb community state it never restores', async () => {
    const store = useGraphStore();
    const community = useCommunityStore();
    vi.mocked(api.getGraphCache).mockResolvedValue(makePayload());

    await store.loadGraphCache(CONTEXT_ID, 'c1');
    await nextTick();

    expect(community.communityMap.size).toBe(0);
  });
});

describe('graph store — saveGraphCache', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(api.putGraphCache).mockResolvedValue({
      name: 'c1',
      size_bytes: 10,
      modified_at: '2026-08-20T12:00:00Z',
    } as any);
  });

  it('sends the graph currently on screen', async () => {
    const store = useGraphStore();
    store.currentContext = makeContext();
    store.nodes = [makeNode('n1'), makeNode('n2')];
    store.edges = [makeEdge('e1', 'n1', 'n2')];
    store.graphQuery = 'MATCH (n) RETURN n';

    await store.saveGraphCache('c1', 'cypher');

    const [contextId, name, body] = vi.mocked(api.putGraphCache).mock.calls[0];
    expect(contextId).toBe(CONTEXT_ID);
    expect(name).toBe('c1');
    expect(body.graph.nodes).toHaveLength(2);
    expect(body.graph.edges).toHaveLength(1);
    expect(body.source.kind).toBe('cypher');
    expect(body.source.query).toBe('MATCH (n) RETURN n');
  });

  it('always marks the stored graph as property-complete', async () => {
    const store = useGraphStore();
    store.currentContext = makeContext();
    store.nodes = [makeNode('n1')];

    await store.saveGraphCache('c1');

    expect(vi.mocked(api.putGraphCache).mock.calls[0][2].graph.properties_deferred).toBe(
      false,
    );
  });

  it('refuses while node properties are still loading', async () => {
    // Caching mid-enrichment would persist nulls and replay an empty-looking graph.
    const store = useGraphStore();
    store.currentContext = makeContext();
    store.nodes = [makeNode('n1', null)];
    store.pendingPropertyNodeIds.add('n1');

    await expect(store.saveGraphCache('c1')).rejects.toThrow(/still loading/i);
    expect(api.putGraphCache).not.toHaveBeenCalled();
  });

  it('refuses an empty graph', async () => {
    const store = useGraphStore();
    store.currentContext = makeContext();

    await expect(store.saveGraphCache('c1')).rejects.toThrow(/empty/i);
    expect(api.putGraphCache).not.toHaveBeenCalled();
  });

  it('refuses without a context', async () => {
    const store = useGraphStore();
    await expect(store.saveGraphCache('c1')).rejects.toThrow(/context/i);
    expect(api.putGraphCache).not.toHaveBeenCalled();
  });
});

describe('graph store — clear()', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('forgets the active cache', async () => {
    const store = useGraphStore();
    vi.mocked(api.getGraphCache).mockResolvedValue(makePayload());
    await store.loadGraphCache(CONTEXT_ID, 'c1');
    expect(store.currentGraphCache).not.toBeNull();

    store.clear();

    expect(store.currentGraphCache).toBeNull();
  });
});
