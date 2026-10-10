<script setup lang="ts">
/**
 * Typology badges (T9, F4.3): renders a typologies analysis item (CC 4.001
 * patterns found in the unified graph). A badge only suggests; clicking it
 * highlights the entities, accepting it writes a confirmed `typology` annotation
 * (05 §7) that reaches the dossier. Parameters live in the Tipologias popover.
 */
import { computed, ref } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { useGraphStore } from '@/stores/graph';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import type { TypologyResult } from '@/utils/typologies';

const props = defineProps<{ results: TypologyResult[]; canEdit: boolean }>();

const store = useInvestigationStore();
const graphStore = useGraphStore();
const toast = useToast();
const active = ref<string | null>(null);
const saving = ref<string | null>(null);

const found = computed(() => props.results.filter((r) => r.hits.length));
const accepted = computed(
  () => new Set(store.annotations.filter((a) => a.kind === 'typology' && a.status === 'confirmed').map((a) => String(a.value.typology))),
);

function entitiesOf(r: TypologyResult): string[] {
  const ends = new Map(store.unified.edges.map((e) => [e.edge_id, [e.src, e.dst]]));
  const ids = new Set(r.hits.map((h) => h.nodeId));
  for (const h of r.hits) for (const id of h.evidenceEdgeIds) for (const n of ends.get(id) ?? []) ids.add(n);
  return [...ids];
}

function highlight(r: TypologyResult) {
  if (active.value === r.id) {
    active.value = null;
    graphStore.clearSelection();
    return;
  }
  active.value = r.id;
  graphStore.selectedNodeIds = new Set(entitiesOf(r));
  graphStore.selectedEdgeIds = new Set(r.hits.flatMap((h) => h.evidenceEdgeIds));
}

async function accept(r: TypologyResult) {
  if (!store.current || saving.value) return;
  saving.value = r.id;
  try {
    await store.addAnnotation({
      kind: 'typology',
      targets: r.hits.map((h) => h.nodeId),
      value: { typology: r.id, norm_ref: r.normRef, label: r.label, params: r.params, hits: r.hits.length },
    });
    toast.success(`${r.normRef} accepted`);
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to accept the badge'));
  } finally {
    saving.value = null;
  }
}

/** Bipartite preset: hive with the most common node type on one axis, the rest on the other. */
function bipartite() {
  graphStore.updateLayoutModeConfig({ hive: { axisKey: 'node_type', maxAxes: 1 } });
  graphStore.setLayoutAlgorithm('hive');
}
</script>

<template>
  <div class="typology-panel" data-testid="typology-panel">
    <p class="muted">Click a badge to highlight its entities in the graph. Badges suggest; the analyst decides.</p>
    <div class="badges">
      <div
        v-for="r in found"
        :key="r.id"
        class="badge"
        :class="{ active: active === r.id }"
        :data-testid="`typology-${r.id}`"
        role="button"
        tabindex="0"
        @click="highlight(r)"
        @keydown.enter="highlight(r)"
      >
        <strong class="ref">{{ r.normRef }}</strong>
        <span>{{ r.label }}</span>
        <span class="count">{{ r.hits.length }} {{ r.hits.length === 1 ? 'entity' : 'entities' }}</span>
        <span class="muted why" :title="r.hits.map((h) => `${h.nodeId}: ${h.explanation}`).join('\n')">
          {{ r.hits[0].explanation }}
        </span>
        <span v-if="accepted.has(r.id)" class="accepted" data-testid="typology-accepted">accepted</span>
        <button
          v-else-if="canEdit"
          class="btn btn-outline btn-sm"
          :disabled="saving === r.id"
          :data-testid="`typology-accept-${r.id}`"
          @click.stop="accept(r)"
        >
          Accept
        </button>
      </div>
    </div>
    <p v-if="!found.length" class="muted" data-testid="typology-none">No typology matches this graph with these parameters.</p>
    <button class="btn btn-outline btn-sm layout" data-testid="typology-bipartite" @click="bipartite">Bipartite layout</button>
  </div>
</template>

<style scoped>
.typology-panel {
  padding: 8px 12px;
  font-size: 13px;
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.badge {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 240px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  text-align: left;
  cursor: pointer;
}

.badge.active {
  border: 2px solid #c2410c;
  background: rgba(194, 65, 12, 0.08);
}

.ref {
  font-size: 12px;
}

.count {
  font-weight: 600;
}

.badge.active .ref,
.badge.active .count {
  color: #c2410c;
}

.why {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.accepted {
  align-self: flex-start;
  padding: 1px 8px;
  border-radius: 999px;
  background: #ccfbf1;
  color: #115e59;
  font-size: 11px;
}

.badge .btn {
  align-self: flex-start;
}

.layout {
  margin-top: 8px;
}
</style>
