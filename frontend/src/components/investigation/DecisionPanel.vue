<script setup lang="ts">
/**
 * Record a decision (06 §1), in the inspector or the dossier. The outcome comes from
 * the case type's catalog (each says whether it closes the case and needs a second
 * person) or, for a type without one, is named here with "closes the case". It may
 * be about some entities (the selection and the entities with a role), set the
 * type's actions in motion as tasks, and names a reviewer. The rationale is
 * pre-filled from the supported hypotheses and the pinned evidence, which the
 * decision rests on (the server hashes them with the record so far). When an
 * agent proposed a decision (06 P8), the panel opens with its draft: the person
 * records it (the proposal is taken up), edits it first, or dismisses it.
 * The pre-fill alone is not a rationale: the person adds their own words (UX-1). A decision
 * that closes the case is confirmed first; the reviewer is picked among who can read it.
 */
import { computed, ref } from 'vue';
import { confirmAction } from '@/composables/useConfirm';
import { useAuthStore } from '@/stores/auth';
import { useInvestigationStore } from '@/stores/investigation';
import { useGraphStore } from '@/stores/graph';
import { caseNodeLabel, shortId } from '@/utils/caseLabels';
import { getErrorMessage } from '@/utils/errorMessage';
import type { DecisionRequest, DecisionTaskRequest } from '@/types/investigation';

const emit = defineEmits<{ decided: []; cancel: [] }>();

const store = useInvestigationStore();
const graph = useGraphStore();

const outcomes = computed(() => store.caseType?.outcomes ?? []);
const actions = computed(() => store.caseType?.actions ?? []);
/** The agent's draft this panel opened with (null once dismissed). */
const proposal = ref(store.decisionProposal);
const proposed = proposal.value?.value ?? {};
const proposedTasks: DecisionTaskRequest[] = Array.isArray(proposed.tasks) ? proposed.tasks : [];
const outcome = ref<string>(outcomes.value.some((o) => o.id === proposed.outcome) ? proposed.outcome : (outcomes.value[0]?.id ?? ''));
const chosen = computed(() => outcomes.value.find((o) => o.id === outcome.value) ?? null);
/** A type without catalog: the decision names itself. */
const freeLabel = ref<string>(proposed.outcome_label ?? '');
const freeCloses = ref<boolean>(!!proposed.closes_case);
const closes = computed(() => (outcomes.value.length ? !!chosen.value?.closes_case : freeCloses.value));
const fourEyes = computed(() => !!chosen.value?.requires_review);

const byId = computed(() => new Map(store.unified.nodes.map((n) => [n.node_id, n])));
const nameOf = (id: string) => {
  const n = byId.value.get(id);
  return n ? caseNodeLabel(n, { templates: store.labelTemplates }) : shortId(id);
};
/** Who the decision may be about: the selection (as it is now), then the entities with a role. */
const selection = computed(() => [...graph.selectedNodeIds].filter((id) => byId.value.has(id)));
const proposedTargets: string[] = proposal.value?.targets ?? [];
const targets = ref<string[]>(proposal.value ? [...proposedTargets] : [...selection.value]);
// What is already ticked stays listed when the selection moves on.
const candidates = computed(() => [...new Set([...proposedTargets, ...targets.value, ...selection.value, ...Object.keys(store.roles)])]);
const roleOf = (id: string) => store.roles[id];

const chosenActions = ref<string[]>(proposedTasks.filter((t) => t.action).map((t) => t.action!));
/** The proposal's free tasks (no catalog action), kept as proposed. */
const freeTasks = ref<DecisionTaskRequest[]>(proposedTasks.filter((t) => !t.action && t.title));
const reviewer = ref('');
const auth = useAuthStore();
/** People who can read the case, but not whoever decides: a second pair of eyes. */
const reviewers = computed(() => {
  const inv = store.current;
  if (!inv) return [];
  const me = (auth.email ?? '').toLowerCase();
  return [...new Set([inv.owner_email, ...(inv.shared_with ?? []).map((s) => s.email)])].filter((e) => e && e.toLowerCase() !== me);
});
const busy = ref(false);
const error = ref<string | null>(null);

/** Pre-fill: supported hypotheses and pinned evidence, numbered as the dossier numbers them. */
const prefill = computed(() => {
  const lines: string[] = [];
  const supported = store.hypotheses.filter((h) => h.value.status === 'supported');
  if (supported.length) {
    lines.push('Supported hypotheses:');
    for (const h of supported) lines.push(`- H${store.hypotheses.indexOf(h) + 1} ${h.value.text}`);
  }
  if (store.evidence.length) {
    lines.push(supported.length ? '' : '', 'Pinned evidence:');
    store.evidence.forEach((e) => lines.push(`- ${store.evidenceLabel(e.item.id, e.version.version)} ${e.item.title} (v${e.version.version}, ${e.version.sha256.slice(0, 8)})`));
  }
  return lines.join('\n').trim();
});
const rationale = ref<string>(proposal.value ? String(proposed.rationale ?? '') : prefill.value);
/** The pre-fill lists what the decision rests on; the why is the person's. */
const ownWords = computed(() => rationale.value.trim() !== prefill.value.trim());

async function dismiss() {
  if (!proposal.value) return;
  const ok = await confirmAction({
    title: 'Dismiss the proposed decision?',
    message: 'The proposal is rejected and stays in the journal. You can still record a decision of your own.',
    confirmLabel: 'Dismiss',
  });
  if (!ok) return;
  try {
    await store.setAnnotationStatus(proposal.value.id, 'rejected');
    proposal.value = null;
    freeTasks.value = [];
    rationale.value = prefill.value;
  } catch (e) {
    error.value = getErrorMessage(e, 'Could not dismiss the proposal');
  }
}
const retentionYears = computed(
  () => store.caseType?.retention_years ?? window.__GRAPH_LAGOON_CONFIG__?.investigation_retention_years ?? 10,
);
const ready = computed(() => !!rationale.value.trim() && ownWords.value && (outcomes.value.length ? !!chosen.value : !!freeLabel.value.trim()));

async function record() {
  if (!ready.value || busy.value) return;
  if (closes.value && !fourEyes.value) {
    const ok = await confirmAction({
      title: 'Record the decision and close the case?',
      message: `The case becomes read only; the record and the ${store.evidence.length} pinned version(s) are hashed and retained. A person can reopen it; the decision stays.`,
      confirmLabel: 'Record and close',
    });
    if (!ok) return;
  }
  busy.value = true;
  error.value = null;
  const body: DecisionRequest = {
    ...(outcomes.value.length ? { outcome: outcome.value } : { outcome_label: freeLabel.value.trim(), closes_case: freeCloses.value }),
    rationale: rationale.value.trim(),
    ...(targets.value.length ? { targets: targets.value } : {}),
    ...(chosenActions.value.length || freeTasks.value.length
      ? { tasks: [...chosenActions.value.map((action) => ({ action })), ...freeTasks.value] }
      : {}),
    ...(reviewer.value.trim() ? { reviewer_email: reviewer.value.trim() } : {}),
    ...(proposal.value ? { proposal_id: proposal.value.id } : {}),
  };
  try {
    await store.recordDecision(body);
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
    <div v-if="proposal" class="proposal" data-testid="decision-proposal">
      <strong>Proposed by {{ proposal.author_kind === 'agent' ? 'the agent' : proposal.author_email }}</strong>
      <span class="muted">Review it, change what you disagree with, and record it — or dismiss it.</span>
      <span v-for="(t, i) in freeTasks" :key="i" class="muted">+ task “{{ t.title }}”{{ t.assignee_kind === 'agent' ? ` for agent ${t.agent_name || '(any)'}` : '' }}</span>
      <button type="button" class="link-btn" data-testid="decision-proposal-dismiss" @click="dismiss">Dismiss the proposal</button>
    </div>
    <fieldset>
      <legend>1 · Outcome</legend>
      <template v-if="outcomes.length">
        <label v-for="o in outcomes" :key="o.id" class="outcome">
          <input v-model="outcome" type="radio" :value="o.id" :data-testid="`decision-outcome-${o.id}`" />
          <span>
            {{ o.label }}
            <span v-if="o.closes_case" class="flag">closes the case</span>
            <span v-if="o.requires_review" class="flag">four eyes</span>
            <span v-if="o.description" class="muted block">{{ o.description }}</span>
          </span>
        </label>
      </template>
      <template v-else>
        <input v-model="freeLabel" type="text" maxlength="255" placeholder="What was decided (e.g. Close as false positive)" data-testid="decision-outcome-label" />
        <label><input v-model="freeCloses" type="checkbox" data-testid="decision-closes" /> Closes the case</label>
      </template>
    </fieldset>
    <fieldset v-if="candidates.length">
      <legend>2 · About <span class="muted">none = the whole case</span></legend>
      <label v-for="id in candidates" :key="id">
        <input v-model="targets" type="checkbox" :value="id" :data-testid="`decision-target-${id}`" />
        {{ nameOf(id) }}<span v-if="roleOf(id)" class="muted"> · {{ roleOf(id) }}</span>
      </label>
    </fieldset>
    <fieldset v-if="actions.length">
      <legend>3 · Follow-up tasks</legend>
      <label v-for="a in actions" :key="a.id">
        <input v-model="chosenActions" type="checkbox" :value="a.id" :data-testid="`decision-action-${a.id}`" />
        {{ a.label }}<span v-if="a.due_hours" class="muted"> · due in {{ a.due_hours }} h</span>
      </label>
    </fieldset>
    <label class="field">
      <span class="legend">Rationale <span class="muted">pre-filled with the supported hypotheses and the pinned evidence</span></span>
      <textarea v-model="rationale" rows="7" data-testid="decision-rationale" placeholder="Why, citing the evidence (E1, E2, …)"></textarea>
      <span v-if="rationale.trim() && !ownWords" class="muted" data-testid="decision-own-words">Add your own words: why these lead to this outcome.</span>
    </label>
    <label class="field">
      <span class="legend">Reviewer <span class="muted">{{ fourEyes ? 'four eyes: another person approves before it takes effect' : 'optional' }}</span></span>
      <input v-model="reviewer" type="email" list="decision-reviewers" placeholder="person@company.com" data-testid="decision-reviewer" />
      <datalist id="decision-reviewers"><option v-for="r in reviewers" :key="r" :value="r" /></datalist>
    </label>
    <p v-if="fourEyes" class="muted" data-testid="decision-four-eyes">
      Waits for {{ reviewer.trim() || 'another person with write access' }} to approve it in the dossier{{ closes ? '; the case closes then' : '' }}.
    </p>
    <p v-if="store.caseType?.notice" class="notice" data-testid="decision-notice">{{ store.caseType.notice }}</p>
    <p v-if="error" class="error-message">{{ error }}</p>
    <div class="actions">
      <button type="button" class="btn btn-outline btn-sm" data-testid="decision-cancel" @click="emit('cancel')">Cancel</button>
      <button type="submit" class="btn btn-primary btn-sm" :disabled="busy || !ready" data-testid="decision-record">Record decision</button>
    </div>
    <p class="muted" data-testid="decision-effect">
      <template v-if="closes">Closing freezes the case: the record and the {{ store.evidence.length }} pinned version(s) are hashed and retained for {{ retentionYears }} years. A person can reopen it; the decision stays.</template>
      <template v-else>The case stays open. The decision is hashed with the record so far and stays in it.</template>
    </p>
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

.outcome {
  display: flex;
  gap: 6px;
  align-items: flex-start;
}

.flag {
  margin-left: 4px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  background: var(--color-primary-subtle);
  color: var(--color-primary);
}

.block {
  display: block;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field textarea,
.field input,
fieldset input[type='text'] {
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

.proposal {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px dashed var(--color-primary);
  border-radius: var(--radius-md);
  background: var(--color-primary-subtle);
}

.link-btn {
  align-self: flex-start;
  border: 0;
  padding: 0;
  background: none;
  color: var(--color-primary);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
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
