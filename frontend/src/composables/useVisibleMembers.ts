/**
 * The members of a group a table lists: the visible ones, with a way to the
 * rest. A group that is entirely hidden lists all of them — an empty table
 * would say nothing.
 */
import { computed, ref, watch, type Ref } from 'vue';
import { useGraphStore } from '@/stores/graph';
import type { Node } from '@/types/graph';

export function useVisibleMembers(all: Ref<Node[]>, groupId: () => unknown) {
  const graphStore = useGraphStore();
  const includeHidden = ref(false);
  watch(groupId, () => { includeHidden.value = false; });

  const visible = computed(() => {
    const ids = new Set(graphStore.visibleNodes.map((n) => n.node_id));
    return all.value.filter((n) => ids.has(n.node_id));
  });
  const hiddenCount = computed(() => (visible.value.length ? all.value.length - visible.value.length : 0));
  const nodes = computed(() => (includeHidden.value || !visible.value.length ? all.value : visible.value));

  return { nodes, hiddenCount, includeHidden };
}
