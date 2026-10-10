<script setup lang="ts">
/**
 * Decision from the case screen (F1): outcome, actions and rationale, recorded
 * by a person. The server freezes the case (F4.5); the dossier shows the result.
 */
import { ref } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { getErrorMessage } from '@/utils/errorMessage';
import { DECISION_ACTION_LABELS, DECISION_OUTCOME_LABELS } from '@/utils/investigationStatus';
import type { DecisionAction, DecisionOutcome } from '@/types/investigation';

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; decided: [] }>();

const store = useInvestigationStore();
const outcome = ref<DecisionOutcome>('comunicar');
const actions = ref<DecisionAction[]>([]);
const rationale = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

async function record() {
  if (!rationale.value.trim() || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await store.recordDecision({ outcome: outcome.value, actions: actions.value, rationale: rationale.value.trim() });
    emit('decided');
    emit('close');
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to record the decision');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="modal-overlay" @click.self="emit('close')">
    <div class="modal decide-dialog" data-testid="decide-dialog">
      <div class="modal-header">
        <h2>Record the decision</h2>
        <button class="modal-close" aria-label="Close" @click="emit('close')">&times;</button>
      </div>
      <form class="decide" @submit.prevent="record">
        <fieldset>
          <legend>Outcome</legend>
          <label v-for="(text, o) in DECISION_OUTCOME_LABELS" :key="o">
            <input v-model="outcome" type="radio" :value="o" :data-testid="`decision-outcome-${o}`" /> {{ text }}
          </label>
        </fieldset>
        <fieldset>
          <legend>Actions with it</legend>
          <label v-for="(text, a) in DECISION_ACTION_LABELS" :key="a">
            <input v-model="actions" type="checkbox" :value="a" :data-testid="`decision-action-${a}`" /> {{ text }}
          </label>
        </fieldset>
        <label class="field">
          <span>Rationale</span>
          <textarea
            v-model="rationale"
            rows="5"
            class="form-control"
            data-testid="decision-rationale"
            placeholder="Why, citing the evidence (E1, E2, …)"
          ></textarea>
        </label>
        <p class="hint">
          Recording freezes the live sources, hashes the case and makes it read-only. The account holder is never told
          (tipping-off prohibition). A person can reopen it later; the decision stays in the journal.
        </p>
        <p v-if="error" class="error-message">{{ error }}</p>
        <div class="modal-footer">
          <button type="button" class="btn btn-outline" @click="emit('close')">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="busy || !rationale.trim()" data-testid="decision-record">
            Record decision
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.decide-dialog {
  max-width: 560px;
}

.decide {
  padding: 0 16px;
}

.decide fieldset {
  margin: 0 0 12px;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.decide legend {
  padding: 0 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

.decide .modal-footer {
  margin: 12px -16px 0;
}
</style>
