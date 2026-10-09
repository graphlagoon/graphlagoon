<script setup lang="ts">
/** Left column of the workspace (T2): the case's explorations and the unification summary. */
import { computed } from 'vue';
import { Lock } from 'lucide-vue-next';
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
}>();

const emit = defineEmits<{ select: [tab: string] }>();

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
    <h4 class="heading">Explorations</h4>
    <p v-if="sources.length === 0" class="muted">No sources yet.</p>
    <template v-for="s in sources" :key="s.id">
      <button
        v-if="s.accessible"
        class="source-card"
        :class="{ active: activeTab === s.id }"
        :data-testid="`sources-panel-${s.id}`"
        @click="emit('select', s.id)"
      >
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
      <div v-else class="source-card restricted" :data-testid="`sources-panel-${s.id}`">
        <Lock :size="14" class="lock" />
        <span class="body">
          <span class="title">{{ s.context_title ?? s.title_snapshot }}</span>
          <span class="sub">
            You don't have access to this context. Ask the owner:
            <a :href="`mailto:${s.owner_email}`">{{ s.owner_email }}</a>
          </span>
        </span>
      </div>
    </template>

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

.source-card {
  display: flex;
  gap: 8px;
  width: 100%;
  margin-bottom: 8px;
  padding: 10px;
  text-align: left;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--color-bg-subtle);
  cursor: pointer;
  font: inherit;
}

.source-card.active {
  border-color: var(--color-primary);
}

.source-card.restricted {
  border: 1px dashed var(--border-color);
  background: transparent;
  cursor: default;
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
