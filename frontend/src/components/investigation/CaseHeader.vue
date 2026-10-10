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
  deadlineElapsed,
  deadlineOf,
  deadlineText,
} from '@/utils/investigationStatus';
import { formatDate } from '@/utils/format';
import type { InvestigationStatus, KindPreset, UpdateInvestigationRequest } from '@/types/investigation';
import ShareDialog from '@/components/investigation/ShareDialog.vue';

const props = defineProps<{
  /** Extra line after the title (e.g. "› Follow the money"). */
  subtitle?: string | null;
  /** `dossie` shows the way back to the canvas (05 §2: one screen, two modes). */
  mode?: 'canvas' | 'dossie';
}>();
const emit = defineEmits<{ decide: []; settings: [] }>();

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
const showMenu = ref(false);
const confirmDelete = ref(false);
const busy = ref(false);
/** Open while archiving a case that has no decision: the reason is required (05 §7). */
const archiveReason = ref<string | null>(null);
const reasonInput = ref<HTMLTextAreaElement | null>(null);

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
  await save({ [field]: value || null } as UpdateInvestigationRequest, 'Não foi possível salvar a alteração');
}

function cancel() {
  editing.value = null;
}

function onStatus(event: Event) {
  const select = event.target as HTMLSelectElement;
  const status = select.value as InvestigationStatus;
  if (status === inv.value.status || status === 'decided') return;
  if (status === 'archived' && inv.value.status !== 'decided') {
    select.value = inv.value.status; // the case moves only after the reason is given
    archiveReason.value = '';
    void nextTick(() => reasonInput.value?.focus());
    return;
  }
  void save({ status }, 'Não foi possível mudar o status');
}

async function archiveWithoutDecision() {
  const reason = (archiveReason.value ?? '').trim();
  if (!reason) return;
  await save({ status: 'archived', archive_reason: reason }, 'Não foi possível arquivar o caso');
  archiveReason.value = null;
}

async function reopen() {
  showMenu.value = false;
  busy.value = true;
  try {
    await store.reopenInvestigation();
    toast.success('Caso reaberto: a decisão fica no diário');
  } catch (e) {
    toast.error(getErrorMessage(e, 'Não foi possível reabrir o caso'));
  } finally {
    busy.value = false;
  }
}

async function remove() {
  busy.value = true;
  try {
    await store.deleteInvestigation();
    toast.success('Caso excluído');
    router.push('/investigations');
  } catch (e) {
    toast.error(getErrorMessage(e, 'Não foi possível excluir o caso'));
  } finally {
    busy.value = false;
    confirmDelete.value = false;
    showMenu.value = false;
  }
}

function onPreset(event: Event) {
  const kind_preset = (event.target as HTMLSelectElement).value as KindPreset;
  if (kind_preset !== inv.value.kind_preset) void save({ kind_preset }, 'Não foi possível mudar o tipo do caso');
}

function toggleMenu() {
  showMenu.value = !showMenu.value;
  confirmDelete.value = false;
}
</script>

<template>
  <header v-if="store.current" class="case-header" data-testid="case-header">
    <div class="row">
      <RouterLink to="/investigations" class="back">← Fila</RouterLink>
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
        :title="canEdit ? 'Clique para renomear' : undefined"
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
        class="badge deadline"
        :class="{ urgent: deadline.daysLeft < URGENT_DAYS }"
        :title="`Prazo da fase: ${formatDate(deadline.dueAt, { time: false })} (${deadline.totalDays} dias desde o alerta)`"
        data-testid="workspace-deadline"
      >
        ⏱ {{ deadlineText(deadline) }}
        <span class="bar"><span :style="{ width: `${deadlineElapsed(deadline)}%` }"></span></span>
      </span>

      <span v-if="archiveReason !== null" class="archive-reason" data-testid="archive-reason">
        <textarea
          ref="reasonInput"
          v-model="archiveReason"
          rows="2"
          class="form-control"
          placeholder="Motivo para arquivar sem decisão (obrigatório)"
          data-testid="archive-reason-input"
          @keydown.esc.prevent="archiveReason = null"
        ></textarea>
        <button class="btn btn-primary btn-sm" :disabled="busy || !archiveReason.trim()" data-testid="archive-reason-confirm" @click="archiveWithoutDecision">Arquivar sem decisão</button>
        <button class="btn btn-outline btn-sm" @click="archiveReason = null">Cancelar</button>
      </span>

      <span v-if="suggested" class="badge suggested" data-testid="suggested-badge">● {{ suggested }} {{ suggested === 1 ? 'sugestão' : 'sugestões' }}</span>

      <span class="actions">
        <RouterLink
          :to="props.mode === 'dossie' ? `/investigations/${inv.id}` : `/investigations/${inv.id}?mode=dossie`"
          class="btn btn-outline btn-sm"
          data-testid="dossier-link"
        >
          {{ props.mode === 'dossie' ? 'Canvas' : 'Dossiê' }}
        </RouterLink>
        <button
          v-if="canEdit"
          class="btn btn-primary btn-sm"
          data-testid="case-decide"
          @click="emit('decide')"
        >
          Decidir
        </button>
        <button class="btn btn-outline btn-sm" title="Preferências do caso" aria-label="Preferências do caso" data-testid="case-settings-btn" @click="emit('settings')">⚙</button>
        <button
          v-if="inv.can_manage"
          class="btn btn-outline btn-sm"
          data-testid="case-share"
          @click="showShare = true"
        >
          Compartilhar<template v-if="inv.shared_with.length"> · {{ inv.shared_with.length }}</template>
        </button>
        <span class="menu-wrap">
          <button class="btn btn-outline btn-sm" aria-label="Mais ações" data-testid="case-menu" @click="toggleMenu">
            …
          </button>
          <div v-if="showMenu" class="menu" data-testid="case-menu-list">
            <RouterLink to="/settings/agents" class="menu-item" data-testid="agents-link">Tokens de agente…</RouterLink>
            <button
              v-if="inv.status === 'decided' && inv.has_write_access"
              class="menu-item"
              :disabled="busy"
              data-testid="case-reopen"
              @click="reopen"
            >
              Reabrir (volta para análise)
            </button>
            <template v-if="inv.can_manage">
              <button v-if="!confirmDelete" class="menu-item danger" data-testid="case-delete" @click="confirmDelete = true">
                Excluir caso…
              </button>
              <div v-else class="confirm" data-testid="case-delete-confirm">
                <span>Excluir “{{ inv.title }}” e tudo que há nele?</span>
                <button class="btn btn-danger btn-sm" :disabled="busy" data-testid="case-delete-yes" @click="remove">Excluir</button>
                <button class="btn btn-outline btn-sm" @click="confirmDelete = false">Manter</button>
              </div>
            </template>
          </div>
        </span>
      </span>
    </div>

    <div class="row meta">
      <span class="field">
        <span class="muted">Tipo</span>
        <select class="chip" :value="inv.kind_preset" :disabled="!canEdit" data-testid="case-preset" @change="onPreset">
          <option v-for="(label, key) in KIND_PRESET_LABELS" :key="key" :value="key">{{ label }}</option>
        </select>
      </span>
      <span class="field">
        <span class="muted">Responsável</span>
        <input
          v-if="editing === 'assignee_email'"
          ref="fieldInput"
          v-model="draft"
          type="email"
          class="form-control meta-input"
          data-testid="case-assignee-input"
          placeholder="pessoa@empresa.com"
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
          placeholder="Do que trata este caso"
          @keydown.esc.prevent="cancel"
          @keydown.enter.exact.prevent="commit"
          @blur="commit"
        ></textarea>
        <button v-else class="chip plain" :disabled="!canEdit" data-testid="case-description" @click="edit('description')">
          {{ inv.description || (canEdit ? 'Adicionar descrição…' : '') }}
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

.archive-reason {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.archive-reason textarea {
  min-width: 260px;
  font-size: 12px;
  padding: 2px 6px;
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
