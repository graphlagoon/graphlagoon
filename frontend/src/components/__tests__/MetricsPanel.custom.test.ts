/**
 * The Custom tab of the Metrics panel: reader gating, listing, statuses,
 * table toggle, recompute / delete wiring, and the value-type-aware bits of
 * the Compute / Visual Mapping tabs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import MetricsPanel from '@/components/MetricsPanel.vue';
import { useCustomMetricsStore } from '@/stores/customMetrics';
import { useMetricsStore } from '@/stores/metrics';
import { useGraphStore } from '@/stores/graph';
import type { CustomMetricDefinition } from '@/types/customMetrics';
import type { GraphContext } from '@/types/graph';
import { createComputedMetric } from '@/__tests__/fixtures/metrics';

vi.mock('@/services/api', () => ({
  api: { updateGraphContext: vi.fn().mockResolvedValue({}) },
}));

vi.mock('@/services/customMetricRunner', () => ({
  runDefinitions: vi.fn(() => ({ cancel: vi.fn(), done: new Promise(() => {}) })),
  serializeGraphForCustomMetrics: vi.fn(() => ({})),
  testDefinition: vi.fn(),
}));

vi.mock('@/services/metricsCalculator', () => ({
  getMetricsCalculator: () => ({
    computeMetric: vi.fn(),
    cancelComputation: vi.fn(),
    pauseComputation: vi.fn(),
    resumeComputation: vi.fn(),
    getResourceStatus: vi.fn(() => ({ activeWorkers: 0, maxWorkers: 1, queuedTasks: 0, memory: {} })),
  }),
}));

import { runDefinitions } from '@/services/customMetricRunner';
const mockedRun = vi.mocked(runDefinitions);

const stubs = {
  CustomMetricEditorModal: { template: '<div data-testid="editor-stub" />', props: ['definition'] },
  CustomMetricSkillModal: { template: '<div v-if="modelValue" data-testid="skill-stub" />', props: ['modelValue'] },
};

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

function makeDef(id: string, overrides: Partial<CustomMetricDefinition> = {}): CustomMetricDefinition {
  return { id, name: `Metric ${id}`, target: 'node', value_type: 'number', code: 'return 1;', ...overrides };
}

async function renderCustomTab() {
  const utils = render(MetricsPanel, { global: { stubs } });
  await fireEvent.click(utils.getByTestId('metrics-tab-custom'));
  return utils;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  mockedRun.mockClear();
  const g = useGraphStore();
  g.currentContext = makeContext();
  g.nodes = [{ node_id: 'n1', node_type: 'T' }, { node_id: 'n2', node_type: 'T' }];
  g.edges = [{ edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'R' }];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MetricsPanel — Custom tab', () => {
  it('readers see only the note (no list, no New button)', async () => {
    useGraphStore().currentContext = makeContext({ has_write_access: false });
    const { queryByTestId, getByTestId } = await renderCustomTab();
    expect(getByTestId('custom-metrics-readonly')).toBeTruthy();
    expect(queryByTestId('custom-metric-new')).toBeNull();
  });

  it('writers get the list with status, badges, table toggle, edit/recompute/delete', async () => {
    const store = useCustomMetricsStore();
    const metricsStore = useMetricsStore();
    store.hydrateFromContext([makeDef('a', { name: 'Domain', value_type: 'string', auto_run: true }), makeDef('b')]);
    const { getByTestId, queryByTestId } = await renderCustomTab();

    expect(queryByTestId('custom-metrics-readonly')).toBeNull();
    expect(getByTestId('custom-metric-item-a').textContent).toContain('Domain');
    expect(getByTestId('custom-metric-item-a').textContent).toContain('string');
    expect(getByTestId('custom-metric-status-a').textContent).toContain('queued');

    // Table toggle uses the stable custom id and is persisted on the definition
    await fireEvent.click(getByTestId('metric-table-toggle-custom:a'));
    expect(metricsStore.tableMetricIds.has('custom:a')).toBe(true);
    expect(store.definitions[0].show_in_table).toBe(true);
    await fireEvent.click(getByTestId('metric-table-toggle-custom:a'));
    expect(metricsStore.tableMetricIds.has('custom:a')).toBe(false);
    expect(store.definitions[0].show_in_table).toBeUndefined();

    // Recompute goes straight to the runner with that definition only
    await fireEvent.click(getByTestId('custom-metric-recompute-b'));
    expect(mockedRun).toHaveBeenCalled();
    const last = mockedRun.mock.calls[mockedRun.mock.calls.length - 1];
    expect(last[0].map((d) => d.id)).toEqual(['b']);

    // Edit opens the editor with the definition
    await fireEvent.click(getByTestId('custom-metric-edit-a'));
    expect(getByTestId('editor-stub')).toBeTruthy();

    // Delete removes immediately and offers Undo (no confirmation): the
    // definition is client state the panel can put straight back.
    await fireEvent.click(getByTestId('custom-metric-delete-a'));
    expect(store.definitions.map((d) => d.id)).toEqual(['b']);
    await nextTick();
    expect(queryByTestId('custom-metric-item-a')).toBeNull();
  });

  it('renders running / done / error statuses from the run state', async () => {
    const store = useCustomMetricsStore();
    store.hydrateFromContext([makeDef('a', { auto_run: true }), makeDef('b', { auto_run: true }), makeDef('c', { auto_run: true })]);
    store.runStates.set('a', { status: 'running', progress: 40, elapsedMs: 0, errorCount: 0 });
    store.runStates.set('b', { status: 'done', progress: 100, elapsedMs: 12.4, errorCount: 2 });
    store.runStates.set('c', { status: 'error', progress: 0, elapsedMs: 0, errorCount: 0, error: 'Timed out after 10s' });
    const { getByTestId } = await renderCustomTab();
    expect(getByTestId('custom-metric-status-a').textContent).toContain('running 40%');
    expect(getByTestId('custom-metric-status-b').textContent).toContain('done in 12 ms · 2 item errors');
    expect(getByTestId('custom-metric-status-c').textContent).toContain('error: Timed out after 10s');
    expect(getByTestId('custom-metric-status-c').classList.contains('is-error')).toBe(true);
  });

  it('manual definitions read "not computed" / "stale" and auto ones carry an auto marker', async () => {
    const store = useCustomMetricsStore();
    const metricsStore = useMetricsStore();
    metricsStore.upsertMetric(createComputedMetric({ id: 'custom:old', name: 'Old', algorithmId: 'custom', definitionId: 'old' }));
    store.hydrateFromContext([makeDef('m'), makeDef('old'), makeDef('auto', { auto_run: true })]);
    const { getByTestId } = await renderCustomTab();
    expect(getByTestId('custom-metric-status-m').textContent).toContain('not computed');
    expect(getByTestId('custom-metric-status-old').textContent).toContain('stale');
    expect(getByTestId('custom-metric-status-old').classList.contains('is-stale')).toBe(true);
    expect(getByTestId('custom-metric-status-auto').textContent).toContain('queued');
    expect(getByTestId('custom-metric-item-auto').textContent).toContain('auto');
    expect(getByTestId('custom-metric-item-m').textContent).not.toContain('auto');
  });

  it('the Custom tab disappears when the server disables the feature', () => {
    window.__GRAPH_LAGOON_CONFIG__ = { custom_metrics_enabled: false };
    setActivePinia(createPinia());
    useGraphStore().currentContext = makeContext();
    const { queryByTestId } = render(MetricsPanel, { global: { stubs } });
    expect(queryByTestId('metrics-tab-custom')).toBeNull();
    delete (window as { __GRAPH_LAGOON_CONFIG__?: unknown }).__GRAPH_LAGOON_CONFIG__;
  });

  it('New opens the editor without a definition', async () => {
    const { getByTestId, queryByTestId } = await renderCustomTab();
    expect(queryByTestId('editor-stub')).toBeNull();
    await fireEvent.click(getByTestId('custom-metric-new'));
    expect(getByTestId('editor-stub')).toBeTruthy();
  });

  it('the robot button opens the Ask-AI prompt modal (writers only)', async () => {
    const { getByTestId, queryByTestId } = await renderCustomTab();
    expect(queryByTestId('skill-stub')).toBeNull();
    await fireEvent.click(getByTestId('custom-metrics-skill-help'));
    expect(getByTestId('skill-stub')).toBeTruthy();

    useGraphStore().currentContext = makeContext({ has_write_access: false });
    await nextTick();
    expect(queryByTestId('custom-metrics-skill-help')).toBeNull();
  });
});

describe('MetricsPanel — value types elsewhere', () => {
  it('only numeric metrics are offered for node size; custom metrics are not repeated in the Compute list', async () => {
    const metricsStore = useMetricsStore();
    metricsStore.upsertMetric(createComputedMetric({ id: 'custom:s', name: 'Domain', algorithmId: 'custom', valueType: 'string', values: new Map([['n1', 'x']]) }));
    metricsStore.upsertMetric(createComputedMetric({ id: 'custom:n', name: 'Ratio', algorithmId: 'custom', valueType: 'number' }));
    metricsStore.upsertMetric(createComputedMetric({ id: 'run-1', name: 'PageRank', algorithmId: 'pagerank' }));

    const { queryByTestId, getByTestId, container } = render(MetricsPanel, { global: { stubs } });
    // Compute tab: built-in + algorithm runs only (custom ones live in the Custom tab)
    const items = Array.from(container.querySelectorAll('.metric-item'));
    expect(items.map((el) => el.querySelector('.metric-name')?.textContent)).toEqual(['Degree', 'PageRank']);
    expect(items[0].textContent).toContain('built-in');
    expect(items[0].querySelector('.mini-btn.danger')).toBeNull();
    expect(items[1].querySelector('.mini-btn.danger')).not.toBeNull();
    expect(queryByTestId('metric-table-toggle-custom:s')).toBeNull();
    expect(getByTestId('metric-table-toggle-run-1')).toBeTruthy();

    // Mapping tab: the node-size select lists Degree + Ratio + PageRank, never Domain
    const tabs = Array.from(container.querySelectorAll('.tab'));
    await fireEvent.click(tabs.find((t) => t.textContent?.includes('Visual Mapping'))!);
    const select = container.querySelector('select.form-select') as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent?.trim());
    expect(labels).toContain('Ratio');
    expect(labels).toContain('PageRank');
    expect(labels).not.toContain('Domain');
  });
});

describe('MetricsPanel — Custom tab import / export', () => {
  it('Import JSON updates metrics matched by id or name and adds the rest', async () => {
    const store = useCustomMetricsStore();
    store.hydrateFromContext([makeDef('a', { name: 'Ratio', code: 'return 1;' }), makeDef('b', { name: 'Old', code: 'return 0;' })]);
    const { getByTestId, queryByTestId } = await renderCustomTab();
    expect(queryByTestId('custom-metrics-import')).toBeNull();
    await fireEvent.click(getByTestId('custom-metrics-import-toggle'));
    await fireEvent.update(
      getByTestId('custom-metrics-import-text'),
      JSON.stringify([
        { name: 'ratio', target: 'node', code: 'return 2;' }, // by name (case-insensitive)
        { id: 'b', name: 'Renamed', target: 'node', code: 'return 3;' }, // by id
        { name: 'Domain', target: 'node', value_type: 'string', code: "return 'x';" }, // new
      ]),
    );
    await nextTick();
    await fireEvent.click(getByTestId('custom-metrics-import-apply'));
    expect(store.definitions.map((d) => [d.id, d.name, d.code])).toEqual([
      ['a', 'ratio', 'return 2;'],
      ['b', 'Renamed', 'return 3;'],
      [expect.any(String), 'Domain', "return 'x';"],
    ]);
    expect(store.definitions).toHaveLength(3);
    expect(queryByTestId('custom-metrics-import')).toBeNull();
  });

  it('shows the parse error inline', async () => {
    const { getByTestId } = await renderCustomTab();
    await fireEvent.click(getByTestId('custom-metrics-import-toggle'));
    await fireEvent.update(getByTestId('custom-metrics-import-text'), 'nope');
    await nextTick();
    expect(getByTestId('custom-metrics-import-parse-error').textContent).toContain('Not valid JSON');
    expect((getByTestId('custom-metrics-import-apply') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Export JSON is disabled without definitions and downloads all of them otherwise', async () => {
    const store = useCustomMetricsStore();
    const { getByTestId } = await renderCustomTab();
    expect((getByTestId('custom-metric-export-all') as HTMLButtonElement).disabled).toBe(true);

    store.hydrateFromContext([makeDef('a'), makeDef('b')]);
    await nextTick();
    let blob: Blob | null = null;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((b: Blob) => {
      blob = b;
      return 'blob:x';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      await fireEvent.click(getByTestId('custom-metric-export-all'));
      const payload = JSON.parse(await (blob as unknown as Blob).text());
      expect(payload.graphlagoon_export).toBe('custom-metrics');
      expect(payload.metrics.map((m: { id: string }) => m.id)).toEqual(['a', 'b']);
      expect(payload.source.context_title).toBe('Ctx');
    } finally {
      clickSpy.mockRestore();
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});
