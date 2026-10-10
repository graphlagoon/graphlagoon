<script setup lang="ts">
/**
 * Guided decision (05 §7), in the inspector or the dossier: outcome, actions, a
 * rationale pre-filled from the supported hypotheses and the pinned evidence, the
 * tipping-off warning and a reviewer. Recording freezes the case (server hash).
 */
import { computed, ref } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { getErrorMessage } from '@/utils/errorMessage';
import { DECISION_ACTION_LABELS, DECISION_OUTCOME_LABELS } from '@/utils/investigationStatus';
import type { DecisionAction, DecisionOutcome } from '@/types/investigation';

const emit = defineEmits<{ decided: []; cancel: [] }>();

const store = useInvestigationStore();
const outcome = ref<DecisionOutcome>('comunicar');
const actions = ref<DecisionAction[]>([]);
const reviewer = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

/** Pre-fill: supported hypotheses and pinned evidence, numbered as the dossier numbers them. */
const prefill = computed(() => {
  const lines: string[] = [];
  const supported = store.hypotheses.filter((h) => h.value.status === 'supported');
  if (supported.length) {
    lines.push('Hipóteses sustentadas:');
    for (const h of supported) lines.push(`- H${store.hypotheses.indexOf(h) + 1} ${h.value.text}`);
  }
  if (store.evidence.length) {
    lines.push(supported.length ? '' : '', 'Evidências fixadas:');
    store.evidence.forEach((e, i) => lines.push(`- E${i + 1} ${e.item.title} (v${e.version.version}, ${e.version.sha256.slice(0, 8)})`));
  }
  return lines.join('\n').trim();
});
const rationale = ref(prefill.value);
const RETENTION_YEARS = window.__GRAPH_LAGOON_CONFIG__?.investigation_retention_years ?? 10;

async function record() {
  if (!rationale.value.trim() || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await store.recordDecision({
      outcome: outcome.value,
      actions: actions.value,
      rationale: rationale.value.trim(),
      ...(reviewer.value.trim() ? { reviewer_email: reviewer.value.trim() } : {}),
    });
    emit('decided');
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to record the decision');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="decide" data-testid="decision-form" @submit.prevent="record">
    <fieldset>
      <legend>1 · Outcome</legend>
      <label v-for="(text, o) in DECISION_OUTCOME_LABELS" :key="o">
        <input v-model="outcome" type="radio" :value="o" :data-testid="`decision-outcome-${o}`" /> {{ text }}
      </label>
    </fieldset>
    <fieldset>
      <legend>2 · Actions with it</legend>
      <label v-for="(text, a) in DECISION_ACTION_LABELS" :key="a">
        <input v-model="actions" type="checkbox" :value="a" :data-testid="`decision-action-${a}`" /> {{ text }}
      </label>
    </fieldset>
    <label class="field">
      <span class="legend">3 · Rationale <span class="muted">pre-filled with the supported hypotheses and the pinned evidence</span></span>
      <textarea v-model="rationale" rows="7" data-testid="decision-rationale" placeholder="Why, citing the evidence (E1, E2, …)"></textarea>
    </label>
    <label class="field">
      <span class="legend">4 · Reviewer <span class="muted">optional, a second pair of eyes</span></span>
      <input v-model="reviewer" type="email" placeholder="person@company.com" data-testid="decision-reviewer" />
    </label>
    <p class="notice" data-testid="decision-tipping-off">
      <strong>Tipping-off.</strong> The account holder is never told. The case is visible only to the people it was shared with by name.
    </p>
    <p v-if="error" class="error-message">{{ error }}</p>
    <div class="actions">
      <button type="button" class="btn btn-outline btn-sm" data-testid="decision-cancel" @click="emit('cancel')">Cancel</button>
      <button type="submit" class="btn btn-primary btn-sm" :disabled="busy || !rationale.trim()" data-testid="decision-record">Record decision</button>
    </div>
    <p class="muted">Recording freezes the journal and the pinned evidence with a hash and retains everything for {{ RETENTION_YEARS }} years. A person can reopen it later; the decision stays in the journal.</p>
  </form>
</template>

<style scoped>
.decide {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13px;
}

.decide fieldset {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

legend,
.legend {
  padding: 0 4px;
  font-size: 12px;
  font-weight: 600;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field textarea,
.field input {
  font: inherit;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.muted {
  font-weight: normal;
  font-size: 12px;
  color: var(--text-muted);
}

.notice {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: #fff7ed;
  color: #9a3412;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
