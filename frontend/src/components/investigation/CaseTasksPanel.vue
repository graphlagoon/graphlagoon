<script setup lang="ts">
/**
 * The case's tasks (06 §1): follow-ups for people and agents, from a decision's
 * actions or added by hand. Filters mine / agents / overdue; done tasks fold away.
 * Tasks stay editable on a closed case (the follow-ups outlive the decision); an
 * agent's suggested task is confirmed or rejected here.
 */
import { computed, ref } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { useAuthStore } from '@/stores/auth';
import { getErrorMessage } from '@/utils/errorMessage';
import { formatDate } from '@/utils/format';
import { TASK_STATE_LABELS, taskOverdue } from '@/utils/investigationStatus';
import type { CaseAnnotation, TaskState, TaskValue } from '@/types/investigation';

const props = defineProps<{
  /** The dossier's card: open tasks only, no form. */
  compact?: boolean;
}>();

const store = useInvestigationStore();
const auth = useAuthStore();

type Filter = 'all' | 'mine' | 'agents' | 'overdue';
const filter = ref<Filter>('all');
const showDone = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);

const canWrite = computed(() => !!store.current?.has_write_access);
const value = (t: CaseAnnotation) => t.value as TaskValue;
const open = computed(() => store.tasks.filter((t) => value(t).state === 'open'));
const shown = computed(() =>
  store.tasks.filter((t) => {
    const v = value(t);
    if (props.compact || !showDone.value) {
      if (v.state !== 'open') return false;
    }
    if (filter.value === 'mine') return v.assignee_kind === 'human' && v.assignee === auth.email;
    if (filter.value === 'agents') return v.assignee_kind === 'agent';
    if (filter.value === 'overdue') return taskOverdue(v);
    return true;
  }),
);
const hiddenDone = computed(() => store.tasks.length - open.value.length);

function who(v: TaskValue): string {
  if (v.assignee_kind === 'agent') return v.agent_name ? `agent ${v.agent_name}` : 'any agent';
  return v.assignee || 'unassigned';
}
function fromDecision(v: TaskValue): string | null {
  if (!v.decision_id) return null;
  const i = (store.current?.decisions ?? []).findIndex((d) => d.id === v.decision_id);
  return i >= 0 ? `D${i + 1}` : 'a decision';
}

async function act(action: () => Promise<unknown>, fallback: string) {
  error.value = null;
  busy.value = true;
  try {
    await action();
  } catch (e) {
    error.value = getErrorMessage(e, fallback);
  } finally {
    busy.value = false;
  }
}

const setState = (t: CaseAnnotation, state: TaskState) => act(() => store.updateTask(t.id, { state }), 'Could not update the task');
const toggle = (t: CaseAnnotation) => setState(t, value(t).state === 'done' ? 'open' : 'done');

// --- add ---------------------------------------------------------------------
const title = ref('');
const forKind = ref<'human' | 'agent'>('human');
const assignee = ref('');
const agentName = ref('');
const due = ref('');
async function add() {
  if (!title.value.trim()) return;
  await act(async () => {
    await store.addTask({
      title: title.value.trim(),
      assignee_kind: forKind.value,
      ...(forKind.value === 'human' && assignee.value.trim() ? { assignee: assignee.value.trim() } : {}),
      ...(forKind.value === 'agent' && agentName.value.trim() ? { agent_name: agentName.value.trim() } : {}),
      ...(due.value ? { due_at: new Date(due.value).toISOString() } : {}),
    });
    title.value = '';
    assignee.value = '';
    agentName.value = '';
    due.value = '';
  }, 'Could not add the task');
}
</script>

<template>
  <div class="tasks" data-testid="tasks-panel">
    <div v-if="!compact" class="filter">
      <button v-for="f in (['all', 'mine', 'agents', 'overdue'] as Filter[])" :key="f" :class="{ on: filter === f }" :data-testid="`tasks-filter-${f}`" @click="filter = f">
        {{ f === 'all' ? 'All' : f === 'mine' ? 'Mine' : f === 'agents' ? 'Agents' : 'Overdue' }}
      </button>
      <label v-if="hiddenDone" class="muted"><input v-model="showDone" type="checkbox" data-testid="tasks-show-done" /> show {{ hiddenDone }} done or cancelled</label>
    </div>

    <div v-for="t in shown" :key="t.id" class="task" :class="{ done: value(t).state !== 'open' }" :data-testid="`task-${t.id}`">
      <input
        type="checkbox"
        :checked="value(t).state === 'done'"
        :disabled="!canWrite || busy || t.status === 'suggested' || value(t).state === 'cancelled'"
        :aria-label="`Mark “${value(t).title}” done`"
        :data-testid="`task-done-${t.id}`"
        @change="toggle(t)"
      />
      <div class="main">
        <span class="title">{{ value(t).title }}</span>
        <span class="muted">
          {{ who(value(t)) }}
          <template v-if="value(t).due_at"> · <span :class="{ late: taskOverdue(value(t)) }" data-testid="task-due">due {{ formatDate(value(t).due_at) }}</span></template>
          <template v-if="fromDecision(value(t))"> · from {{ fromDecision(value(t)) }}</template>
          <template v-if="value(t).state !== 'open'"> · {{ TASK_STATE_LABELS[value(t).state] }}</template>
          <template v-if="t.reason"> · {{ t.reason }}</template>
        </span>
      </div>
      <span v-if="t.status === 'suggested'" class="suggested" data-testid="task-suggested">
        suggested by the agent
        <template v-if="canWrite">
          <button class="link-btn ok" :disabled="busy" :data-testid="`task-confirm-${t.id}`" @click="act(() => store.setAnnotationStatus(t.id, 'confirmed'), 'Could not confirm')">✓</button>
          <button class="link-btn danger" :disabled="busy" @click="act(() => store.setAnnotationStatus(t.id, 'rejected'), 'Could not reject')">✕</button>
        </template>
      </span>
      <button
        v-else-if="!compact && canWrite && value(t).state === 'open'"
        class="link-btn"
        :disabled="busy"
        :data-testid="`task-cancel-${t.id}`"
        @click="setState(t, 'cancelled')"
      >
        cancel
      </button>
    </div>
    <p v-if="!shown.length" class="muted" data-testid="tasks-empty">{{ store.tasks.length ? 'No task matches.' : 'No tasks yet. A decision turns its actions into tasks.' }}</p>

    <form v-if="!compact && canWrite" class="add" data-testid="task-form" @submit.prevent="add">
      <input v-model="title" type="text" maxlength="255" placeholder="New task" data-testid="task-title" />
      <select v-model="forKind" aria-label="For" data-testid="task-for">
        <option value="human">for a person</option>
        <option value="agent">for an agent</option>
      </select>
      <input v-if="forKind === 'human'" v-model="assignee" type="email" placeholder="person@company.com" data-testid="task-assignee" />
      <input v-else v-model="agentName" type="text" placeholder="agent token name (any if empty)" data-testid="task-agent" />
      <input v-model="due" type="datetime-local" aria-label="Due" data-testid="task-due-input" />
      <button type="submit" class="btn btn-primary btn-sm" :disabled="busy || !title.trim()" data-testid="task-add">Add</button>
    </form>
    <p v-if="error" class="error-message">{{ error }}</p>
  </div>
</template>

<style scoped>
.tasks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.filter {
  display: flex;
  gap: 6px;
  align-items: center;
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
  background: var(--color-primary-subtle);
  color: var(--color-primary);
}

.task {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.task.done .title {
  text-decoration: line-through;
  color: var(--text-muted);
}

.main {
  display: flex;
  flex-direction: column;
  flex: 1;
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.late {
  color: var(--color-deadline-warn);
  font-weight: 600;
}

.suggested {
  font-size: 12px;
  color: #92400e;
}

.link-btn {
  border: 0;
  background: none;
  color: var(--color-primary);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.link-btn.ok {
  color: #15803d;
}

.link-btn.danger {
  color: #b91c1c;
}

.add {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.add input,
.add select {
  font: inherit;
  font-size: 12px;
  padding: 3px 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.add input[type='text'] {
  min-width: 200px;
}
</style>
