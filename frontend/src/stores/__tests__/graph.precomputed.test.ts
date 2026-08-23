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
    getPrecomputedGraph: vi.fn(),
    putPrecomputedGraph: vi.fn(),
    deletePrecomputedGraph: vi.fn(),
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
    payload_version: 1,
    name: 'fraude-2024',
    context_id: CONTEXT_ID,
    provider: 'volume',
    params: {},
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

describe('graph store — loadPrecomputedGraph', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('replays the cached nodes and edges', async () => {
    const store = useGraphStore();
    vi.mocked(api.getPrecomputedGraph).mockResolvedValue(makePayload());

    await store.loadPrecomputedGraph(CONTEXT_ID, 'fraude-2024');

    expect(store.nodes.map((n) => n.node_id)).toEqual(['n1', 'n2']);
    expect(store.edges.map((e) => e.edge_id)).toEqual(['e1']);
    expect(store.truncated).toBe(false);
    expect(api.getPrecomputedGraph).toHaveBeenCalledWith(CONTEXT_ID, 'fraude-2024', {});
  });

  it('records the active cache for the status chip', async () => {
    const store = useGraphStore();
    vi.mocked(api.getPrecomputedGraph).mockResolvedValue(makePayload());

    await store.loadPrecomputedGraph(CONTEXT_ID, 'fraude-2024');

    expect(store.currentPrecomputedGraph?.name).toBe('fraude-2024');
    expect(store.currentPrecomputedGraph?.created_by).toBe('owner@example.com');
  });

  it('surfaces the originating query so the query panel is not blank', async () => {
    const store = useGraphStore();
    vi.mocked(api.getPrecomputedGraph).mockResolvedValue(makePayload());

    await store.loadPrecomputedGraph(CONTEXT_ID, 'fraude-2024');

    expect(store.graphQuery).toBe('MATCH (n) RETURN n');
  });

  it('carries truncated through', async () => {
    const store = useGraphStore();
    vi.mocked(api.getPrecomputedGraph).mockResolvedValue(
      makePayload({
        graph: {
          nodes: [makeNode('n1')],
          edges: [],
          truncated: true,
          properties_deferred: false,
        },
      }),
    );

    await store.loadPrecomputedGraph(CONTEXT_ID, 'c1');
    expect(store.truncated).toBe(true);
  });

  it('requests a fresh layout', async () => {
    const store = useGraphStore();
    vi.mocked(api.getPrecomputedGraph).mockResolvedValue(makePayload());

    await store.loadPrecomputedGraph(CONTEXT_ID, 'c1');

    expect(store.freshLayoutRequested).toBe(true);
  });

  it('clears selections', async () => {
    const store = useGraphStore();
    store.selectedNodeIds.add('old');
    store.selectedEdgeIds.add('old-e');
    vi.mocked(api.getPrecomputedGraph).mockResolvedValue(makePayload());

    await store.loadPrecomputedGraph(CONTEXT_ID, 'c1');

    expect(store.selectedNodeIds.size).toBe(0);
    expect(store.selectedEdgeIds.size).toBe(0);
  });

  it('never fetches node properties — the cache is already complete', async () => {
    const store = useGraphStore();
    vi.mocked(api.getPrecomputedGraph).mockResolvedValue(makePayload());

    await store.loadPrecomputedGraph(CONTEXT_ID, 'c1');
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

    vi.mocked(api.getPrecomputedGraph).mockResolvedValue(makePayload());
    await store.loadPrecomputedGraph(CONTEXT_ID, 'c1');

    expect(store.pendingPropertyNodeIds.size).toBe(0);
    expect(api.getNodesBatch).not.toHaveBeenCalled();
  });

  it('replaces the edges even when the node ids match the previous graph', async () => {
    // Guards the applyGraphResponse patch branch, which updates properties
    // without reassigning edges. Same node ids, different edges.
    const store = useGraphStore();
    store.nodes = [makeNode('n1'), makeNode('n2')];
    store.edges = [makeEdge('stale', 'n1', 'n2')];

    vi.mocked(api.getPrecomputedGraph).mockResolvedValue(makePayload());
    await store.loadPrecomputedGraph(CONTEXT_ID, 'fraude-2024');

    expect(store.edges.map((e) => e.edge_id)).toEqual(['e1']);
  });

  it('does not run the query as a fallback when the cache is missing', async () => {
    const store = useGraphStore();
    store.currentContext = makeContext();
    vi.mocked(api.getPrecomputedGraph).mockRejectedValue(new Error('404'));

    await expect(store.loadPrecomputedGraph(CONTEXT_ID, 'gone')).rejects.toThrow();

    expect(api.submitGraphQueryJob).not.toHaveBeenCalled();
    expect(api.getSubgraph).not.toHaveBeenCalled();
  });

  it('reports the failure and leaves no stale active cache', async () => {
    const store = useGraphStore();
    vi.mocked(api.getPrecomputedGraph).mockResolvedValue(makePayload());
    await store.loadPrecomputedGraph(CONTEXT_ID, 'good');

    vi.mocked(api.getPrecomputedGraph).mockRejectedValue(new Error('boom'));
    await expect(store.loadPrecomputedGraph(CONTEXT_ID, 'gone')).rejects.toThrow();

    expect(store.queryError).toBeTruthy();
    expect(store.currentPrecomputedGraph).toBeNull();
  });

  it('drops the loading flag on both success and failure', async () => {
    const store = useGraphStore();

    vi.mocked(api.getPrecomputedGraph).mockResolvedValue(makePayload());
    await store.loadPrecomputedGraph(CONTEXT_ID, 'c1');
    expect(store.loading).toBe(false);

    vi.mocked(api.getPrecomputedGraph).mockRejectedValue(new Error('boom'));
    await expect(store.loadPrecomputedGraph(CONTEXT_ID, 'c2')).rejects.toThrow();
    expect(store.loading).toBe(false);
  });

  it('does not disturb community state it never restores', async () => {
    const store = useGraphStore();
    const community = useCommunityStore();
    vi.mocked(api.getPrecomputedGraph).mockResolvedValue(makePayload());

    await store.loadPrecomputedGraph(CONTEXT_ID, 'c1');
    await nextTick();

    expect(community.communityMap.size).toBe(0);
  });
});

describe('graph store — provider arguments', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('forwards the URL arguments to the API', async () => {
    const store = useGraphStore();
    store.currentContext = makeContext();
    vi.mocked(api.getPrecomputedGraph).mockResolvedValue(makePayload() as any);

    await store.loadPrecomputedGraph(CONTEXT_ID, 'vizinhanca', {
      seed: '99872',
      hops: '3',
    });

    expect(api.getPrecomputedGraph).toHaveBeenCalledWith(CONTEXT_ID, 'vizinhanca', {
      seed: '99872',
      hops: '3',
    });
  });

  it('sends an empty object when the URL carried no arguments', async () => {
    const store = useGraphStore();
    store.currentContext = makeContext();
    vi.mocked(api.getPrecomputedGraph).mockResolvedValue(makePayload() as any);

    await store.loadPrecomputedGraph(CONTEXT_ID, 'plain');

    expect(api.getPrecomputedGraph).toHaveBeenCalledWith(CONTEXT_ID, 'plain', {});
  });

  it('exposes the resolving provider and its arguments for the status chip', async () => {
    const store = useGraphStore();
    store.currentContext = makeContext();
    vi.mocked(api.getPrecomputedGraph).mockResolvedValue(
      makePayload({ provider: 'lakebase-bfs', params: { seed: '99872', hops: 3 } }) as any,
    );

    await store.loadPrecomputedGraph(CONTEXT_ID, 'vizinhanca', { seed: '99872' });

    expect(store.currentPrecomputedGraph?.provider).toBe('lakebase-bfs');
    expect(store.currentPrecomputedGraph?.params).toEqual({ seed: '99872', hops: 3 });
  });

  it('a slow response does not overwrite a newer one', async () => {
    // Editing ?seed= in the address bar makes overlapping requests routine, so
    // the store has to be able to lose a race rather than paint a stale graph.
    const store = useGraphStore();
    store.currentContext = makeContext();

    let releaseFirst: (value: unknown) => void = () => {};
    const firstInFlight = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    vi.mocked(api.getPrecomputedGraph)
      .mockImplementationOnce(
        async () =>
          firstInFlight.then(() =>
            makePayload({ name: 'stale', graph: { nodes: [makeNode('old')], edges: [], truncated: false } }),
          ) as any,
      )
      .mockResolvedValueOnce(
        makePayload({
          name: 'fresh',
          graph: { nodes: [makeNode('new')], edges: [], truncated: false },
        }) as any,
      );

    const slow = store.loadPrecomputedGraph(CONTEXT_ID, 'stale', { seed: '1' });
    await store.loadPrecomputedGraph(CONTEXT_ID, 'fresh', { seed: '2' });
    releaseFirst(null);
    await slow;

    expect(store.currentPrecomputedGraph?.name).toBe('fresh');
    expect(store.nodes.map((n) => n.node_id)).toEqual(['new']);
  });

  it('a stale failure does not clobber the error state of a newer load', async () => {
    const store = useGraphStore();
    store.currentContext = makeContext();

    let rejectFirst: (reason: unknown) => void = () => {};
    const firstInFlight = new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });

    vi.mocked(api.getPrecomputedGraph)
      .mockImplementationOnce(() => firstInFlight as any)
      .mockResolvedValueOnce(makePayload({ name: 'fresh' }) as any);

    const slow = store.loadPrecomputedGraph(CONTEXT_ID, 'stale', { seed: '1' });
    await store.loadPrecomputedGraph(CONTEXT_ID, 'fresh', { seed: '2' });
    rejectFirst(new Error('boom'));
    await expect(slow).rejects.toThrow('boom');

    expect(store.queryError).toBeNull();
    expect(store.currentPrecomputedGraph?.name).toBe('fresh');
  });
});

describe('graph store — savePrecomputedGraph', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(api.putPrecomputedGraph).mockResolvedValue({
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

    await store.savePrecomputedGraph('c1', 'cypher');

    const [contextId, name, body] = vi.mocked(api.putPrecomputedGraph).mock.calls[0];
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

    await store.savePrecomputedGraph('c1');

    expect(vi.mocked(api.putPrecomputedGraph).mock.calls[0][2].graph.properties_deferred).toBe(
      false,
    );
  });

  it('refuses while node properties are still loading', async () => {
    // Caching mid-enrichment would persist nulls and replay an empty-looking graph.
    const store = useGraphStore();
    store.currentContext = makeContext();
    store.nodes = [makeNode('n1', null)];
    store.pendingPropertyNodeIds.add('n1');

    await expect(store.savePrecomputedGraph('c1')).rejects.toThrow(/still loading/i);
    expect(api.putPrecomputedGraph).not.toHaveBeenCalled();
  });

  it('refuses an empty graph', async () => {
    const store = useGraphStore();
    store.currentContext = makeContext();

    await expect(store.savePrecomputedGraph('c1')).rejects.toThrow(/empty/i);
    expect(api.putPrecomputedGraph).not.toHaveBeenCalled();
  });

  it('refuses without a context', async () => {
    const store = useGraphStore();
    await expect(store.savePrecomputedGraph('c1')).rejects.toThrow(/context/i);
    expect(api.putPrecomputedGraph).not.toHaveBeenCalled();
  });
});

describe('graph store — clear()', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('forgets the active cache', async () => {
    const store = useGraphStore();
    vi.mocked(api.getPrecomputedGraph).mockResolvedValue(makePayload());
    await store.loadPrecomputedGraph(CONTEXT_ID, 'c1');
    expect(store.currentPrecomputedGraph).not.toBeNull();

    store.clear();

    expect(store.currentPrecomputedGraph).toBeNull();
  });
});
