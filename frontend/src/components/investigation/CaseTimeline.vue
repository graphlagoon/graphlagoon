<script setup lang="ts">
/**
 * Bottom strip of the case (05 §3): Timeline (swimlanes over every dated
 * edge; the brush becomes the time-window chip), Activity (the journal with a
 * person / agent / system filter; a click goes to the item), Tasks (06 §1),
 * Suggestions (confirm in bulk per tool) and, when an analysis is active, its result.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { useCaseFilters } from '@/stores/caseFilters';
import { useCaseAnalyses } from '@/composables/useCaseAnalyses';
import { useToast } from '@/composables/useToast';
import { describeEvent } from '@/utils/investigationEvents';
import { getErrorMessage } from '@/utils/errorMessage';
import { formatDate } from '@/utils/format';
import { annotationKindLabel, itemKindLabel } from '@/utils/investigationStatus';
import type { TraceFlow } from '@/utils/traceView';
import SwimlaneTimeline from '@/components/investigation/SwimlaneTimeline.vue';
import AnalysisResultPanel from '@/components/investigation/AnalysisResultPanel.vue';
import CaseTasksPanel from '@/components/investigation/CaseTasksPanel.vue';
import type { TraceView } from '@/components/investigation/TraceResultPanel.vue';
import type { CaseItem, InvestigationEvent } from '@/types/investigation';

export type TimelineTab = 'timeline' | 'activity' | 'tasks' | 'suggestions' | 'result';

const props = defineProps<{ tab: TimelineTab; activeItem: CaseItem | null; canEdit: boolean; traceView: TraceView; collapsed: boolean }>();
const emit = defineEmits<{
  'update:tab': [tab: TimelineTab];
  'update:collapsed': [on: boolean];
  'select-item': [item: CaseItem];
  'close-analysis': [];
  rerun: [tool: string];
  'update:traceView': [view: TraceView];
}>();

const store = useInvestigationStore();
const filters = useCaseFilters();
const { nameOf } = useCaseAnalyses();
const toast = useToast();

const flows = computed<TraceFlow[]>(() =>
  store.unified.edges
    .filter((e) => e.__t !== undefined)
    .map((e) => ({ id: e.edge_id, src: e.src, dst: e.dst, value: e.__amount ?? 1, t: e.__t! }))
    .sort((a, b) => a.t - b.t),
);

// --- activity --------------------------------------------------------------------
type Actor = 'all' | 'human' | 'agent' | 'system';
const actor = ref<Actor>('all');
const SYSTEM = /^(analysis|trace|path|nodes|view)\./;
const kindOf = (e: InvestigationEvent): Exclude<Actor, 'all'> => (e.actor_kind === 'agent' ? 'agent' : SYSTEM.test(e.kind) ? 'system' : 'human');
/** Event family = the part before the dot (`case`, `item`, `role`, `decision`…). */
const familyOf = (e: InvestigationEvent) => e.kind.split('.')[0];
const FAMILY_LABELS: Record<string, string> = { case: 'case', item: 'item', decision: 'decision', trace: 'trace', path: 'paths', nodes: 'nodes', metric: 'metric', view: 'view', analysis: 'analysis' };
const familyLabel = (f: string) => FAMILY_LABELS[f] ?? annotationKindLabel(f);
const kindFilter = ref('');
const families = computed(() => [...new Set(store.events.map(familyOf))].sort((a, b) => familyLabel(a).localeCompare(familyLabel(b))));

// "Since my last visit": the previous visit's time, kept per case in localStorage.
const VISIT_KEY = (id: string) => `gl:case:${id}:lastVisit`;
const lastVisit = ref<string | null>(null);
const sinceVisit = ref(false);
onMounted(() => {
  const id = store.current?.id;
  if (!id) return;
  try {
    lastVisit.value = localStorage.getItem(VISIT_KEY(id));
    localStorage.setItem(VISIT_KEY(id), new Date().toISOString());
  } catch {
    lastVisit.value = null;
  }
});
const isNew = (e: InvestigationEvent) => lastVisit.value !== null && e.at > lastVisit.value;
const newCount = computed(() => store.events.filter(isNew).length);

const journal = computed(() =>
  [...store.events]
    .reverse()
    .filter((e) => actor.value === 'all' || kindOf(e) === actor.value)
    .filter((e) => !kindFilter.value || familyOf(e) === kindFilter.value)
    .filter((e) => !sinceVisit.value || isNew(e)),
);
/** The row after which the "last visit" divider goes: the oldest new event (the list is newest first). */
const dividerAfter = computed(() => {
  const list = journal.value;
  const i = list.findIndex((e) => !isNew(e));
  return lastVisit.value !== null && i > 0 ? list[i - 1].id : null;
});
const itemOf = (e: InvestigationEvent) => {
  const id = (e.payload as Record<string, unknown>).item_id;
  return id ? store.items.find((i) => i.id === id) ?? null : null;
};

// --- suggestions -------------------------------------------------------------------
const bySource = computed(() => {
  const groups = new Map<string, { label: string; annotations: string[]; items: string[] }>();
  for (const s of store.suggestions) {
    if (s.kind === 'annotation' && s.annotation.kind === 'decision_proposal') continue; // reviewed in the decision panel
    const key = s.kind === 'annotation' ? `${s.annotation.kind}:${s.annotation.value?.tool ?? s.annotation.author_kind}` : `${s.item.provenance?.tool ?? s.item.subkind}:${s.item.author_kind}`;
    const label = s.kind === 'annotation' ? `${annotationKindLabel(s.annotation.kind)} · ${s.annotation.author_kind === 'agent' ? 'agent' : s.annotation.author_email}` : `${itemKindLabel(s.item.kind)}/${s.item.subkind} · ${s.item.author_kind === 'agent' ? 'agent' : s.item.author_email}`;
    const g = groups.get(key) ?? { label, annotations: [], items: [] };
    if (s.kind === 'annotation') g.annotations.push(s.annotation.id);
    else g.items.push(s.item.id);
    groups.set(key, g);
  }
  return [...groups.entries()];
});
const busy = ref(false);
async function decideAll(g: { annotations: string[]; items: string[] }, status: 'confirmed' | 'rejected') {
  busy.value = true;
  try {
    for (const id of g.annotations) await store.setAnnotationStatus(id, status);
    for (const id of g.items) await store.setItemStatus(id, status);
    toast.success(`${g.annotations.length + g.items.length} ${status === 'confirmed' ? 'confirmed' : 'rejected'}`);
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to update the suggestions'));
  } finally {
    busy.value = false;
  }
}

watch(
  () => props.activeItem?.id,
  (id) => {
    if (id) emit('update:tab', 'result');
    else if (props.tab === 'result') emit('update:tab', 'timeline');
  },
);

const tabs = computed<{ id: TimelineTab; label: string }[]>(() => [
  { id: 'timeline', label: `Timeline${flows.value.length ? ` · ${flows.value.length}` : ''}` },
  { id: 'activity', label: `Activity · ${store.events.length}` },
  { id: 'tasks', label: `Tasks · ${store.tasks.filter((t) => t.value.state === 'open').length}` },
  { id: 'suggestions', label: `● ${store.suggestions.length} suggestion${store.suggestions.length === 1 ? '' : 's'}` },
  ...(props.activeItem ? [{ id: 'result' as const, label: `Result · ${props.activeItem.title}` }] : []),
]);
</script>

<template>
  <section class="strip" :class="{ collapsed }" data-testid="case-timeline">
    <nav class="tabs">
      <button v-for="t in tabs" :key="t.id" :class="{ active: tab === t.id && !collapsed }" :data-testid="`timeline-tab-${t.id}`" @click="emit('update:tab', t.id); emit('update:collapsed', false)">{{ t.label }}</button>
      <button class="collapse" :title="collapsed ? 'Expand' : 'Collapse'" data-testid="timeline-collapse" @click="emit('update:collapsed', !collapsed)">{{ collapsed ? '▴' : '▾' }}</button>
    </nav>
    <div v-if="!collapsed" class="body">
      <template v-if="tab === 'timeline'">
        <SwimlaneTimeline v-if="flows.length" :flows="flows" :name-of="nameOf" :focus="filters.window" :max-lanes="12" @update:focus="filters.window = $event" />
        <p v-else class="muted empty">No dated edge on the canvas. Set the time column of the edge types in the case preferences (⚙).</p>
      </template>

      <div v-else-if="tab === 'activity'" class="journal" data-testid="journal">
        <div class="filter">
          <button v-for="a in (['all', 'human', 'agent', 'system'] as Actor[])" :key="a" :class="{ on: actor === a }" :data-testid="`activity-${a}`" @click="actor = a">
            {{ a === 'all' ? 'All' : a === 'human' ? 'Person' : a === 'agent' ? 'Agent' : 'System' }}
          </button>
          <select v-model="kindFilter" class="kind" aria-label="Event kind" data-testid="activity-kind">
            <option value="">All kinds</option>
            <option v-for="f in families" :key="f" :value="f">{{ familyLabel(f) }}</option>
          </select>
          <button v-if="lastVisit" :class="{ on: sinceVisit }" data-testid="activity-since-visit" @click="sinceVisit = !sinceVisit">
            Since my last visit · {{ newCount }}
          </button>
        </div>
        <template v-for="e in journal" :key="e.id">
          <div class="journal-row" :class="{ clickable: itemOf(e), new: isNew(e) }" data-testid="journal-event" @click="itemOf(e) && emit('select-item', itemOf(e)!)">
            <span class="muted">{{ formatDate(e.at) }}</span>
            <strong v-if="e.actor_kind === 'agent'" class="agent" data-testid="journal-agent">agent {{ e.agent_name }} for {{ e.actor_email }}</strong>
            <strong v-else>{{ e.actor_email }}</strong>
            <span>{{ describeEvent(e, nameOf) }}</span>
          </div>
          <div v-if="dividerAfter === e.id" class="divider muted" data-testid="journal-last-visit">— your last visit · {{ formatDate(lastVisit) }} —</div>
        </template>
        <p v-if="!journal.length" class="muted">{{ sinceVisit ? 'Nothing new since your last visit.' : 'Nothing recorded yet.' }}</p>
      </div>

      <CaseTasksPanel v-else-if="tab === 'tasks'" />

      <div v-else-if="tab === 'suggestions'" class="suggestions" data-testid="suggestions-panel">
        <div v-for="[key, g] in bySource" :key="key" class="sugg-group" :data-testid="`suggestion-group-${key}`">
          <strong>{{ g.label }}</strong> <span class="muted">{{ g.annotations.length + g.items.length }}</span>
          <span v-if="canEdit" class="row">
            <button class="link-btn ok" :disabled="busy" :data-testid="`suggestions-confirm-${key}`" @click="decideAll(g, 'confirmed')">✓ Confirm all</button>
            <button class="link-btn danger" :disabled="busy" @click="decideAll(g, 'rejected')">✕ Reject all</button>
          </span>
        </div>
        <p v-if="!bySource.length" class="muted">No suggestions to review.</p>
      </div>

      <AnalysisResultPanel
        v-else-if="tab === 'result' && activeItem"
        :item="activeItem"
        :can-edit="canEdit"
        :trace-view="traceView"
        :focus="filters.window"
        @close="emit('close-analysis')"
        @rerun="emit('rerun', $event)"
        @update:trace-view="emit('update:traceView', $event)"
      />
    </div>
  </section>
</template>

<style scoped>
.strip {
  display: flex;
  flex-direction: column;
  max-height: 300px;
  border-top: 1px solid var(--border-color);
  background: var(--color-surface);
  font-size: 13px;
}

.strip.collapsed {
  max-height: none;
}

.tabs {
  display: flex;
  gap: 4px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border-color);
}

.tabs button {
  padding: 6px 10px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-color);
}

.tabs button.active {
  font-weight: 600;
  border-bottom-color: var(--color-primary);
}

.collapse {
  margin-left: auto;
}

.body {
  min-height: 0;
  overflow-y: auto;
}

.muted {
  color: var(--text-muted);
  font-size: 12px;
}

.empty {
  padding: 12px;
}

.journal {
  padding: 6px 12px;
}

.filter {
  display: flex;
  gap: 4px;
  margin-bottom: 4px;
}

.filter button {
  padding: 2px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  background: none;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.filter button.on {
  border-color: var(--color-primary);
  color: var(--color-primary);
  font-weight: 600;
}

.filter .kind {
  padding: 2px 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  background: none;
  font: inherit;
  font-size: 12px;
}

.journal-row.new {
  box-shadow: inset 3px 0 0 var(--color-primary-accent);
  padding-left: 6px;
}

.journal-row .agent {
  color: var(--color-agent);
}

.divider {
  padding: 2px 0;
  text-align: center;
  border-top: 1px dashed var(--border-color);
}

.journal-row {
  display: flex;
  gap: 10px;
  padding: 3px 0;
}

.journal-row.clickable {
  cursor: pointer;
}

.journal-row.clickable:hover {
  background: var(--color-bg-subtle);
}

.suggestions {
  padding: 8px 12px;
}

.sugg-group {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}

.sugg-group .row {
  display: flex;
  gap: 10px;
  margin-left: auto;
}

.link-btn {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--color-primary);
  cursor: pointer;
}

.link-btn.ok {
  color: #15803d;
}

.link-btn.danger {
  color: var(--color-error);
}
</style>
