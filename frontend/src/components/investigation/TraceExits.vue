<script setup lang="ts">
/** Outputs of the money trace (T5, right column): exits with their value per rule, retained balances, method stamp. */
import { computed } from 'vue';
import { useTraceStore } from '@/stores/trace';
import { formatAmount } from '@/utils/edgeSemantics';
import { formatTraceTime, methodStamp, traceFlows } from '@/utils/traceView';

const trace = useTraceStore();

const exits = computed(() => {
  const r = trace.result;
  if (!r) return [];
  const flows = traceFlows(r, trace.walked);
  return Object.entries(r.exits)
    .sort((a, b) => b[1] - a[1])
    .map(([id, amount]) => {
      const into = flows.filter((f) => f.dst === id);
      const alt = trace.proportional?.exits[id] ?? null;
      return {
        id,
        amount,
        via: [...new Set(into.map((f) => trace.nameOf(f.src)))].join(', '),
        at: into.length ? formatTraceTime(into[into.length - 1].t) : '',
        proportional: alt !== null && Math.abs(alt - amount) >= 0.01 ? alt : null,
      };
    });
});

const retained = computed(() =>
  Object.entries(trace.result?.nodes ?? {})
    .filter(([, n]) => n.retained > 0)
    .map(([id, n]) => ({ id, amount: n.retained })),
);
</script>

<template>
  <aside class="trace-exits" data-testid="trace-exits">
    <h2>{{ trace.direction === 'backward' ? 'Origins' : 'Exits' }}</h2>
    <template v-if="trace.result">
      <div v-for="x in exits" :key="x.id" class="card" :data-testid="`trace-exit-${x.id}`">
        <div><strong>{{ trace.nameOf(x.id) }}</strong><span class="muted"> · via {{ x.via }}</span></div>
        <div>
          <span class="amount">{{ formatAmount(x.amount) }}</span>
          <span class="muted"> · {{ x.at }} · {{ trace.result.method.allocation.toUpperCase() }}</span>
        </div>
        <div v-if="x.proportional !== null" class="muted">proportional would give {{ formatAmount(x.proportional) }}</div>
      </div>
      <p v-if="!exits.length" class="muted">No traced value reached a stop. Add layers or stop types and trace again.</p>

      <div v-if="retained.length" class="retained" data-testid="trace-retained">
        <strong>Retained</strong> <span class="muted">(candidates for a precautionary block)</span>
        <div v-for="r in retained" :key="r.id">{{ trace.nameOf(r.id) }} · {{ formatAmount(r.amount) }}</div>
      </div>

      <pre class="stamp" data-testid="trace-method">{{ methodStamp(trace.result.method) }}</pre>
    </template>
    <p v-else-if="trace.running" class="muted">Tracing…</p>
  </aside>
</template>

<style scoped>
.trace-exits {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  overflow-y: auto;
  border-left: 1px solid var(--border-color);
  background: var(--color-surface);
  font-size: 13px;
}

h2 {
  margin: 0;
  font-size: 16px;
}

.card {
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
}

.amount {
  font-size: 18px;
  font-weight: 700;
}

.muted {
  color: var(--text-muted);
}

.retained {
  padding-top: 10px;
  border-top: 1px solid var(--border-color);
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
