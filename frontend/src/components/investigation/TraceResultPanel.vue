<script setup lang="ts">
/**
 * Renders a money-trace item (T5, F4): seed, coverage and retained chips, the
 * exits with their value per rule, the method stamp, and the Layers | Sankey |
 * Graph view switch (layers re-lay the canvas by trace layer). Parameters live in
 * the "Seguir o dinheiro" popover; "Fixar" pins the item's version as evidence.
 */
import { computed } from 'vue';
import { formatAmount } from '@/utils/edgeSemantics';
import { formatTraceTime, traceColumns, traceFlows } from '@/utils/traceView';
import TraceSankey from '@/components/investigation/TraceSankey.vue';
import type { TraceContent } from '@/composables/useCaseAnalyses';

export type TraceView = 'layers' | 'sankey' | 'graph';

const props = defineProps<{
  content: TraceContent;
  nameOf: (id: string) => string;
  view: TraceView;
  focus: [number, number] | null;
  canEdit: boolean;
  pinned: boolean;
}>();
const emit = defineEmits<{ 'update:view': [view: TraceView]; pin: []; rerun: [] }>();

const result = computed(() => props.content.result);
const allFlows = computed(() => traceFlows(result.value, props.content.walked));
const flows = computed(() => {
  const f = props.focus;
  return f ? allFlows.value.filter((x) => x.t >= f[0] && x.t <= f[1]) : allFlows.value;
});
const columns = computed(() => traceColumns(result.value, flows.value, result.value.method.direction));
const backward = computed(() => result.value.method.direction === 'backward');

const chips = computed(() => {
  const r = result.value;
  const retained = Object.values(r.nodes).filter((n) => n.retained > 0);
  const frontier = r.frontier.reduce((s, f) => s + f.amount, 0);
  return {
    seed: formatAmount(r.seedTotal),
    exits: `${formatAmount(r.exitTotal)} reached ${backward.value ? 'origins' : 'exits'} (${Math.round(r.coverage * 100)}%)`,
    retained: `${formatAmount(retained.reduce((s, n) => s + n.retained, 0))} retained in ${retained.length} ${retained.length === 1 ? 'account' : 'accounts'}`,
    frontier: frontier > 0 ? `${formatAmount(frontier)} at the layer limit` : null,
    layers: columns.value.labels.length - (columns.value.exits ? 2 : 1),
  };
});

const exits = computed(() =>
  Object.entries(result.value.exits)
    .sort((a, b) => b[1] - a[1])
    .map(([id, amount]) => {
      const into = allFlows.value.filter((f) => f.dst === id);
      const alt = props.content.proportionalExits?.[id] ?? null;
      return {
        id,
        amount,
        via: [...new Set(into.map((f) => props.nameOf(f.src)))].join(', '),
        at: into.length ? formatTraceTime(into[into.length - 1].t) : '',
        proportional: alt !== null && Math.abs(alt - amount) >= 0.01 ? alt : null,
      };
    }),
);

const retained = computed(() =>
  Object.entries(result.value.nodes)
    .filter(([, n]) => n.retained > 0)
    .map(([id, n]) => ({ id, amount: n.retained })),
);

defineExpose({ columns, flows, allFlows });
</script>

<template>
  <div class="trace-result" data-testid="trace-result">
    <div class="trace-bar" data-testid="trace-bar">
      <div class="trace-toggle">
        <button :class="{ on: view === 'layers' }" data-testid="trace-view-layers" @click="emit('update:view', 'layers')">Layers</button>
        <button :class="{ on: view === 'sankey' }" data-testid="trace-view-sankey" @click="emit('update:view', 'sankey')">Sankey</button>
        <button :class="{ on: view === 'graph' }" data-testid="trace-view-graph" @click="emit('update:view', 'graph')">Whole graph</button>
      </div>
      <span class="chip-fill seed" data-testid="trace-seed">{{ chips.seed }} seed · {{ content.seedLabel }}</span>
      <span class="chip-fill exits" data-testid="trace-coverage">{{ chips.exits }}</span>
      <span class="chip-fill retained">{{ chips.retained }}</span>
      <span v-if="chips.frontier" class="chip-fill retained">{{ chips.frontier }}</span>
      <span class="muted">{{ chips.layers }} {{ chips.layers === 1 ? 'layer' : 'layers' }} to the {{ backward ? 'origins' : 'exits' }}</span>
      <span class="actions">
        <button class="btn btn-outline btn-sm" :disabled="!canEdit" data-testid="trace-rerun" @click="emit('rerun')">Trace again…</button>
        <button
          class="btn btn-primary btn-sm"
          :disabled="!canEdit || pinned"
          title="Freeze this run with its method stamp (immutable, with a sha256)"
          data-testid="trace-save-evidence"
          @click="emit('pin')"
        >
          {{ pinned ? 'Pinned' : 'Pin as evidence' }}
        </button>
      </span>
    </div>

    <TraceSankey v-if="view === 'sankey'" :flows="flows" :columns="columns" :name-of="nameOf" :allocation="result.method.allocation" />

    <div class="cols">
      <section class="trace-exits" data-testid="trace-exits">
        <h4>{{ backward ? 'Origins' : 'Exits' }}</h4>
        <div v-for="x in exits" :key="x.id" class="card" :data-testid="`trace-exit-${x.id}`">
          <div><strong>{{ nameOf(x.id) }}</strong><span class="muted"> · via {{ x.via }}</span></div>
          <div>
            <span class="amount">{{ formatAmount(x.amount) }}</span>
            <span class="muted"> · {{ x.at }} · {{ result.method.allocation.toUpperCase() }}</span>
          </div>
          <div v-if="x.proportional !== null" class="muted">proportional would give {{ formatAmount(x.proportional) }}</div>
        </div>
        <p v-if="!exits.length" class="muted">No traced value reached a stop. Add layers or stop types and trace again.</p>
      </section>
      <section>
        <div v-if="retained.length" class="retained" data-testid="trace-retained">
          <h4>Retained <span class="muted">(candidates for a precautionary block)</span></h4>
          <div v-for="r in retained" :key="r.id">{{ nameOf(r.id) }} · {{ formatAmount(r.amount) }}</div>
        </div>
        <pre class="stamp" data-testid="trace-method">{{ content.stamp }}</pre>
      </section>
    </div>
  </div>
</template>

<style scoped>
.trace-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
}

.trace-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

.trace-toggle {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: var(--radius-md);
  background: var(--color-bg-muted);
}

.trace-toggle button {
  padding: 4px 12px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  font: inherit;
  cursor: pointer;
}

.trace-toggle button.on {
  background: var(--color-secondary);
  color: #fff;
  font-weight: 600;
}

.chip-fill {
  padding: 4px 10px;
  border-radius: var(--radius-pill);
}

.chip-fill.seed {
  background: #eff6ff;
  color: #1e3a8a;
}

.chip-fill.exits {
  background: #f0fdfa;
  color: #115e59;
  font-weight: 600;
}

.chip-fill.retained {
  background: #fff7ed;
  color: #9a3412;
}

.muted {
  color: var(--text-muted);
}

.cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

h4 {
  margin: 0 0 6px;
  font-size: 13px;
}

.trace-exits {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.card {
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
}

.amount {
  font-size: 16px;
  font-weight: 700;
}

.retained {
  margin-bottom: 8px;
}

.stamp {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: #f8f9fa;
  color: #374151;
  font-size: 11px;
  line-height: 16px;
  white-space: pre-wrap;
}
</style>
