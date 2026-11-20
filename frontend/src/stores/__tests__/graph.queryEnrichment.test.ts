import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import { useGraphStore } from '@/stores/graph';
import { api } from '@/services/api';
import type { EnrichmentRunResult, GraphContext, GraphResponse } from '@/types/graph';

const toast = { warning: vi.fn(), success: vi.fn(), info: vi.fn(), error: vi.fn() };
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }));

/** Enrichment queries run after a query lands, and never reach the saved snapshot. */

const context = {
  id: 'c1',
  title: 'Bank',
  edge_table_name: 'main.bank.edges',
  enrichment_tables: [
    { name: 'risk', label: 'Risk', table: 'main.bank.tx', query: { sql: 'SELECT edge_id FROM graph_edges', run: 'auto' } },
    { name: 'audit', label: 'Audit', table: 'main.bank.audit', query: { sql: 'SELECT edge_id FROM graph_edges', run: 'manual' } },
    { name: 'kyc', label: 'KYC', table: 'main.bank.kyc' },
  ],
} as unknown as GraphContext;

const answer = (): GraphResponse => ({
  nodes: [
    { node_id: 'a', node_type: 'Account', properties: {} },
    { node_id: 'b', node_type: 'Account', properties: {} },
  ],
  edges: [{ edge_id: 'e1', src: 'a', dst: 'b', relationship_type: 'PIX', properties: { amount: 5, channel: 'app' } }],
  truncated: false,
});

const result = (rows: EnrichmentRunResult['rows']): EnrichmentRunResult => ({
  name: 'risk', label: 'Risk', target: 'edges', columns: ['score', 'channel'], rows, truncated: false,
});

describe('enrichment queries in the graph store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
    Object.values(toast).forEach((f) => f.mockReset());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function loaded() {
    const store = useGraphStore();
    store.currentContext = context;
    vi.spyOn(api, 'getSubgraph').mockResolvedValue(answer());
    await store.loadSubgraph();
    await flushPromises();
    return store;
  }

  it('runs only the auto queries after a load and marks what they wrote', async () => {
    const run = vi.spyOn(api, 'runEnrichmentQuery').mockResolvedValue(result({ e1: { score: 0.9, channel: 'web' } }));
    const store = await loaded();
    expect(run).toHaveBeenCalledTimes(1);
    const [ctxId, name, body] = run.mock.calls[0];
    expect([ctxId, name]).toEqual(['c1', 'risk']);
    expect(body.edges.map((e) => e.edge_id)).toEqual(['e1']);
    expect(body.nodes.map((n) => n.node_id)).toEqual(['a', 'b']);
    // A value already there is kept: channel is the context's, score is new.
    expect(store.edges[0].properties).toEqual({ amount: 5, channel: 'app', score: 0.9 });
    expect([...store.enrichedKeysFor('edge', 'e1')]).toEqual([['score', 'Risk']]);
    expect(store.queryEnrichmentRuns.risk).toMatchObject({ status: 'done', matched: 1, written: 1, total: 1 });
  });

  it('a manual run takes the named query; the saved snapshot leaves enriched values out', async () => {
    const run = vi.spyOn(api, 'runEnrichmentQuery').mockResolvedValue(result({}));
    const store = await loaded();
    run.mockResolvedValue({ ...result({ e1: { reviewed: 'yes' } }), name: 'audit', label: 'Audit' });
    const done = await store.runQueryEnrichment({ names: ['audit'] });
    expect(done.audit).toMatchObject({ status: 'done', matched: 1 });
    expect(store.edges[0].properties).toMatchObject({ reviewed: 'yes' });

    vi.spyOn(api, 'createExploration').mockResolvedValue({ id: 'new', title: 'T', has_write_access: true, state: {} } as never);
    await store.saveExploration('T');
    const created = vi.mocked(api.createExploration).mock.calls[0][1] as { snapshot: { edges: { properties: object }[] } };
    expect(created.snapshot.edges[0].properties).toEqual({ amount: 5, channel: 'app' });
  });

  it('a failing auto query warns once and leaves the graph usable', async () => {
    vi.spyOn(api, 'runEnrichmentQuery').mockRejectedValue(new Error('ENRICHMENT_QUERY_FAILED'));
    const store = await loaded();
    expect(store.edges).toHaveLength(1);
    expect(store.queryEnrichmentRuns.risk.status).toBe('error');
    expect(toast.warning).toHaveBeenCalledTimes(1);
    // A manual run reports in the dialog instead of a toast.
    await store.runQueryEnrichment({ names: ['audit'] });
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it('drops the rows of a run that a newer graph overtook', async () => {
    let answerRun!: (r: EnrichmentRunResult) => void;
    vi.spyOn(api, 'runEnrichmentQuery').mockImplementation(() => new Promise((resolve) => { answerRun = resolve; }));
    const store = await loaded();
    store.clear();
    store.currentContext = context;
    store.edges = answer().edges;
    answerRun(result({ e1: { score: 1 } }));
    await flushPromises();
    expect(store.edges[0].properties).toEqual({ amount: 5, channel: 'app' });
    expect(store.enrichedKeysFor('edge', 'e1').size).toBe(0);
  });

  it('after an expand, runs over the new edges only', async () => {
    const run = vi.spyOn(api, 'runEnrichmentQuery').mockResolvedValue(result({}));
    const store = await loaded();
    vi.spyOn(api, 'expandFromNode').mockResolvedValue({
      nodes: [{ node_id: 'c', node_type: 'Account', properties: {} }],
      edges: [{ edge_id: 'e2', src: 'b', dst: 'c', relationship_type: 'PIX', properties: {} }],
    } as never);
    await store.expandFromNode('b', 1);
    await flushPromises();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][2].edges.map((e) => e.edge_id)).toEqual(['e2']);
  });

  it('a node query writes node properties that survive a background property load', async () => {
    const store = useGraphStore();
    store.currentContext = {
      ...context,
      enrichment_tables: [{ name: 'acct', label: 'Account risk', table: 'main.bank.accts', query: { sql: 'SELECT node_id FROM graph_nodes', run: 'auto', target: 'nodes' } }],
    } as GraphContext;
    const run = vi.spyOn(api, 'runEnrichmentQuery').mockResolvedValue({ ...result({ a: { tier: 'gold' } }), target: 'nodes' });
    vi.spyOn(api, 'getSubgraph').mockResolvedValue(answer());
    await store.loadSubgraph();
    await flushPromises();
    const body = run.mock.calls[0][2];
    expect(body.nodes.map((n) => n.node_id)).toEqual(['a', 'b']);
    expect(body.edges.map((e) => e.edge_id)).toEqual(['e1']);
    expect(store.nodes[0].properties).toEqual({ tier: 'gold' });
    expect([...store.enrichedKeysFor('node', 'a')]).toEqual([['tier', 'Account risk']]);
    expect(store.queryEnrichmentRuns.acct).toMatchObject({ target: 'nodes', matched: 1, total: 2 });
    // Properties arriving late replace the dict; the query's value comes back.
    store.patchNodeProperties(new Map([['a', { name: 'Ana' }]]));
    expect(store.nodes[0].properties).toEqual({ name: 'Ana', tier: 'gold' });
  });

  it('the queries after the first wait as queued, and the table can tell', async () => {
    const store = useGraphStore();
    store.currentContext = {
      ...context,
      enrichment_tables: [
        { name: 'risk', label: 'Risk', table: 'main.bank.tx', query: { sql: 's', run: 'auto' } },
        { name: 'tier', label: 'Tier', table: 'main.bank.tx', query: { sql: 's', run: 'auto', target: 'nodes' } },
      ],
    } as GraphContext;
    let answerFirst!: (r: EnrichmentRunResult) => void;
    vi.spyOn(api, 'runEnrichmentQuery')
      .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }))
      .mockResolvedValue({ ...result({}), name: 'tier', target: 'nodes' });
    vi.spyOn(api, 'getSubgraph').mockResolvedValue(answer());
    await store.loadSubgraph();
    await flushPromises();
    expect(store.queryEnrichmentRuns.risk.status).toBe('running');
    expect(store.queryEnrichmentRuns.tier.status).toBe('queued');
    expect(store.runningQueryLabels('node')).toEqual(['Tier']);
    expect(store.runningQueryLabels('edge')).toEqual(['Risk']);
    answerFirst(result({}));
    await flushPromises();
    expect(store.runningQueryLabels('node')).toEqual([]);
  });

  it('runs every auto query, for edges and for nodes, one after the other', async () => {
    const store = useGraphStore();
    store.currentContext = {
      ...context,
      enrichment_tables: [
        { name: 'risk', label: 'Risk', table: 'main.bank.tx', query: { sql: 's', run: 'auto' } },
        { name: 'channel', label: 'Channel', table: 'main.bank.tx', query: { sql: 's', run: 'auto', overwrite: true } },
        { name: 'tier', label: 'Tier', table: 'main.bank.tx', query: { sql: 's', run: 'auto', target: 'nodes' } },
      ],
    } as GraphContext;
    const answers: Record<string, EnrichmentRunResult> = {
      risk: result({ e1: { score: 1 } }),
      channel: result({ e1: { channel: 'web' } }),
      tier: { ...result({ b: { tier: 'gold' } }), target: 'nodes' },
    };
    const run = vi.spyOn(api, 'runEnrichmentQuery').mockImplementation(async (_c, name) => answers[name]);
    vi.spyOn(api, 'getSubgraph').mockResolvedValue(answer());
    await store.loadSubgraph();
    await flushPromises();
    expect(run.mock.calls.map((c) => c[1])).toEqual(['risk', 'channel', 'tier']);
    expect(Object.values(store.queryEnrichmentRuns).map((r) => r.status)).toEqual(['done', 'done', 'done']);
    expect(store.edges[0].properties).toEqual({ amount: 5, channel: 'web', score: 1 });
    expect(store.nodes[1].properties).toEqual({ tier: 'gold' });
    expect([...store.enrichedKeysFor('edge', 'e1')]).toEqual([['score', 'Risk'], ['channel', 'Channel']]);
  });
  it('an expand that succeeds does not hide a failure over the whole graph; a Retry clears it', async () => {
    const run = vi.spyOn(api, 'runEnrichmentQuery').mockRejectedValue(
      Object.assign(new Error('x'), { response: { data: { detail: { error: { code: 'ENRICHMENT_PROVIDER_TIMEOUT', message: 'took too long' } } } } }),
    );
    const store = await loaded();
    expect(store.queryEnrichmentRuns.risk).toMatchObject({ status: 'error', errorCode: 'ENRICHMENT_PROVIDER_TIMEOUT' });
    expect(store.queryEnrichmentRuns.risk.finishedAt).toBeGreaterThanOrEqual(store.queryEnrichmentRuns.risk.at);
    run.mockResolvedValue(result({}));
    vi.spyOn(api, 'expandFromNode').mockResolvedValue({
      nodes: [{ node_id: 'c', node_type: 'Account', properties: {} }],
      edges: [{ edge_id: 'e2', src: 'b', dst: 'c', relationship_type: 'PIX', properties: {} }],
    } as never);
    await store.expandFromNode('b', 1);
    await flushPromises();
    expect(store.queryEnrichmentRuns.risk.status).toBe('error');
    await store.runQueryEnrichment({ names: ['risk'] });
    expect(store.queryEnrichmentRuns.risk).toMatchObject({ status: 'done', errorCode: null, batchesDone: 1, batchesTotal: 1 });
  });

  it('counts the calls in flight, so a waiting caller knows planning is not over', async () => {
    let answerRun!: (r: EnrichmentRunResult) => void;
    vi.spyOn(api, 'runEnrichmentQuery').mockImplementation(() => new Promise((resolve) => { answerRun = resolve; }));
    const store = await loaded();
    expect(store.queryEnrichmentInFlight).toBe(1);
    answerRun(result({}));
    await flushPromises();
    expect(store.queryEnrichmentInFlight).toBe(0);
  });

  it('runs a provider entry like a query', async () => {
    const run = vi.spyOn(api, 'runEnrichmentQuery').mockResolvedValue({
      ...result({ a: { kyc: 'high' } }), name: 'kyc_p', label: 'KYC provider', target: 'nodes',
    });
    const store = useGraphStore();
    store.currentContext = {
      ...context,
      enrichment_tables: [{ name: 'kyc_p', label: 'KYC provider', provider: { name: 'kyc-demo', target: 'nodes', run: 'auto' } }],
    } as GraphContext;
    vi.spyOn(api, 'getSubgraph').mockResolvedValue(answer());
    await store.loadSubgraph();
    await flushPromises();
    expect(run.mock.calls[0][1]).toBe('kyc_p');
    expect(run.mock.calls[0][2].nodes.map((n) => n.node_id)).toEqual(['a', 'b']);
    expect(store.nodes.find((n) => n.node_id === 'a')?.properties).toMatchObject({ kyc: 'high' });
    expect(store.queryEnrichmentRuns.kyc_p.status).toBe('done');
  });
});

describe('enrichment queries and the person\'s layer', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('a node query keeps the layer knowing its own values, so the snapshot leaves both out', async () => {
    const store = useGraphStore();
    store.currentContext = {
      ...context,
      enrichment_tables: [{ name: 'tier', label: 'Tier', table: 'main.bank.accts', query: { sql: 's', run: 'manual', target: 'nodes' } }],
    } as GraphContext;
    store.nodes = [{ node_id: 'b', node_type: 'Account', properties: { name: 'Bia' } }];
    await store.setOverlayEnrichment({
      id: 'f1', filename: 'r.csv', row_count: 1,
      spec: { name: 'R', input: { delimiter: ',', header: true }, key_column: 'id', columns: ['segment'], match_node_types: [], match_source: 'node_id' },
      rows: { b: [{ segment: 'corp' }] },
    } as never);
    vi.spyOn(api, 'runEnrichmentQuery').mockResolvedValue({ ...result({ b: { tier: 'gold' } }), name: 'tier', target: 'nodes' });
    await store.runQueryEnrichment({ names: ['tier'] });
    expect(store.nodes[0].properties).toEqual({ name: 'Bia', segment: 'corp', tier: 'gold' });
    expect(store.overlayKeysFor('node', 'b')).toEqual(new Set(['segment']));
    // The layer's value comes off what is saved (the query's value is stripped after it).
    expect(store.baseGraph().nodes[0].properties).toEqual({ name: 'Bia', tier: 'gold' });
  });
});
