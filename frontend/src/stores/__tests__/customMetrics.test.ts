import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import { useCustomMetricsStore } from '@/stores/customMetrics';
import { useGraphStore } from '@/stores/graph';
import { useMetricsStore } from '@/stores/metrics';
import { api } from '@/services/api';
import { runDefinitions, serializeGraphForCustomMetrics, testDefinition } from '@/services/customMetricRunner';
import type { RunCallbacks } from '@/services/customMetricRunner';
import type { CustomMetricDefinition } from '@/types/customMetrics';
import { CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS } from '@/types/customMetrics';
import type { GraphContext } from '@/types/graph';
import type { ComputedMetric } from '@/types/metrics';
import { createComputedMetric } from '@/__tests__/fixtures/metrics';

vi.mock('@/services/api', () => ({
  api: { updateGraphContext: vi.fn() },
}));

vi.mock('@/services/customMetricRunner', () => ({
  runDefinitions: vi.fn(),
  serializeGraphForCustomMetrics: vi.fn(() => ({ nodes: [], edges: [] })),
  testDefinition: vi.fn(),
}));

const mockedUpdate = vi.mocked(api.updateGraphContext);
const mockedRun = vi.mocked(runDefinitions);
const mockedSnapshot = vi.mocked(serializeGraphForCustomMetrics);
const mockedTest = vi.mocked(testDefinition);

/** Capture the callbacks of the latest runDefinitions call and drive them. */
function latestRun() {
  const call = mockedRun.mock.calls[mockedRun.mock.calls.length - 1];
  return { defs: call[0], callbacks: call[2] as RunCallbacks };
}

// Most evaluation tests want the definitions to run on load → auto_run: true.
function makeDef(id = 'd1', overrides: Partial<CustomMetricDefinition> = {}): CustomMetricDefinition {
  return { id, name: `Metric ${id}`, target: 'node', value_type: 'number', code: 'return 1;', auto_run: true, ...overrides };
}

function makeMetric(defId: string, overrides: Partial<ComputedMetric> = {}): ComputedMetric {
  return createComputedMetric({
    id: `custom:${defId}`,
    name: `Metric ${defId}`,
    algorithmId: 'custom',
    definitionId: defId,
    elapsedMs: 3,
    errorCount: 0,
    ...overrides,
  });
}

function makeContext(overrides: Partial<GraphContext> = {}): GraphContext {
  return {
    id: 'ctx-1',
    title: 'Ctx',
    tags: [],
    edge_table_name: 'edges',
    node_table_name: 'nodes',
    edge_structure: { edge_id_col: 'edge_id', src_col: 'src', dst_col: 'dst', relationship_type_col: 'relationship_type' },
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

let resolveRun: () => void;

beforeEach(() => {
  delete (window as { __GRAPH_LAGOON_CONFIG__?: unknown }).__GRAPH_LAGOON_CONFIG__;
  setActivePinia(createPinia());
  vi.useFakeTimers();
  mockedUpdate.mockReset();
  mockedRun.mockReset();
  mockedTest.mockReset();
  mockedSnapshot.mockClear();
  mockedRun.mockImplementation(() => ({
    cancel: vi.fn(),
    done: new Promise<void>((res) => {
      resolveRun = res;
    }),
  }));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('customMetrics store — persistence', () => {
  it('hydrateFromContext replaces definitions and never PUTs', async () => {
    const store = useCustomMetricsStore();
    useGraphStore().currentContext = makeContext();
    store.hydrateFromContext([makeDef('a')]);
    await vi.runAllTimersAsync();
    expect(store.definitions).toHaveLength(1);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it('add/update/remove debounce into one PUT with the full list', async () => {
    const store = useCustomMetricsStore();
    const ctx = makeContext();
    useGraphStore().currentContext = ctx;
    mockedUpdate.mockResolvedValue(ctx);

    store.addDefinition(makeDef('a'));
    store.addDefinition(makeDef('b'));
    store.updateDefinition(makeDef('a', { name: 'Renamed' }));
    store.removeDefinition('b');
    expect(mockedUpdate).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    expect(mockedUpdate).toHaveBeenCalledWith('ctx-1', {
      metric_definitions: [makeDef('a', { name: 'Renamed' })],
    });
  });

  it('does not PUT without write access (reader)', async () => {
    const store = useCustomMetricsStore();
    useGraphStore().currentContext = makeContext({ has_write_access: false });
    store.addDefinition(makeDef('a'));
    await vi.runAllTimersAsync();
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it('resyncs graphStore.currentContext with the PUT response', async () => {
    const store = useCustomMetricsStore();
    const graphStore = useGraphStore();
    graphStore.currentContext = makeContext();
    const updated = makeContext({ title: 'from server', metric_definitions: [makeDef('a')] });
    mockedUpdate.mockResolvedValue(updated);
    store.addDefinition(makeDef('a'));
    await vi.runAllTimersAsync();
    expect(graphStore.currentContext?.title).toBe('from server');
  });

  it('upsertDefinitions updates by id, then by name, and adds the rest', async () => {
    const store = useCustomMetricsStore();
    const ctx = makeContext();
    useGraphStore().currentContext = ctx;
    mockedUpdate.mockResolvedValue(ctx);
    store.hydrateFromContext([makeDef('a', { name: 'Ratio' }), makeDef('b', { name: 'Domain' })]);

    const result = store.upsertDefinitions([
      makeDef('zzz', { name: 'RATIO', code: 'return 9;' }),
      makeDef('b', { name: 'Domain 2', code: 'return 8;' }),
      makeDef('c', { name: 'New' }),
    ]);
    expect(result).toEqual({ updated: 2, added: 1 });
    expect(store.definitions.map((d) => [d.id, d.name, d.code])).toEqual([
      ['a', 'RATIO', 'return 9;'],
      ['b', 'Domain 2', 'return 8;'],
      ['c', 'New', 'return 1;'],
    ]);
    await vi.runAllTimersAsync();
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
  });

  it('show_in_table travels with the definition: hydration seeds the table set, the toggle persists without a recompute', async () => {
    const store = useCustomMetricsStore();
    const metricsStore = useMetricsStore();
    const ctx = makeContext();
    useGraphStore().currentContext = ctx;
    mockedUpdate.mockResolvedValue(ctx);
    metricsStore.tableMetricIds.add('custom:gone');
    store.hydrateFromContext([makeDef('a', { show_in_table: true }), makeDef('b'), makeDef('gone')]);
    expect(metricsStore.tableMetricIds.has('custom:a')).toBe(true);
    expect(metricsStore.tableMetricIds.has('custom:b')).toBe(false);
    expect(metricsStore.tableMetricIds.has('custom:gone')).toBe(false); // definition says off
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    mockedRun.mockClear();

    store.setShowInTable('b', true);
    expect(metricsStore.tableMetricIds.has('custom:b')).toBe(true);
    expect(store.definitions[1].show_in_table).toBe(true);
    store.setShowInTable('a', false);
    expect(metricsStore.tableMetricIds.has('custom:a')).toBe(false);
    expect('show_in_table' in store.definitions[0]).toBe(false);
    await vi.runAllTimersAsync();
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    expect((mockedUpdate.mock.calls[0][1].metric_definitions ?? []).map((d: { id: string; show_in_table?: boolean }) => [d.id, d.show_in_table])).toEqual([
      ['a', undefined],
      ['b', true],
      ['gone', undefined],
    ]);
    expect(mockedRun).not.toHaveBeenCalled(); // toggling a column never re-evaluates
  });

  it('isNameAvailable is case-insensitive and ignores the edited definition', () => {
    const store = useCustomMetricsStore();
    store.hydrateFromContext([makeDef('a', { name: 'Email domain' })]);
    expect(store.isNameAvailable('email DOMAIN')).toBe(false);
    expect(store.isNameAvailable('email DOMAIN', 'a')).toBe(true);
    expect(store.isNameAvailable('Other')).toBe(true);
  });

  it('canEdit mirrors has_write_access', () => {
    const store = useCustomMetricsStore();
    const graphStore = useGraphStore();
    expect(store.canEdit).toBe(false);
    graphStore.currentContext = makeContext({ has_write_access: true });
    expect(store.canEdit).toBe(true);
    graphStore.currentContext = makeContext({ has_write_access: false });
    expect(store.canEdit).toBe(false);
  });
});

describe('customMetrics store — auto_run and feature flags', () => {
  it('on load only auto_run definitions are scheduled; the others are idle (or stale when they have values)', () => {
    const store = useCustomMetricsStore();
    const metricsStore = useMetricsStore();
    metricsStore.upsertMetric(makeMetric('old'));
    store.hydrateFromContext([
      makeDef('auto', { auto_run: true }),
      makeDef('manual', { auto_run: false }),
      makeDef('old', { auto_run: false }),
    ]);
    expect(store.autoRunIds).toEqual(['auto']);
    expect(store.runStates.get('auto')?.status).toBe('queued');
    expect(store.runStates.get('manual')?.status).toBe('idle');
    expect(store.runStates.get('old')?.status).toBe('stale');
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(latestRun().defs.map((d) => d.id)).toEqual(['auto']);
  });

  it('a graph change re-runs only auto_run definitions and marks computed manual ones stale', async () => {
    const store = useCustomMetricsStore();
    const metricsStore = useMetricsStore();
    const graphStore = useGraphStore();
    store.hydrateFromContext([makeDef('auto'), makeDef('manual', { auto_run: false })]);
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    // Manual one was computed by hand
    store.recomputeNow(['manual']);
    latestRun().callbacks.onResult('manual', makeMetric('manual'));
    expect(store.runStates.get('manual')?.status).toBe('done');
    mockedRun.mockClear();

    graphStore.nodes = [{ node_id: 'n1', node_type: 'T' }];
    await nextTick();
    expect(store.runStates.get('manual')?.status).toBe('stale');
    expect(metricsStore.computedMetrics.has('custom:manual')).toBe(true); // values kept
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    expect(latestRun().defs.map((d) => d.id)).toEqual(['auto']);
  });

  it('adding / editing / Recompute always evaluates, auto_run or not (the author asked)', () => {
    const store = useCustomMetricsStore();
    useGraphStore().currentContext = makeContext();
    store.addDefinition(makeDef('m', { auto_run: false }));
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    expect(latestRun().defs.map((d) => d.id)).toEqual(['m']);
  });

  it('server flag custom_metrics_auto_run_enabled=false makes every definition manual', () => {
    window.__GRAPH_LAGOON_CONFIG__ = { custom_metrics_auto_run_enabled: false };
    setActivePinia(createPinia());
    const store = useCustomMetricsStore();
    store.hydrateFromContext([makeDef('auto', { auto_run: true })]);
    expect(store.autoRunAllowed).toBe(false);
    expect(store.autoRunIds).toEqual([]);
    expect(store.runStates.get('auto')?.status).toBe('idle');
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS * 2);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('server flag custom_metrics_enabled=false hydrates nothing, never runs, and disables editing', () => {
    window.__GRAPH_LAGOON_CONFIG__ = { custom_metrics_enabled: false };
    setActivePinia(createPinia());
    const store = useCustomMetricsStore();
    useGraphStore().currentContext = makeContext({ has_write_access: true });
    store.hydrateFromContext([makeDef('auto', { auto_run: true })]);
    expect(store.definitions).toEqual([]);
    expect(store.canEdit).toBe(false);
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS * 2);
    expect(mockedRun).not.toHaveBeenCalled();
  });
});

describe('customMetrics store — evaluation', () => {
  it('hydration schedules one debounced run over every definition', async () => {
    const store = useCustomMetricsStore();
    store.hydrateFromContext([makeDef('a'), makeDef('b')]);
    expect(store.runStates.get('a')?.status).toBe('queued');
    expect(mockedRun).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(latestRun().defs.map((d) => d.id)).toEqual(['a', 'b']);
    expect(mockedSnapshot).toHaveBeenCalledTimes(1); // one snapshot per cycle
  });

  it('D10 a reader (empty list) never spawns a run', () => {
    const store = useCustomMetricsStore();
    useGraphStore().currentContext = makeContext({ has_write_access: false, metric_definitions: [] });
    store.hydrateFromContext([]);
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS * 2);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('results land in the metrics store under custom:<id> and run state becomes done', async () => {
    const store = useCustomMetricsStore();
    const metricsStore = useMetricsStore();
    store.hydrateFromContext([makeDef('a')]);
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    const { callbacks } = latestRun();
    callbacks.onStarted?.('a');
    expect(store.runStates.get('a')?.status).toBe('running');
    callbacks.onProgress?.('a', 50, 100);
    expect(store.runStates.get('a')?.progress).toBe(50);
    callbacks.onResult('a', makeMetric('a', { errorCount: 2 }));
    resolveRun();
    await vi.runAllTimersAsync();
    expect(metricsStore.computedMetrics.get('custom:a')?.definitionId).toBe('a');
    expect(store.runStates.get('a')).toMatchObject({ status: 'done', progress: 100, elapsedMs: 3, errorCount: 2 });
    expect(store.isComputing).toBe(false);
  });

  it('timeout / compile errors surface in runStates', async () => {
    const store = useCustomMetricsStore();
    store.hydrateFromContext([makeDef('a')]);
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    latestRun().callbacks.onError('a', 'Timed out after 10s');
    expect(store.runStates.get('a')).toMatchObject({ status: 'error', error: 'Timed out after 10s' });
  });

  it('editing a definition recomputes only that definition', () => {
    const store = useCustomMetricsStore();
    useGraphStore().currentContext = makeContext();
    store.hydrateFromContext([makeDef('a'), makeDef('b')]);
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    mockedRun.mockClear();
    store.updateDefinition(makeDef('b', { code: 'return 2;' }));
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    expect(latestRun().defs.map((d) => d.id)).toEqual(['b']);
  });

  it('a full recompute request coalesces with pending per-id requests', () => {
    const store = useCustomMetricsStore();
    useGraphStore().currentContext = makeContext();
    store.hydrateFromContext([makeDef('a'), makeDef('b')]);
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    mockedRun.mockClear();
    store.updateDefinition(makeDef('a'));
    store.scheduleRecompute(); // everything
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(latestRun().defs.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('a new run cancels the in-flight one', () => {
    const store = useCustomMetricsStore();
    store.hydrateFromContext([makeDef('a')]);
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    const first = mockedRun.mock.results[0].value;
    store.scheduleRecompute();
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    expect(first.cancel).toHaveBeenCalled();
    expect(mockedRun).toHaveBeenCalledTimes(2);
  });

  it('graph population changes and late properties (nodePatchVersion) trigger a recompute', async () => {
    const store = useCustomMetricsStore();
    const graphStore = useGraphStore();
    store.hydrateFromContext([makeDef('a')]);
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    mockedRun.mockClear();

    graphStore.nodes = [{ node_id: 'n1', node_type: 'T' }];
    await nextTick();
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    expect(mockedRun).toHaveBeenCalledTimes(1);

    graphStore.nodePatchVersion++;
    await nextTick();
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    expect(mockedRun).toHaveBeenCalledTimes(2);
  });

  it('graph changes do nothing when there are no definitions', async () => {
    useCustomMetricsStore();
    const graphStore = useGraphStore();
    graphStore.nodes = [{ node_id: 'n1', node_type: 'T' }];
    await nextTick();
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('removing a definition drops its metric; a context switch drops stale custom metrics', () => {
    const store = useCustomMetricsStore();
    const metricsStore = useMetricsStore();
    metricsStore.upsertMetric(makeMetric('a'));
    metricsStore.upsertMetric(makeMetric('b'));
    metricsStore.completeComputation(createComputedMetric({ id: 'run-1', name: 'PageRank' }));
    metricsStore.setNodeSizeMetric('custom:a');

    store.hydrateFromContext([makeDef('a'), makeDef('b')]);
    expect(metricsStore.computedMetrics.has('custom:a')).toBe(true);

    store.removeDefinition('b');
    expect(metricsStore.computedMetrics.has('custom:b')).toBe(false);

    // Next context only has 'c': 'a' is gone, the algorithm run survives.
    store.hydrateFromContext([makeDef('c')]);
    expect(metricsStore.computedMetrics.has('custom:a')).toBe(false);
    expect(metricsStore.computedMetrics.has('run-1')).toBe(true);
    expect(metricsStore.visualMapping.nodeSize.metricId).toBeNull();
  });

  it('a style preset naming custom:<id> resolves once the definition is recomputed', async () => {
    const store = useCustomMetricsStore();
    const metricsStore = useMetricsStore();
    metricsStore.loadVisualMappingState({ nodeSize: { metricId: 'custom:a', minSize: 4, maxSize: 20, scale: 'linear' } });
    expect(metricsStore.nodeSizeMetric).toBeNull(); // not computed yet → base sizing
    store.hydrateFromContext([makeDef('a')]);
    vi.advanceTimersByTime(CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS + 1);
    latestRun().callbacks.onResult('a', makeMetric('a'));
    expect(metricsStore.nodeSizeMetric?.id).toBe('custom:a');
  });

  it('testDefinition snapshots the graph and delegates to the runner without touching the store', async () => {
    const store = useCustomMetricsStore();
    const metricsStore = useMetricsStore();
    mockedTest.mockResolvedValue({ samples: [{ id: 'p1', value: 1, rawType: 'number' }], errorCount: 0, elapsedMs: 1 });
    const r = await store.testDefinition(makeDef('draft'));
    expect(r.samples).toHaveLength(1);
    expect(mockedTest).toHaveBeenCalledWith(makeDef('draft'), expect.anything());
    expect(metricsStore.computedMetrics.size).toBe(0);
    expect(store.definitions).toHaveLength(0);
  });
});
