import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { effectScope, type EffectScope } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import { useGraphStore, type QueryEnrichmentRun } from '@/stores/graph';
import { useClusterStore } from '@/stores/cluster';
import { useAfterQueryAnalysis, waitingOnEnrichment } from '@/composables/useAfterQueryAnalysis';
import type { ClusterProgram } from '@/types/cluster';

const toast = { warning: vi.fn(), success: vi.fn(), info: vi.fn(), error: vi.fn() };
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }));

const program = (wait: boolean): ClusterProgram => ({
  program_id: 'p', program_name: 'By risk', code: 'return []', created_at: '', updated_at: '',
  wait_for_enrichment: wait,
});

const record = (status: QueryEnrichmentRun['status']): QueryEnrichmentRun => ({
  status, label: 'Risk', target: 'nodes', matched: 0, written: 0, total: 1, truncated: false, error: null, at: 0,
});

describe('useAfterQueryAnalysis and enrichment', () => {
  let scope: EffectScope;
  let graph: ReturnType<typeof useGraphStore>;
  let execute: ReturnType<typeof vi.fn>;

  function setup(wait: boolean) {
    setActivePinia(createPinia());
    graph = useGraphStore();
    const clusters = useClusterStore();
    vi.spyOn(clusters, 'getProgram').mockReturnValue(program(wait));
    execute = vi.fn().mockResolvedValue({ success: true, clusters: [] });
    vi.spyOn(clusters, 'executeProgram').mockImplementation(execute as never);
    graph.updateBehaviors({ afterQueryClusterProgram: 'p' });
    graph.nodes = [{ node_id: 'a', node_type: 'T', properties: {} }];
    scope = effectScope();
    scope.run(() => useAfterQueryAnalysis());
  }

  /** A query landed and its enrichment started (as applyGraphResponse leaves things). */
  async function queryLanded() {
    graph.queryEnrichmentRuns = { risk: record('running') };
    graph.queryEnrichmentInFlight = 1;
    graph.queryRunSeq++;
    await flushPromises();
  }

  async function enrichmentEnds(status: 'done' | 'error') {
    graph.queryEnrichmentInFlight = 0;
    graph.queryEnrichmentRuns = { risk: record(status) };
    await flushPromises();
  }

  beforeEach(() => {
    Object.values(toast).forEach((f) => f.mockReset());
    waitingOnEnrichment.value = null;
  });
  afterEach(() => scope.stop());

  it('a program that does not wait runs right after the query', async () => {
    setup(false);
    await queryLanded();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a waiting program runs once every enrichment succeeded', async () => {
    setup(true);
    await queryLanded();
    expect(execute).not.toHaveBeenCalled();
    expect(waitingOnEnrichment.value).toEqual({ labels: ['Clusters “By risk”'], reason: 'running' });
    await enrichmentEnds('done');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(waitingOnEnrichment.value).toBeNull();
  });

  it('is skipped with a message when one fails, and runs after a Retry succeeds', async () => {
    setup(true);
    await queryLanded();
    await enrichmentEnds('error');
    expect(execute).not.toHaveBeenCalled();
    expect(waitingOnEnrichment.value?.reason).toBe('failed');
    // The store's toast says an enrichment failed; the chip says what waits. No second toast here.
    expect(toast.warning).not.toHaveBeenCalled();
    // The Retry runs: running, then done.
    graph.queryEnrichmentRuns = { risk: record('running') };
    await flushPromises();
    await enrichmentEnds('done');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a new query drops what the previous one held', async () => {
    setup(true);
    await queryLanded();
    graph.updateBehaviors({ afterQueryClusterProgram: '' });
    graph.queryRunSeq++;
    await flushPromises();
    await enrichmentEnds('done');
    expect(execute).not.toHaveBeenCalled();
    expect(waitingOnEnrichment.value).toBeNull();
  });

  it('does not run on another graph: replacing the graph drops what was held', async () => {
    setup(true);
    await queryLanded();
    await enrichmentEnds('error');
    // Another context, exploration or precomputed graph: enrichment starts over, no new query ran.
    graph.queryEnrichmentEpoch++;
    graph.queryEnrichmentRuns = {};
    await flushPromises();
    expect(waitingOnEnrichment.value).toBeNull();
    await enrichmentEnds('done');
    expect(execute).not.toHaveBeenCalled();
  });

  it('stays skipped, without a toast, however many expands run while the failure stands', async () => {
    setup(true);
    await queryLanded();
    await enrichmentEnds('error');
    for (let i = 0; i < 2; i++) {
      graph.queryEnrichmentInFlight = 1; // an expand's run over the new items
      await flushPromises();
      graph.queryEnrichmentInFlight = 0;
      await flushPromises();
    }
    expect(toast.warning).not.toHaveBeenCalled();
    expect(waitingOnEnrichment.value?.reason).toBe('failed');
  });
});
