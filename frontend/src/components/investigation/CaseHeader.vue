<script setup lang="ts">
/**
 * Case header (F1, 05 §3, 06 §1): inline title/description, case type, status select
 * with the allowed transitions (only a decision closes), the type's stage, assignee,
 * deadline, suggestions counter and the actions (Dossier, Decide, Share, "…" with
 * reopen and delete). Edits go through the
 * store, which keeps the queue row in sync.
 */
import { computed, nextTick, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useInvestigationStore } from '@/stores/investigation';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import {
  STATUS_LABELS,
  STATUS_TRANSITIONS,
  caseNumber,
  deadlineElapsed,
  deadlineOf,
  deadlineText,
} from '@/utils/investigationStatus';
import { formatDate } from '@/utils/format';
import { fieldInput as fieldValue, fieldText } from '@/utils/caseFields';
import type { CaseTypeField, InvestigationStatus, UpdateInvestigationRequest } from '@/types/investigation';
import ShareDialog from '@/components/investigation/ShareDialog.vue';

const props = defineProps<{
  /** Extra line after the title (e.g. "› Follow the money"). */
  subtitle?: string | null;
  /** `dossier` shows the way back to the canvas (05 §2: one screen, two modes). */
  mode?: 'canvas' | 'dossier';
}>();
const emit = defineEmits<{ decide: []; settings: [] }>();

const store = useInvestigationStore();
const router = useRouter();
const toast = useToast();

const inv = computed(() => store.current!);
const canEdit = computed(() => inv.value.has_write_access && inv.value.status !== 'closed');
const suggested = computed(() => store.suggestions.length);
const deadline = computed(() => deadlineOf(inv.value));
const statusOptions = computed<InvestigationStatus[]>(() => [
  inv.value.status,
  ...STATUS_TRANSITIONS[inv.value.status].filter((s) => s !== inv.value.status),
]);

type Field = 'title' | 'description' | 'assignee_email';
const editing = ref<Field | null>(null);
const draft = ref('');
const fieldInput = ref<HTMLInputElement | HTMLTextAreaElement | null>(null);
const showShare = ref(false);
const showMenu = ref(false);
const confirmDelete = ref(false);
const busy = ref(false);
const stages = computed(() => store.caseType?.stages ?? []);
const pendingReview = computed(() => (inv.value.decisions ?? []).some((d) => d.review === 'pending'));

async function save(patch: UpdateInvestigationRequest, fallback: string) {
  busy.value = true;
  try {
    await store.updateInvestigation(patch);
  } catch (e) {
    toast.error(getErrorMessage(e, fallback));
  } finally {
    busy.value = false;
  }
}

function edit(field: Field) {
  if (!canEdit.value) return;
  editing.value = field;
  draft.value = inv.value[field] ?? '';
  void nextTick(() => fieldInput.value?.focus());
}

async function commit() {
  const field = editing.value;
  if (!field) return;
  editing.value = null;
  const value = draft.value.trim();
  const before = inv.value[field] ?? '';
  if (value === before) return;
  if (field === 'title' && !value) return;
  await save({ [field]: value || null } as UpdateInvestigationRequest, 'Could not save the change');
}

function cancel() {
  editing.value = null;
}

function onStatus(event: Event) {
  const select = event.target as HTMLSelectElement;
  const status = select.value as InvestigationStatus;
  if (status === inv.value.status || status === 'closed') return;
  void save({ status }, 'Could not change the status');
}

function onStage(event: Event) {
  const stage = (event.target as HTMLSelectElement).value || null;
  if (stage !== (inv.value.stage ?? null)) void save({ stage }, 'Could not change the stage');
}

async function reopen() {
  showMenu.value = false;
  busy.value = true;
  try {
    await store.reopenInvestigation();
    toast.success('Case reopened: its decisions stay in the record');
  } catch (e) {
    toast.error(getErrorMessage(e, 'Could not reopen the case'));
  } finally {
    busy.value = false;
  }
}

async function remove() {
  busy.value = true;
  try {
    await store.deleteInvestigation();
    toast.success('Case deleted');
    router.push('/investigations');
  } catch (e) {
    toast.error(getErrorMessage(e, 'Could not delete the case'));
  } finally {
    busy.value = false;
    confirmDelete.value = false;
    showMenu.value = false;
  }
}

function onType(event: Event) {
  const case_type = (event.target as HTMLSelectElement).value;
  if (case_type !== inv.value.case_type) void save({ case_type }, 'Could not change the case type');
}

// The case type's fields (06 §1), edited in place.
const typeFields = computed<CaseTypeField[]>(() => store.caseType?.fields ?? []);
const editingField = ref<string | null>(null);
const fieldDraft = ref('');

function editField(f: CaseTypeField) {
  if (!canEdit.value) return;
  editingField.value = f.id;
  const v = inv.value.fields?.[f.id];
  fieldDraft.value = v === null || v === undefined ? '' : String(v);
}

async function commitField(f: CaseTypeField) {
  if (editingField.value !== f.id) return;
  editingField.value = null;
  const before = inv.value.fields?.[f.id];
  const value = fieldValue(f, fieldDraft.value);
  if (value === (before ?? null) || String(value ?? '') === String(before ?? '')) return;
  await save({ fields: { [f.id]: value } }, `Could not save ${f.label}`);
}

function toggleMenu() {
  showMenu.value = !showMenu.value;
  confirmDelete.value = false;
}
</script>

<template>
  <header v-if="store.current" class="case-header" data-testid="case-header">
    <div class="row">
      <RouterLink to="/investigations" class="back">← Queue</RouterLink>
      <span class="number" :title="inv.id">{{ caseNumber(inv.id) }}</span>

      <input
        v-if="editing === 'title'"
        ref="fieldInput"
        v-model="draft"
        class="form-control title-input"
        data-testid="case-title-input"
        @keydown.enter.prevent="commit"
        @keydown.esc.prevent="cancel"
        @blur="commit"
      />
      <h1
        v-else
        :class="{ editable: canEdit }"
        :title="canEdit ? 'Click to rename' : undefined"
        data-testid="investigation-title"
        @click="edit('title')"
      >
        {{ inv.title }}
      </h1>
      <span v-if="subtitle" class="muted">{{ subtitle }}</span>

      <select
        class="status-select"
        :class="`status-${inv.status}`"
        :value="inv.status"
        :disabled="!inv.has_write_access || busy || inv.status === 'closed'"
        :title="inv.status === 'closed' ? 'Closed by a decision; reopen it from the … menu' : undefined"
        data-testid="case-status"
        @change="onStatus"
      >
        <option v-for="s in statusOptions" :key="s" :value="s">{{ STATUS_LABELS[s] }}</option>
      </select>
      <select
        v-if="stages.length || inv.stage"
        class="status-select stage"
        :value="inv.stage ?? ''"
        :disabled="!canEdit || busy"
        data-testid="case-stage"
        @change="onStage"
      >
        <option value="">No stage</option>
        <option v-for="st in stages" :key="st" :value="st">{{ st }}</option>
        <option v-if="inv.stage && !stages.includes(inv.stage)" :value="inv.stage">{{ inv.stage }}</option>
      </select>

      <span
        v-if="deadline"
        class="badge deadline"
        :class="{ urgent: deadline.urgent }"
        :title="`Due ${formatDate(deadline.dueAt)} (${deadline.totalHours} h of SLA since the alert)`"
        data-testid="workspace-deadline"
      >
        ⏱ {{ deadlineText(deadline) }}
        <span class="bar"><span :style="{ width: `${deadlineElapsed(deadline)}%` }"></span></span>
      </span>

      <button
        v-if="store.decisionProposal && canEdit && !pendingReview"
        class="badge review proposal"
        data-testid="decision-proposal-badge"
        title="An agent proposed a decision: review it in the decision panel"
        @click="emit('decide')"
      >
        Decision proposed
      </button>
      <span v-if="pendingReview" class="badge review" data-testid="review-pending" title="Four eyes: another person approves it in the dossier">Decision waiting for review</span>

      <span v-if="suggested" class="badge suggested" data-testid="suggested-badge">● {{ suggested }} {{ suggested === 1 ? 'suggestion' : 'suggestions' }}</span>

      <span class="actions">
        <RouterLink
          :to="props.mode === 'dossier' ? `/investigations/${inv.id}` : `/investigations/${inv.id}?mode=dossier`"
          class="btn btn-outline btn-sm"
          data-testid="dossier-link"
        >
          {{ props.mode === 'dossier' ? 'Canvas' : 'Dossier' }}
        </RouterLink>
        <button
          v-if="canEdit && !pendingReview"
          class="btn btn-primary btn-sm"
          data-testid="case-decide"
          @click="emit('decide')"
        >
          Decide
        </button>
        <button class="btn btn-outline btn-sm" title="Case settings" aria-label="Case settings" data-testid="case-settings-btn" @click="emit('settings')">⚙</button>
        <button
          v-if="inv.can_manage"
          class="btn btn-outline btn-sm"
          data-testid="case-share"
          @click="showShare = true"
        >
          Share<template v-if="inv.shared_with.length"> · {{ inv.shared_with.length }}</template>
        </button>
        <span class="menu-wrap">
          <button class="btn btn-outline btn-sm" aria-label="More actions" data-testid="case-menu" @click="toggleMenu">
            …
          </button>
          <div v-if="showMenu" class="menu" data-testid="case-menu-list">
            <RouterLink to="/settings/agents" class="menu-item" data-testid="agents-link">Agent tokens…</RouterLink>
            <button
              v-if="inv.status === 'closed' && inv.has_write_access"
              class="menu-item"
              :disabled="busy"
              data-testid="case-reopen"
              @click="reopen"
            >
              Reopen (back to analysis)
            </button>
            <template v-if="inv.can_manage">
              <button v-if="!confirmDelete" class="menu-item danger" data-testid="case-delete" @click="confirmDelete = true">
                Delete case…
              </button>
              <div v-else class="confirm" data-testid="case-delete-confirm">
                <span>Delete “{{ inv.title }}” and everything in it?</span>
                <button class="btn btn-danger btn-sm" :disabled="busy" data-testid="case-delete-yes" @click="remove">Delete</button>
                <button class="btn btn-outline btn-sm" @click="confirmDelete = false">Keep</button>
              </div>
            </template>
          </div>
        </span>
      </span>
    </div>

    <div class="row meta">
      <span class="field">
        <span class="muted">Type</span>
        <select class="chip" :value="inv.case_type" :disabled="!canEdit" data-testid="case-type" @change="onType">
          <option v-for="t in store.caseTypes" :key="t.slug" :value="t.slug">{{ t.label }}</option>
          <option v-if="!store.caseTypes.some((t) => t.slug === inv.case_type)" :value="inv.case_type">{{ store.caseTypeLabel(inv.case_type) }}</option>
        </select>
      </span>
      <span v-for="f in typeFields" :key="f.id" class="field" :data-testid="`case-field-${f.id}`">
        <span class="muted">{{ f.label }}</span>
        <template v-if="editingField === f.id">
          <select v-if="f.type === 'enum'" v-model="fieldDraft" class="chip" :data-testid="`case-field-input-${f.id}`" @change="commitField(f)" @blur="commitField(f)">
            <option value="">—</option>
            <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
          </select>
          <input
            v-else
            v-model="fieldDraft"
            :type="f.type === 'date' ? 'date' : f.type === 'text' ? 'text' : 'number'"
            step="any"
            class="form-control meta-input"
            :data-testid="`case-field-input-${f.id}`"
            @keydown.enter.prevent="commitField(f)"
            @keydown.esc.prevent="editingField = null"
            @blur="commitField(f)"
          />
        </template>
        <button v-else class="chip" :disabled="!canEdit" :data-testid="`case-field-value-${f.id}`" @click="editField(f)">
          {{ fieldText(f, inv.fields?.[f.id]) }}
        </button>
      </span>
      <span class="field">
        <span class="muted">Assignee</span>
        <input
          v-if="editing === 'assignee_email'"
          ref="fieldInput"
          v-model="draft"
          type="email"
          class="form-control meta-input"
          data-testid="case-assignee-input"
          placeholder="person@company.com"
          @keydown.enter.prevent="commit"
          @keydown.esc.prevent="cancel"
          @blur="commit"
        />
        <button v-else class="chip" :disabled="!canEdit" data-testid="case-assignee" @click="edit('assignee_email')">
          {{ inv.assignee_email || inv.owner_email }}
        </button>
      </span>
      <span v-if="inv.tags?.length" class="field"><span class="muted">Tags</span><span>{{ inv.tags.join(', ') }}</span></span>
      <span class="field description">
        <textarea
          v-if="editing === 'description'"
          ref="fieldInput"
          v-model="draft"
          rows="2"
          class="form-control meta-input"
          data-testid="case-description-input"
          placeholder="What this case is about"
          @keydown.esc.prevent="cancel"
          @keydown.enter.exact.prevent="commit"
          @blur="commit"
        ></textarea>
        <button v-else class="chip plain" :disabled="!canEdit" data-testid="case-description" @click="edit('description')">
          {{ inv.description || (canEdit ? 'Add a description…' : '') }}
        </button>
      </span>
    </div>

    <ShareDialog :open="showShare" @close="showShare = false" />
  </header>
</template>

<style scoped>
.case-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 16px 6px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.row.meta {
  font-size: 12px;
  gap: 16px;
}

.back,
.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.number {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--text-muted);
}

h1 {
  margin: 0;
  font-size: 18px;
  border-bottom: 1px dashed transparent;
}

h1.editable {
  cursor: text;
}

h1.editable:hover {
  border-bottom-color: var(--border-color);
}

.title-input {
  min-width: 320px;
  font-size: 16px;
  font-weight: 600;
}

.status-select {
  padding: 3px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  font: inherit;
  font-size: 12px;
  background: var(--color-primary-subtle);
  color: var(--color-primary);
}

.status-select.status-analysis {
  background: #e0e7ff;
  color: #3730a3;
  font-weight: 600;
}

.status-select.status-closed {
  background: #ccfbf1;
  color: #115e59;
}

.badge {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  background: var(--color-primary-subtle);
  color: var(--color-primary);
}

.badge.deadline {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  min-width: 120px;
}

.badge.urgent {
  background: var(--color-deadline-warn);
  color: #fff;
  font-weight: 600;
}

.bar {
  display: block;
  width: 100%;
  height: 3px;
  border-radius: 2px;
  background: rgb(255 255 255 / 45%);
  overflow: hidden;
}

.badge:not(.urgent) .bar {
  background: var(--color-primary-accent-subtle);
}

.bar span {
  display: block;
  height: 100%;
  background: currentcolor;
}

.badge.review {
  background: #fef3c7;
  color: #92400e;
}

.badge.proposal {
  border: 1px dashed #92400e;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.actions {
  display: inline-flex;
  gap: 6px;
  margin-left: auto;
  align-items: center;
}

.menu-wrap {
  position: relative;
}

.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 30;
  display: flex;
  flex-direction: column;
  min-width: 220px;
  padding: 4px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: 0 4px 16px rgb(0 0 0 / 12%);
}

.menu-item {
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  font: inherit;
  font-size: 13px;
  text-align: left;
  text-decoration: none;
  color: var(--text-color);
  cursor: pointer;
}

.menu-item:hover {
  background: var(--color-bg-muted);
}

.menu-item.danger {
  color: var(--color-error, #b91c1c);
}

.confirm {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  font-size: 12px;
}

.field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.field.description {
  flex: 1;
  min-width: 240px;
}

.chip {
  padding: 2px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--text-color);
  cursor: pointer;
}

.chip.plain {
  flex: 1;
  border-color: transparent;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-muted);
  white-space: pre-wrap;
}

.chip:disabled {
  cursor: default;
}

.meta-input {
  padding: 2px 6px;
  font-size: 12px;
  min-width: 200px;
}
.badge.suggested {
  background: var(--color-suggested-bg);
  border: 1px solid var(--color-suggested-fg);
  color: var(--color-suggested-fg);
}
</style>
