import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/vue';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import DataTablePanel from '@/components/DataTablePanel.vue';
import { useGraphStore } from '@/stores/graph';

beforeEach(() => {
  setActivePinia(createPinia());
});

// Properties patched in place (late loading, enrichment files, the user's layer) keep the
// arrays; the table follows `nodePatchVersion` so a new column shows without a re-filter.
describe('DataTablePanel — properties patched in place', () => {
  it('shows a column an enrichment adds', async () => {
    const graphStore = useGraphStore();
    graphStore.nodes = [{ node_id: 'n1', node_type: 'Person', properties: { name: 'Ana' } }];
    const { container } = render(DataTablePanel, { global: { plugins: [[PrimeVue, { theme: 'none' }]] } });
    expect(container.textContent).not.toContain('risk');

    graphStore.patchNodeProperties(new Map([['n1', { risk: 'high' }]]), { merge: true });
    await nextTick();
    // The header is the union of property keys (happy-dom renders no body cells here).
    expect(container.textContent).toContain('risk');
  });
});

describe('DataTablePanel — enrichment provenance', () => {
  it('marks a column an enrichment query wrote and shows the run while it is going', async () => {
    const { api } = await import('@/services/api');
    const { vi } = await import('vitest');
    const { flushPromises } = await import('@vue/test-utils');
    const graphStore = useGraphStore();
    graphStore.currentContext = {
      id: 'c1', title: 'Bank', edge_table_name: 'main.bank.edges',
      enrichment_tables: [{ name: 'tier', label: 'Tier', table: 'main.bank.accts', query: { sql: 's', run: 'manual', target: 'nodes' } }],
    } as never;
    graphStore.nodes = [
      { node_id: 'a', node_type: 'Account', properties: { name: 'Ana' } },
      { node_id: 'b', node_type: 'Account', properties: { name: 'Bia' } },
    ];
    let answer!: (r: unknown) => void;
    vi.spyOn(api, 'runEnrichmentQuery').mockImplementation(() => new Promise((resolve) => { answer = resolve as never; }));
    const { container, queryByTestId, getByTestId } = render(DataTablePanel, { global: { plugins: [[PrimeVue, { theme: 'none' }]] } });

    const run = graphStore.runQueryEnrichment({ names: ['tier'] });
    await nextTick();
    expect(getByTestId('data-table-enriching-nodes').getAttribute('title')).toContain('Tier');
    expect(queryByTestId('data-table-enriched-col')).toBeNull();

    answer({ name: 'tier', label: 'Tier', target: 'nodes', columns: ['tier'], rows: { a: { tier: 'gold' } }, truncated: false });
    await run;
    await flushPromises();
    expect(queryByTestId('data-table-enriching-nodes')).toBeNull();
    expect(container.textContent).toContain('tier');
    const marks = container.querySelectorAll('[data-testid="data-table-enriched-col"]');
    expect(marks).toHaveLength(1);
    expect(marks[0].getAttribute('title')).toContain("'Tier' (1 of 2 rows)");
    vi.restoreAllMocks();
  });
});

describe('DataTablePanel — where a value came from', () => {
  it('marks layer columns and tints the cells a query or the layer wrote', async () => {
    const { api } = await import('@/services/api');
    const { vi } = await import('vitest');
    const graphStore = useGraphStore();
    graphStore.currentContext = {
      id: 'c1', title: 'Bank', edge_table_name: 'main.bank.edges',
      enrichment_tables: [{ name: 'tier', label: 'Tier', table: 'main.bank.accts', query: { sql: 's', run: 'manual', target: 'nodes' } }],
    } as never;
    graphStore.nodes = [
      { node_id: 'a', node_type: 'Account', properties: { risk: 'low' } },
      { node_id: 'b', node_type: 'Account', properties: {} },
    ];
    await graphStore.setOverlayEnrichment({
      id: 'f1', filename: 'risk.csv', row_count: 2,
      spec: { name: 'Risk', input: { delimiter: ',', header: true }, key_column: 'id', columns: ['segment'], match_node_types: [], match_source: 'node_id' },
      rows: { a: [{ segment: 'retail' }], b: [{ segment: 'corp' }] },
    });
    vi.spyOn(api, 'runEnrichmentQuery').mockResolvedValue({ name: 'tier', label: 'Tier', target: 'nodes', columns: ['tier'], rows: { b: { tier: 'gold' } }, truncated: false } as never);
    await graphStore.runQueryEnrichment({ names: ['tier'] });

    // happy-dom renders the headers, not the virtualized body: check the marks and the origin lookup.
    const { container } = render(DataTablePanel, { global: { plugins: [[PrimeVue, { theme: 'none' }]] } });
    await nextTick();
    const layer = container.querySelector('[data-testid="data-table-layer-col"]');
    expect(layer?.getAttribute('title')).toContain('(2 of 2 rows)');
    expect(container.querySelectorAll('[data-testid="data-table-enriched-col"]')).toHaveLength(1);
    const [a, b] = graphStore.nodes;
    expect(graphStore.propertyOrigin('node', b, 'tier')).toBe('Tier');
    expect(graphStore.propertyOrigin('node', a, 'segment')).toBe('layer');
    expect(graphStore.propertyOrigin('node', a, 'risk')).toBeNull();
    vi.restoreAllMocks();
  });
});
