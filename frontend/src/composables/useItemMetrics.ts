/**
 * The metric values (computed + custom) that apply to one selected node/edge.
 *
 * Shared by SidePanel and DetailModal so the lookup — and its handling of
 * non-numeric custom metrics — can never drift between the two.
 */
import { computed, unref, type MaybeRef } from 'vue';
import { useMetricsStore } from '@/stores/metrics';
import type { Node, Edge } from '@/types/graph';
import type { MetricValue, MetricValueType } from '@/types/metrics';

export type SelectedGraphItem =
  | { type: 'node'; data: Node }
  | { type: 'edge'; data: Edge };

export interface ItemMetricEntry {
  id: string;
  name: string;
  value: MetricValue;
  valueType: MetricValueType;
}

export function useItemMetrics(item: MaybeRef<SelectedGraphItem | null | undefined>) {
  const metricsStore = useMetricsStore();

  return computed<ItemMetricEntry[]>(() => {
    const sel = unref(item);
    if (!sel) return [];
    const id = sel.type === 'node' ? sel.data.node_id : sel.data.edge_id;
    const list = sel.type === 'node' ? metricsStore.nodeMetrics : metricsStore.edgeMetrics;
    // Touch the version so a same-size recompute re-runs this computed.
    void metricsStore.metricsVersion;
    const out: ItemMetricEntry[] = [];
    for (const metric of list) {
      const value = metric.values.get(id);
      if (value !== undefined) {
        out.push({ id: metric.id, name: metric.name, value, valueType: metric.valueType });
      }
    }
    return out;
  });
}
