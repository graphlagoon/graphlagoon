<script setup lang="ts">
/** Left column of the workspace (T2): the case's explorations, files (slot) and the unification summary. */
import { computed } from 'vue';
import { Lock, Plus, X } from 'lucide-vue-next';
import type { InvestigationSource } from '@/types/investigation';
import type { GraphContext } from '@/types/graph';
import type { SourceGraph } from '@/stores/investigation';

const props = defineProps<{
  sources: InvestigationSource[];
  graphs: SourceGraph[];
  contexts: Record<string, GraphContext>;
  colors: Record<string, string>;
  mergedCounts: Record<string, number>;
  activeTab: string;
  /** Shows "Add" and the remove buttons (write access, not decided). */
  canEdit?: boolean;
}>();

const emit = defineEmits<{ select: [tab: string]; remove: [sourceId: string]; add: [] }>();

const graphOf = computed(() => new Map(props.graphs.map((g) => [g.id, g])));
const mergedTotal = computed(() => Object.values(props.mergedCounts).reduce((a, b) => a + b, 0));
const mergedDetail = computed(() =>
  Object.entries(props.mergedCounts)
    .map(([entity, n]) => `${n} by ${entity}`)
    .join(', '),
);
</script>

<template>
  <aside class="sources-panel" data-testid="sources-panel">
    <div class="heading-row">
      <h4 class="heading">Explorations</h4>
      <button v-if="canEdit" class="add-btn" data-testid="sources-panel-add" @click="emit('add')">
        <Plus :size="12" /> Add
      </button>
    </div>
    <div v-if="sources.length === 0" class="empty" data-testid="sources-empty">
      <p class="muted">No sources yet. Add a recent exploration, or start one from a context.</p>
      <button v-if="canEdit" class="btn btn-primary btn-sm" data-testid="sources-empty-add" @click="emit('add')">
        <Plus :size="12" /> Add exploration
      </button>
    </div>
    <template v-for="s in sources" :key="s.id">
      <div v-if="s.accessible" class="source-row" :class="{ active: activeTab === s.id }">
        <button class="source-card" :data-testid="`sources-panel-${s.id}`" @click="emit('select', s.id)">
          <span class="dot" :style="{ background: colors[s.id] }"></span>
          <span class="body">
            <span class="title">{{ s.title_snapshot }}</span>
            <span class="sub">
              {{ contexts[s.context_id ?? '']?.title ?? s.context_title ?? 'context' }}
              · {{ graphOf.get(s.id)?.nodes.length ?? 0 }} nodes
              · {{ s.mode === 'frozen' ? 'frozen' : 'live' }}
            </span>
            <span v-if="graphOf.get(s.id)?.error" class="warn">{{ graphOf.get(s.id)?.error }}</span>
          </span>
        </button>
        <button
          v-if="canEdit"
          class="remove"
          :title="`Remove “${s.title_snapshot}” from the case`"
          :aria-label="`Remove ${s.title_snapshot}`"
          :data-testid="`sources-panel-remove-${s.id}`"
          @click.stop="emit('remove', s.id)"
        >
          <X :size="12" />
        </button>
      </div>
      <div v-else class="source-row restricted" :data-testid="`sources-panel-${s.id}`">
        <Lock :size="14" class="lock" />
        <span class="body">
          <span class="title">{{ s.context_title ?? s.title_snapshot }}</span>
          <span class="sub">
            You don't have access to this context. Ask the owner:
            <a :href="`mailto:${s.owner_email}`">{{ s.owner_email }}</a>
          </span>
        </span>
        <button
          v-if="canEdit"
          class="remove"
          aria-label="Remove restricted source"
          :data-testid="`sources-panel-remove-${s.id}`"
          @click.stop="emit('remove', s.id)"
        >
          <X :size="12" />
        </button>
      </div>
    </template>

    <h4 class="heading">Files</h4>
    <slot name="files" />

    <h4 class="heading">Unification</h4>
    <p class="muted" data-testid="unification-summary">
      <template v-if="mergedTotal">
        {{ mergedTotal }} {{ mergedTotal === 1 ? 'entity' : 'entities' }} merged by identity key: {{ mergedDetail }}.
      </template>
      <template v-else>No entity shared between sources yet.</template>
    </p>
  </aside>
</template>

<style scoped>
.sources-panel {
  padding: 12px;
  overflow-y: auto;
  border-right: 1px solid var(--border-color);
  background: var(--color-surface);
}

.heading {
  margin: 8px 0;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.heading-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.add-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border: none;
  background: none;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-primary);
  cursor: pointer;
}

.empty {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  margin-bottom: 8px;
  border: 1px dashed var(--border-color);
  border-radius: 6px;
}

.empty p {
  margin: 0;
}

.source-row {
  position: relative;
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--color-bg-subtle);
}

.source-row.active {
  border-color: var(--color-primary);
}

.source-row.restricted {
  padding: 10px;
  border: 1px dashed var(--border-color);
  background: transparent;
}

.source-card {
  display: flex;
  flex: 1;
  gap: 8px;
  min-width: 0;
  padding: 10px 28px 10px 10px;
  text-align: left;
  border: none;
  background: none;
  cursor: pointer;
  font: inherit;
}

.remove {
  position: absolute;
  top: 6px;
  right: 6px;
  display: inline-flex;
  padding: 3px;
  border: none;
  border-radius: 50%;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}

.remove:hover {
  background: var(--border-color);
  color: var(--text-color);
}

.dot {
  flex: none;
  width: 10px;
  height: 10px;
  margin-top: 4px;
  border-radius: 50%;
}

.lock {
  flex: none;
  margin-top: 2px;
  color: var(--text-muted);
}

.body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.title {
  font-weight: 600;
  font-size: 13px;
}

.sub,
.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.warn {
  font-size: 11px;
  color: var(--color-warning);
}
</style>
