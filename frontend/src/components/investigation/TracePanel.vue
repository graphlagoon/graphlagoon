<script setup lang="ts">
/** Parameters of the money trace (T5, left column): seed, direction, Δ, layers, window, rule, stops. */
import { computed, ref } from 'vue';
import { ALLOCATIONS, useTraceStore } from '@/stores/trace';
import { useInvestigationStore } from '@/stores/investigation';
import { useToast } from '@/composables/useToast';
import { formatAmount } from '@/utils/edgeSemantics';
import { getErrorMessage } from '@/utils/errorMessage';
import { formatTraceTime, methodStamp } from '@/utils/traceView';

const trace = useTraceStore();
const investigation = useInvestigationStore();
const toast = useToast();
const saving = ref(false);
const canSave = computed(
  () => !!trace.result && !!investigation.current?.has_write_access && investigation.current.status !== 'decidido',
);

/** Freezes the run (F4.1): the whole result as the snapshot, its method stamp as the params. */
async function saveEvidence() {
  const r = trace.result;
  if (!r) return;
  saving.value = true;
  try {
    const label = ALLOCATIONS[r.method.direction].find((a) => a.id === r.method.allocation)?.label ?? r.method.allocation;
    const row = await investigation.pinEvidence({
      title: `Trace ${label}, ${r.method.maxHops} layers · ${trace.seedLabel}`,
      kind: 'trace',
      params: { ...r.method, engine: 'browser' },
      snapshot: { ...r, stamp: methodStamp(r.method) },
    });
    if (row) toast.success(`Evidence saved · hash ${row.sha256.slice(0, 8)}`);
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to save evidence'));
  } finally {
    saving.value = false;
  }
}

const seedEdges = computed(() => trace.edges.filter((e) => trace.seedEdgeIds.includes(e.id)));
const seedTotal = computed(() => seedEdges.value.reduce((s, e) => s + e.amount, 0));
const seedTime = computed(() => (seedEdges.value.length ? formatTraceTime(Math.min(...seedEdges.value.map((e) => e.t))) : ''));

/** epoch ms <-> `<input type="datetime-local">` (local time). */
function toLocalInput(t: number): string {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function setWindow(i: 0 | 1, value: string) {
  const t = Date.parse(value);
  if (Number.isNaN(t) || !trace.timeWindow) return;
  const next: [number, number] = [...trace.timeWindow];
  next[i] = t;
  trace.timeWindow = next;
}

function toggleStop(type: string, on: boolean) {
  trace.stopTypes = on ? [...trace.stopTypes, type] : trace.stopTypes.filter((t) => t !== type);
}
</script>

<template>
  <aside class="trace-panel" data-testid="trace-panel">
    <h2>Follow the money</h2>

    <div class="seed" data-testid="trace-seed">
      <strong>Seed</strong>
      <div>{{ trace.seedLabel }} · {{ formatAmount(seedTotal) }}</div>
      <div>{{ seedTime }} · {{ trace.seedEdgeIds.length }} {{ trace.seedEdgeIds.length === 1 ? 'edge' : 'edges' }}</div>
    </div>

    <div class="field">
      <span class="label">Direction</span>
      <div class="segmented">
        <button
          :class="{ on: trace.direction === 'forward' }"
          data-testid="trace-forward"
          @click="trace.setDirection('forward')"
        >
          Forward
        </button>
        <button
          :class="{ on: trace.direction === 'backward' }"
          data-testid="trace-backward"
          @click="trace.setDirection('backward')"
        >
          Backward
        </button>
      </div>
    </div>

    <div class="grid2">
      <label class="field">
        <span class="label">Max layers</span>
        <input v-model.number="trace.maxHops" type="number" min="1" max="20" data-testid="trace-max-hops" />
      </label>
      <label class="field">
        <span class="label">Max dwell (h)</span>
        <input v-model.number="trace.dwellHours" type="number" min="0" step="0.5" placeholder="no limit" data-testid="trace-dwell" />
      </label>
      <label class="field">
        <span class="label">Min amount</span>
        <input v-model.number="trace.minAmount" type="number" min="0" data-testid="trace-min-amount" />
      </label>
    </div>

    <div v-if="trace.timeWindow" class="field">
      <span class="label">Window</span>
      <input
        type="datetime-local"
        :value="toLocalInput(trace.timeWindow[0])"
        aria-label="Window start"
        @change="setWindow(0, ($event.target as HTMLInputElement).value)"
      />
      <input
        type="datetime-local"
        :value="toLocalInput(trace.timeWindow[1])"
        aria-label="Window end"
        @change="setWindow(1, ($event.target as HTMLInputElement).value)"
      />
    </div>

    <fieldset class="field">
      <legend class="label">Allocation rule</legend>
      <label v-for="a in ALLOCATIONS[trace.direction]" :key="a.id" class="option">
        <input v-model="trace.allocation" type="radio" name="trace-allocation" :value="a.id" :data-testid="`trace-rule-${a.id}`" />
        <span><strong>{{ a.label }}</strong> · {{ a.hint }}</span>
      </label>
    </fieldset>

    <fieldset class="field">
      <legend class="label">Stop at</legend>
      <label v-for="t in trace.allNodeTypes" :key="t" class="option">
        <input
          type="checkbox"
          :checked="trace.stopTypes.includes(t)"
          :data-testid="`trace-stop-${t}`"
          @change="toggleStop(t, ($event.target as HTMLInputElement).checked)"
        />
        <span>{{ t }}</span>
      </label>
    </fieldset>

    <div v-if="trace.error" class="error">{{ trace.error }}</div>
    <div class="actions">
      <button class="btn btn-primary" :disabled="trace.running" data-testid="trace-run" @click="trace.run()">
        {{ trace.running ? 'Tracing…' : 'Trace again' }}
      </button>
      <button
        class="btn btn-outline"
        :disabled="!canSave || saving || trace.running"
        title="Freeze this run with its method stamp (immutable, with a sha256)"
        data-testid="trace-save-evidence"
        @click="saveEvidence"
      >
        {{ saving ? 'Saving…' : 'Save as evidence' }}
      </button>
    </div>
  </aside>
</template>

<style scoped>
.trace-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  overflow-y: auto;
  border-right: 1px solid var(--border-color);
  background: var(--color-surface);
  font-size: 13px;
}

h2 {
  margin: 0;
  font-size: 16px;
}

.seed {
  padding: 10px;
  border-radius: var(--radius-md);
  background: #eff6ff;
  color: #1e3a8a;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.label {
  padding: 0;
  font-weight: 600;
}

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

input[type='number'],
input[type='datetime-local'] {
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  font: inherit;
}

.segmented {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: var(--radius-md);
  background: var(--color-bg-muted);
}

.segmented button {
  flex: 1;
  padding: 5px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  font: inherit;
  cursor: pointer;
}

.segmented button.on {
  background: var(--color-surface);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.option {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.option input {
  margin-top: 3px;
}

.error {
  color: var(--color-error);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
