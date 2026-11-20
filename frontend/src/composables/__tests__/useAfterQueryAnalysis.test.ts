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
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning.mock.calls[0][0]).toMatch(/skipped.*Retry/);
    // The Retry runs: running, then done.
    graph.queryEnrichmentRuns = { risk: record('running') };
    await flushPromises();
    expect(toast.warning).toHaveBeenCalledTimes(1);
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
});
