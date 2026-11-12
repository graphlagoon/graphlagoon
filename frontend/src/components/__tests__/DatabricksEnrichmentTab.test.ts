import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import DatabricksEnrichmentTab from '@/components/DatabricksEnrichmentTab.vue';
import { useGraphStore } from '@/stores/graph';
import { api } from '@/services/api';

const tables = [
  { name: 'kyc', label: 'KYC', table: 'main.bank.kyc' },
  { name: 'risk', label: 'Tx risk', table: 'main.bank.tx', query: { sql: 'SELECT edge_id FROM graph_edges', run: 'manual' } },
];

function setup(enrichment_tables: unknown[] = tables) {
  const graph = useGraphStore();
  graph.currentContext = { id: 'c1', title: 'Bank', enrichment_tables } as never;
  graph.nodes = [{ node_id: 'a', node_type: 'A' }, { node_id: 'b', node_type: 'A' }];
  graph.edges = [
    { edge_id: 'e1', src: 'a', dst: 'b', relationship_type: 'PIX', properties: {} },
    { edge_id: 'e2', src: 'b', dst: 'a', relationship_type: 'PIX', properties: {} },
  ];
  return { graph, wrapper: mount(DatabricksEnrichmentTab) };
}

describe('DatabricksEnrichmentTab', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('says how to add a query when the context has none', () => {
    const { wrapper } = setup([tables[0]]);
    expect(wrapper.find('[data-testid="your-data-databricks-empty"]').text()).toContain('Enrich with a query');
    expect(wrapper.find('[data-testid="your-data-databricks-query"]').exists()).toBe(false);
  });

  it('lists the queries with the authorized tables and runs one by hand', async () => {
    vi.spyOn(api, 'runEnrichmentQuery').mockResolvedValue({
      name: 'risk', label: 'Tx risk', target: 'edges', columns: ['score'], rows: { e1: { score: 3 } }, truncated: true,
    });
    const { graph, wrapper } = setup();
    expect(wrapper.get('[data-testid="your-data-databricks-tables"]').text()).toContain('main.bank.kyc, main.bank.tx');
    expect(wrapper.get('[data-testid="your-data-databricks-query"]').text()).toContain('by hand');
    await wrapper.get('[data-testid="your-data-databricks-run"]').trigger('click');
    await flushPromises();
    expect(graph.edges[0].properties).toEqual({ score: 3 });
    const outcome = wrapper.get('[data-testid="your-data-databricks-outcome"]').text();
    expect(outcome).toContain('1 of 2 edges matched a row');
    expect(outcome).toContain('row limit');
  });

  it('shows why a run failed', async () => {
    vi.spyOn(api, 'runEnrichmentQuery').mockRejectedValue({
      response: { data: { detail: { error: { code: 'ENRICHMENT_SCOPE_DENIED', message: 'it reads hr.salaries' } } } },
    });
    const { wrapper } = setup();
    await wrapper.get('[data-testid="your-data-databricks-run"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="your-data-databricks-outcome"]').text()).toContain('hr.salaries');
  });
});
