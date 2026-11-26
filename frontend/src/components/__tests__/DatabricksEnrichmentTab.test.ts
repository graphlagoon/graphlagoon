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
    expect(wrapper.find('[data-testid="your-data-databricks-empty"]').text()).toContain('Enrichments');
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

  it('says what each enrichment does: the author\u2019s words, or the registered provider\u2019s', () => {
    window.__GRAPH_LAGOON_CONFIG__ = {
      enrichment_providers: [{ name: 'kyc-demo', label: 'KYC', description: 'Risk from Lakebase', targets: ['nodes'] }],
    };
    try {
      const { wrapper } = setup([
        { ...tables[1], description: 'Risk per transaction. Run before sizing edges.' },
        { name: 'kyc', label: 'KYC', provider: { name: 'kyc-demo', target: 'nodes', run: 'manual' } },
      ]);
      const said = wrapper.findAll('[data-testid="your-data-databricks-description"]').map((d) => d.text());
      expect(said).toEqual(['Risk per transaction. Run before sizing edges.', 'Risk from Lakebase']);
    } finally {
      delete window.__GRAPH_LAGOON_CONFIG__;
    }
  });

  it('lets a run change only the parameters the author left open, and says what it ran with', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = {
      enrichment_providers: [{
        name: 'kyc-demo', label: 'KYC', description: 'Risk from Lakebase', targets: ['nodes'], columns: ['kyc_tier'],
        params: [
          { name: 'as_of_days', type: 'int', required: false, default: 30, description: 'Window', choices: null, min: 1, max: 365 },
          { name: 'source', type: 'str', required: false, default: 'internal', description: '', choices: ['bureau', 'internal'], min: null, max: null },
        ],
      }],
    };
    try {
      const spy = vi.spyOn(api, 'runEnrichmentQuery').mockResolvedValue({
        name: 'kyc', label: 'KYC', target: 'nodes', columns: ['kyc_tier'], rows: { a: { kyc_tier: 'low' } }, truncated: false,
        params: { as_of_days: 7, source: 'internal' },
      });
      const { wrapper } = setup([
        { name: 'kyc', label: 'KYC', provider: { name: 'kyc-demo', target: 'nodes', run: 'manual', params: { as_of_days: 90 }, runtime_params: ['as_of_days'] } },
      ]);
      expect(wrapper.get('[data-testid="your-data-databricks-columns"]').text()).toBe('Adds: kyc_tier');
      // Only the open one is offered, with this context's value as the default.
      expect(wrapper.find('[data-testid="your-data-databricks-param-source"]').exists()).toBe(false);
      const input = wrapper.get('[data-testid="your-data-databricks-param-as_of_days"]');
      expect(input.attributes('placeholder')).toContain('90');
      await input.setValue('999');
      expect(wrapper.get('[data-testid="your-data-databricks-param-problem"]').text()).toContain('at most 365');
      expect(wrapper.get('[data-testid="your-data-databricks-run"]').attributes('disabled')).toBeDefined();
      await input.setValue('7');
      await wrapper.get('[data-testid="your-data-databricks-run"]').trigger('click');
      await flushPromises();
      expect(spy.mock.calls[0][2].params).toEqual({ as_of_days: 7 });
      expect(wrapper.get('[data-testid="your-data-databricks-outcome"]').text()).toContain('with as_of_days=7, source=internal');
      // Nothing typed: the context's values, so nothing is sent.
      await input.setValue('');
      await wrapper.get('[data-testid="your-data-databricks-run"]').trigger('click');
      await flushPromises();
      expect(spy.mock.calls[1][2].params).toBeUndefined();
    } finally {
      delete window.__GRAPH_LAGOON_CONFIG__;
    }
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
