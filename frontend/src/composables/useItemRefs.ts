/** Which values of the details name a loaded node or edge (utils/itemReference.ts). */
import { computed } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { itemRefOf, type ItemRef } from '@/utils/itemReference';

export function useItemRefs() {
  const graphStore = useGraphStore();
  const ids = computed(() => ({
    nodes: new Set(graphStore.nodes.map((n) => n.node_id)),
    edges: new Set(graphStore.edges.map((e) => e.edge_id)),
  }));
  return {
    refOf: (column: string, value: unknown): ItemRef | null => itemRefOf(column, value, ids.value),
  };
}
