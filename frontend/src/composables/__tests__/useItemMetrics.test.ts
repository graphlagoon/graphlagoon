import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { ref } from 'vue';
import { useItemMetrics, type SelectedGraphItem } from '@/composables/useItemMetrics';
import { useMetricsStore } from '@/stores/metrics';
import { useGraphStore } from '@/stores/graph';
import { createComputedMetric } from '@/__tests__/fixtures/metrics';

beforeEach(() => {
  setActivePinia(createPinia());
  const g = useGraphStore();
  g.nodes = [{ node_id: 'n1', node_type: 'T' }, { node_id: 'n2', node_type: 'T' }];
  g.edges = [{ edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'R' }];
});

describe('useItemMetrics', () => {
  it('lists built-in, computed and custom (any value type) metrics that have a value for the item', () => {
    const m = useMetricsStore();
    m.upsertMetric(createComputedMetric({ id: 'custom:s', name: 'Domain', valueType: 'string', values: new Map([['n1', 'x.com']]) }));
    m.upsertMetric(createComputedMetric({ id: 'custom:b', name: 'Hub', valueType: 'boolean', values: new Map([['n2', true]]) }));
    const item = ref<SelectedGraphItem | null>({ type: 'node', data: { node_id: 'n1', node_type: 'T' } });
    const list = useItemMetrics(item);
    expect(list.value).toEqual([
      { id: '__builtin_degree', name: 'Degree', value: 1, valueType: 'number' },
      { id: 'custom:s', name: 'Domain', value: 'x.com', valueType: 'string' },
    ]);
    item.value = { type: 'node', data: { node_id: 'n2', node_type: 'T' } };
    expect(list.value.map((e) => e.name)).toEqual(['Degree', 'Hub']);
    item.value = null;
    expect(list.value).toEqual([]);
  });

  it('uses edge metrics for edges and reacts to a same-size recompute', () => {
    const m = useMetricsStore();
    m.upsertMetric(createComputedMetric({ id: 'custom:w', name: 'W', target: 'edge', values: new Map([['e1', 1]]) }));
    const list = useItemMetrics({ type: 'edge', data: { edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'R' } });
    expect(list.value).toEqual([{ id: 'custom:w', name: 'W', value: 1, valueType: 'number' }]);
    m.upsertMetric(createComputedMetric({ id: 'custom:w', name: 'W', target: 'edge', values: new Map([['e1', 7]]) }));
    expect(list.value[0].value).toBe(7);
  });
});
