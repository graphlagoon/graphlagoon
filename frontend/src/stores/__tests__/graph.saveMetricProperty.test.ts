import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useGraphStore } from '@/stores/graph';
import { api } from '@/services/api';
import type { Exploration, Node } from '@/types/graph';
import type { ComputedMetric } from '@/types/metrics';

/** F2.7: "save as property" persists the values in the snapshot and journals the case. */
describe('graph store — saveMetricAsProperty', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('writes node properties, saves the snapshot and journals metric.saved', async () => {
    const store = useGraphStore();
    store.nodes = [
      { node_id: 'a', node_type: 'Conta', properties: { banco: '1' } },
      { node_id: 'b', node_type: 'Conta', properties: {} },
    ] as Node[];
    const exp = { id: 'exp-1', title: 'Golpe', has_write_access: true } as unknown as Exploration;
    store.currentExploration = exp;
    const update = vi.spyOn(api, 'updateExploration').mockResolvedValue(exp);
    const list = vi.spyOn(api, 'getInvestigations').mockResolvedValue([
      { id: 'case-1', has_write_access: true, status: 'analise' },
      { id: 'case-2', has_write_access: false, status: 'analise' },
    ] as never);
    const post = vi.spyOn(api, 'postInvestigationEvent').mockResolvedValue({} as never);

    const metric = {
      id: 'm1', name: 'pagerank', algorithmId: 'pagerank', target: 'node',
      values: new Map([['a', 0.7]]),
    } as unknown as ComputedMetric;
    const r = await store.saveMetricAsProperty(metric);

    expect(r).toEqual({ nodes: 1, persisted: true, cases: 1 });
    expect(store.nodes[0].properties).toEqual({ banco: '1', pagerank: 0.7 });
    const snapshot = update.mock.calls[0][1].snapshot as { nodes: { id: string; properties: object }[] };
    expect(snapshot.nodes.find((n) => n.id === 'a')!.properties).toMatchObject({ pagerank: 0.7 });
    expect(list).toHaveBeenCalledWith({ exploration_id: 'exp-1' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('case-1', 'metric.saved', expect.objectContaining({ property: 'pagerank', nodes: 1 }));
  });
});
