/**
 * Filter chips of the case canvas (05 §3): source, role, tag, group, time window
 * and the audited 👁 toggle. Visual only: the hidden set goes to
 * `graphStore.caseHiddenNodeIds`, so the layout never resets. Node types reuse
 * the graph store's own filter (`filters.node_types`, the FilterPanel logic).
 */
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useInvestigationStore } from '@/stores/investigation';
import { nodeSourceIds } from '@/utils/unifyGraph';
import type { CaseViewContent } from '@/types/investigation';

export type ChipField = 'sources' | 'roles' | 'tags' | 'groups';

export const useCaseFilters = defineStore('caseFilters', () => {
  const graph = useGraphStore();
  const inv = useInvestigationStore();

  const sources = ref<string[]>([]);
  const roles = ref<string[]>([]);
  const tags = ref<string[]>([]);
  const groups = ref<string[]>([]);
  const window = ref<[number, number] | null>(null);

  const lists = { sources, roles, tags, groups };

  const types = computed(() => graph.filters.node_types);
  const activeCount = computed(
    () => sources.value.length + roles.value.length + tags.value.length + groups.value.length + types.value.length + (window.value ? 1 : 0),
  );

  /** Nodes failing any active chip. A node with no dated edge is not touched by the window. */
  const hidden = computed<Set<string>>(() => {
    const out = new Set<string>();
    if (!sources.value.length && !roles.value.length && !tags.value.length && !groups.value.length && !window.value) return out;
    const groupMembers = new Set(inv.groups.filter((g) => groups.value.includes(g.id)).flatMap((g) => g.targets));
    const times = new Map<string, number[]>();
    if (window.value) {
      for (const e of inv.unified.edges) {
        if (e.__t === undefined) continue;
        for (const id of [e.src, e.dst]) times.set(id, [...(times.get(id) ?? []), e.__t]);
      }
    }
    for (const n of inv.unified.nodes) {
      const id = n.node_id;
      if (sources.value.length && !nodeSourceIds(n).some((s) => sources.value.includes(s))) out.add(id);
      else if (roles.value.length && !roles.value.includes(inv.roles[id])) out.add(id);
      else if (tags.value.length && !(inv.entityTags.get(id) ?? []).some((t) => tags.value.includes(t))) out.add(id);
      else if (groups.value.length && !groupMembers.has(id)) out.add(id);
      else if (window.value) {
        const w = window.value;
        const ts = times.get(id);
        if (ts && !ts.some((t) => t >= w[0] && t <= w[1])) out.add(id);
      }
    }
    return out;
  });

  watch(hidden, (h) => (graph.caseHiddenNodeIds = h.size ? h : null), { immediate: true });

  function toggle(field: ChipField, value: string) {
    const list = lists[field];
    list.value = list.value.includes(value) ? list.value.filter((v) => v !== value) : [...list.value, value];
  }

  function toggleType(type: string) {
    const current = graph.filters.node_types;
    graph.applyFilters({ node_types: current.includes(type) ? current.filter((t) => t !== type) : [...current, type] });
  }

  function clear() {
    sources.value = [];
    roles.value = [];
    tags.value = [];
    groups.value = [];
    window.value = null;
    graph.applyFilters({ node_types: [] });
  }

  /** Chips of a saved view (05 §5). */
  function snapshot(): CaseViewContent['filters'] {
    return { sources: [...sources.value], roles: [...roles.value], tags: [...tags.value], groups: [...groups.value], types: [...types.value], window: window.value };
  }

  function restore(f: Partial<CaseViewContent['filters']> | null | undefined) {
    sources.value = f?.sources ?? [];
    roles.value = f?.roles ?? [];
    tags.value = f?.tags ?? [];
    groups.value = f?.groups ?? [];
    window.value = f?.window ?? null;
    graph.applyFilters({ node_types: f?.types ?? [] });
  }

  return { sources, roles, tags, groups, window, types, activeCount, hidden, toggle, toggleType, clear, snapshot, restore };
});
