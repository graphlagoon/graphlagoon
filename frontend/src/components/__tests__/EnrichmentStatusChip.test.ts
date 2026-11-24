import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import EnrichmentStatusChip from '@/components/EnrichmentStatusChip.vue';
import { useGraphStore, type QueryEnrichmentRun } from '@/stores/graph';
import { waitingOnEnrichment } from '@/composables/useAfterQueryAnalysis';

const record = (over: Partial<QueryEnrichmentRun>): QueryEnrichmentRun => ({
  status: 'done', label: 'Risk', target: 'edges', matched: 1, written: 1, total: 2,
  truncated: false, error: null, at: 0, finishedAt: 400, ...over,
});

const mount = () => render(EnrichmentStatusChip, {
  global: { plugins: [[PrimeVue, { theme: 'none' }]], stubs: { YourDataModal: true } },
});

describe('EnrichmentStatusChip', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    waitingOnEnrichment.value = null;
  });

  it('is absent when no enrichment ran', () => {
    const { queryByTestId } = mount();
    expect(queryByTestId('enrichment-status-chip')).toBeNull();
  });

  it('says how far a run is, then lists every run with its error and a Retry', async () => {
    const graph = useGraphStore();
    graph.currentContext = { id: 'c1', enrichment_tables: [{ name: 'kyc', label: 'KYC', description: 'KYC tier per account.', provider: { name: 'kyc' } }] } as never;
    graph.queryEnrichmentRuns = { risk: record({}), kyc: record({ label: 'KYC', status: 'running', finishedAt: null }) };
    const { getByTestId, findByTestId, findAllByTestId } = mount();
    expect(getByTestId('enrichment-status-chip').textContent).toContain('Enriching 1 of 2');

    graph.queryEnrichmentRuns = {
      risk: record({}),
      kyc: record({ label: 'KYC', status: 'error', error: 'Lakebase is down', errorCode: 'ENRICHMENT_PROVIDER_FAILED' }),
    };
    waitingOnEnrichment.value = { labels: ['Clusters “By risk”'], reason: 'failed' };
    await fireEvent.click(getByTestId('enrichment-status-chip'));
    expect(getByTestId('enrichment-status-chip').textContent).toContain('Enrichment: 1 failed');
    const details = (await findAllByTestId('enrichment-status-detail')).map((d) => d.textContent);
    expect(details[1]).toContain('ENRICHMENT_PROVIDER_FAILED: Lakebase is down');
    expect((await findAllByTestId('enrichment-status-description')).map((d) => d.textContent)).toEqual(['KYC tier per account.']);
    expect((await findByTestId('enrichment-status-waiting')).textContent).toContain('Clusters “By risk”');
    expect(getByTestId('enrichment-status-chip').textContent).toContain('1 analysis skipped');

    const retry = vi.spyOn(graph, 'runQueryEnrichment').mockResolvedValue({});
    await fireEvent.click(await findByTestId('enrichment-status-retry'));
    expect(retry).toHaveBeenCalledWith({ names: ['kyc'] });
  });
});
