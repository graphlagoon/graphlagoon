<script setup lang="ts">
/**
 * Case header (F1, 05 §3): inline title/description, case type, status select with
 * the allowed transitions, assignee, deadline, suggestions counter and the actions
 * (Dossier, Decide, Share, "…" with reopen and delete). Edits go through the
 * store, which keeps the queue row in sync.
 */
import { computed, nextTick, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useInvestigationStore } from '@/stores/investigation';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import {
  KIND_PRESET_LABELS,
  STATUS_LABELS,
  STATUS_TRANSITIONS,
  URGENT_DAYS,
  caseNumber,
  deadlineOf,
} from '@/utils/investigationStatus';
import type { InvestigationStatus, KindPreset, UpdateInvestigationRequest } from '@/types/investigation';
import ShareDialog from '@/components/investigation/ShareDialog.vue';
import DecideDialog from '@/components/investigation/DecideDialog.vue';

defineProps<{
  /** Extra line after the title (e.g. "› Follow the money"). */
  subtitle?: string | null;
}>();

const store = useInvestigationStore();
const router = useRouter();
const toast = useToast();

const inv = computed(() => store.current!);
const canEdit = computed(() => inv.value.has_write_access && inv.value.status !== 'decided');
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
const showDecide = ref(false);
const showMenu = ref(false);
const confirmDelete = ref(false);
const busy = ref(false);

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
  await save({ [field]: value || null } as UpdateInvestigationRequest, `Failed to update the ${field}`);
}

function cancel() {
  editing.value = null;
}

function onStatus(event: Event) {
  const status = (event.target as HTMLSelectElement).value as InvestigationStatus;
  if (status === inv.value.status || status === 'decided') return;
  void save({ status }, 'Failed to change the status');
}

async function reopen() {
  showMenu.value = false;
  busy.value = true;
  try {
    await store.reopenInvestigation();
    toast.success('Case reopened: the decision stays in the journal');
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to reopen the case'));
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
    toast.error(getErrorMessage(e, 'Failed to delete the case'));
  } finally {
    busy.value = false;
    confirmDelete.value = false;
    showMenu.value = false;
  }
}

function onPreset(event: Event) {
  const kind_preset = (event.target as HTMLSelectElement).value as KindPreset;
  if (kind_preset !== inv.value.kind_preset) void save({ kind_preset }, 'Failed to change the case type');
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
        :disabled="!inv.has_write_access || busy || inv.status === 'decided'"
        data-testid="case-status"
        @change="onStatus"
      >
        <option v-for="s in statusOptions" :key="s" :value="s">{{ STATUS_LABELS[s] }}</option>
      </select>

      <span
        v-if="deadline"
        class="badge"
        :class="{ urgent: deadline.daysLeft < URGENT_DAYS }"
        data-testid="workspace-deadline"
      >
        ⏱ {{ deadline.phase }} · {{ deadline.daysLeft }} d left
      </span>

      <span v-if="suggested" class="badge suggested" data-testid="suggested-badge">● {{ suggested }} {{ suggested === 1 ? 'suggestion' : 'suggestions' }}</span>

      <span class="actions">
        <RouterLink :to="`/investigations/${inv.id}/dossier`" class="btn btn-outline btn-sm" data-testid="dossier-link">
          Dossier
        </RouterLink>
        <button
          v-if="canEdit"
          class="btn btn-primary btn-sm"
          data-testid="case-decide"
          @click="showDecide = true"
        >
          Decide
        </button>
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
              v-if="inv.status === 'decided' && inv.has_write_access"
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
        <select class="chip" :value="inv.kind_preset" :disabled="!canEdit" data-testid="case-preset" @change="onPreset">
          <option v-for="(label, key) in KIND_PRESET_LABELS" :key="key" :value="key">{{ label }}</option>
        </select>
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
    <DecideDialog :open="showDecide" @close="showDecide = false" />
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

.status-select.status-decided {
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

.badge.urgent {
  background: #c2410c;
  color: #fff;
  font-weight: 600;
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
  background: #fffbeb;
  border: 1px solid #b45309;
  color: #b45309;
}
</style>
