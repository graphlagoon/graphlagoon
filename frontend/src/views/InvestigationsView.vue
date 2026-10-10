<script setup lang="ts">
/** The case queue (05 §2): title + short id, type, status, deadline, assignee, updated, suggestions; counters are filters. */
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useInvestigationStore } from '@/stores/investigation';
import { useAuthStore } from '@/stores/auth';
import { usePermissions } from '@/composables/usePermissions';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import { KIND_PRESET_LABELS, STATUS_LABELS, URGENT_DAYS, caseNumber, deadlineElapsed, deadlineOf, deadlineText } from '@/utils/investigationStatus';
import { formatDate, plural } from '@/utils/format';
import type { Investigation, InvestigationStatus, KindPreset } from '@/types/investigation';

const router = useRouter();
const store = useInvestigationStore();
const authStore = useAuthStore();
const toast = useToast();
const { can } = usePermissions();

const search = ref('');
type StatusFilter = 'open' | 'all' | 'urgent' | 'suggested' | InvestigationStatus;
const statusFilter = ref<StatusFilter>('open');
const presetFilter = ref('');
const assigneeFilter = ref('');
type SortKey = 'title' | 'kind_preset' | 'item_count' | 'suggested_count' | 'status' | 'assignee' | 'deadline' | 'updated_at';
const sortKey = ref<SortKey>('updated_at');
const sortDir = ref<1 | -1>(-1);

onMounted(() => store.fetchInvestigations());

const isUrgent = (inv: Investigation) => {
  const d = deadlineOf(inv);
  return d !== null && d.daysLeft < URGENT_DAYS;
};

/** Who the row belongs to for the "Assignee" column (assignee, else owner). */
const responsible = (inv: Investigation) => inv.assignee_email ?? inv.owner_email;

const presets = computed(() => [...new Set(store.investigations.map((i) => i.kind_preset))].sort());
const presetLabel = (p: string) => KIND_PRESET_LABELS[p as KindPreset] ?? p;
const assignees = computed(() => [...new Set(store.investigations.map(responsible))].sort());

const SORTERS: Record<SortKey, (inv: Investigation) => string | number> = {
  title: (i) => i.title.toLowerCase(),
  kind_preset: (i) => presetLabel(i.kind_preset).toLowerCase(),
  item_count: (i) => i.item_count ?? 0,
  suggested_count: (i) => i.suggested_count ?? 0,
  status: (i) => ['open', 'analysis', 'decided', 'archived'].indexOf(i.status),
  assignee: (i) => responsible(i).toLowerCase(),
  deadline: (i) => deadlineOf(i)?.daysLeft ?? Number.POSITIVE_INFINITY,
  updated_at: (i) => i.updated_at ?? '',
};

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  const rows = store.investigations.filter((inv) => {
    const f = statusFilter.value;
    if (f === 'open' && (inv.status === 'decided' || inv.status === 'archived')) return false;
    if (f === 'urgent' && !isUrgent(inv)) return false;
    if (f === 'suggested' && !inv.suggested_count) return false;
    if (f !== 'open' && f !== 'all' && f !== 'urgent' && f !== 'suggested' && inv.status !== f) return false;
    if (presetFilter.value && inv.kind_preset !== presetFilter.value) return false;
    if (assigneeFilter.value && responsible(inv) !== assigneeFilter.value) return false;
    if (!q) return true;
    return [inv.title, presetLabel(inv.kind_preset), ...(inv.tags ?? []), inv.assignee_email, inv.owner_email, inv.id]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q);
  });
  const key = SORTERS[sortKey.value];
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return (x < y ? -1 : x > y ? 1 : 0) * sortDir.value;
  });
});

function sortBy(key: SortKey) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 1 ? -1 : 1;
  else {
    sortKey.value = key;
    sortDir.value = key === 'updated_at' || key === 'item_count' || key === 'suggested_count' ? -1 : 1;
  }
}

const sortMark = (key: SortKey) => (sortKey.value === key ? (sortDir.value === 1 ? ' ▲' : ' ▼') : '');

/** A counter is a status filter: clicking it again goes back to "Open". */
function toggleCounter(filter: StatusFilter) {
  statusFilter.value = statusFilter.value === filter ? 'open' : filter;
}

const counters = computed(() => {
  const all = store.investigations;
  return {
    analysis: all.filter((i) => i.status === 'analysis').length,
    open: all.filter((i) => i.status === 'open').length,
    urgent: all.filter(isUrgent).length,
    decided: all.filter((i) => i.status === 'decided').length,
    suggested: all.reduce((n, i) => n + (i.suggested_count ?? 0), 0),
  };
});

/** "compartilhado" when the case is someone else's; "só leitura" when it cannot be changed. */
function accessMark(inv: Investigation): string | null {
  if (inv.owner_email === authStore.email) return null;
  return inv.has_write_access ? 'compartilhado com você' : 'só leitura';
}

function who(email?: string | null) {
  if (!email) return '—';
  return email === authStore.email ? 'você' : email;
}

function updated(inv: Investigation) {
  return inv.updated_at ? formatDate(inv.updated_at, { time: false }) : '—';
}

// New investigation
const showCreate = ref(false);
const form = ref({ title: '', kind_preset: 'livre' as KindPreset, assignee_email: '' });
const creating = ref(false);

function openCreate() {
  form.value = { title: '', kind_preset: 'livre', assignee_email: '' };
  showCreate.value = true;
}

async function create() {
  const title = form.value.title.trim();
  if (!title || creating.value) return;
  creating.value = true;
  try {
    const inv = await store.createInvestigation({
      title,
      kind_preset: form.value.kind_preset,
      assignee_email: form.value.assignee_email.trim() || undefined,
    });
    showCreate.value = false;
    router.push(`/investigations/${inv.id}`);
  } catch (e) {
    toast.error(getErrorMessage(e, 'Não foi possível criar o caso'));
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="container">
    <div class="page-header">
      <h1>Investigações</h1>
      <button
        v-if="can('investigation.create')"
        class="btn btn-primary"
        data-testid="new-investigation-btn"
        @click="openCreate"
      >
        + Novo caso
      </button>
    </div>

    <div class="card filter-card">
      <div class="filter-row">
        <div class="form-group search-group">
          <label for="inv-search">Buscar</label>
          <input
            id="inv-search"
            v-model="search"
            class="form-control"
            placeholder="caso, tipo, tag, responsável…"
            data-testid="investigations-search"
          />
        </div>
        <div class="form-group">
          <label for="inv-status">Status</label>
          <select id="inv-status" v-model="statusFilter" class="form-control" data-testid="investigations-status">
            <option value="open">Em andamento</option>
            <option value="all">Todos</option>
            <option value="urgent">Prazo em menos de {{ URGENT_DAYS }} dias</option>
            <option value="suggested">Com sugestões</option>
            <option v-for="(label, key) in STATUS_LABELS" :key="key" :value="key">{{ label }}</option>
          </select>
        </div>
        <div class="form-group">
          <label for="inv-preset">Tipo</label>
          <select id="inv-preset" v-model="presetFilter" class="form-control" data-testid="investigations-preset">
            <option value="">Todos</option>
            <option v-for="t in presets" :key="t" :value="t">{{ presetLabel(t) }}</option>
          </select>
        </div>
        <div class="form-group">
          <label for="inv-assignee">Responsável</label>
          <select id="inv-assignee" v-model="assigneeFilter" class="form-control" data-testid="investigations-assignee">
            <option value="">Qualquer um</option>
            <option v-for="a in assignees" :key="a" :value="a">{{ who(a) }}</option>
          </select>
        </div>
      </div>
    </div>

    <div class="counters">
      <button class="card counter" :class="{ on: statusFilter === 'analysis' }" data-testid="counter-analysis" @click="toggleCounter('analysis')">
        <strong>{{ counters.analysis }}</strong><span>em análise</span>
      </button>
      <button class="card counter" :class="{ on: statusFilter === 'open' }" data-testid="counter-open" @click="toggleCounter('open')">
        <strong>{{ counters.open }}</strong><span>abertos</span>
      </button>
      <button
        class="card counter"
        :class="{ warn: counters.urgent > 0, on: statusFilter === 'urgent' }"
        data-testid="counter-urgent"
        @click="toggleCounter('urgent')"
      >
        <strong>{{ counters.urgent }}</strong><span>prazo em menos de {{ URGENT_DAYS }} dias</span>
      </button>
      <button class="card counter" :class="{ on: statusFilter === 'decided' }" data-testid="counter-decided" @click="toggleCounter('decided')">
        <strong>{{ counters.decided }}</strong><span>decididos</span>
      </button>
      <button class="card counter" :class="{ warn: counters.suggested > 0, on: statusFilter === 'suggested' }" data-testid="counter-suggested" @click="toggleCounter('suggested')">
        <strong>{{ counters.suggested }}</strong><span>sugestões para revisar</span>
      </button>
    </div>

    <div v-if="store.loading" class="loading"></div>
    <div v-else-if="store.error" class="error-message">{{ store.error }}</div>
    <div v-else-if="store.investigations.length === 0" class="empty-state card" data-testid="investigations-empty">
      <h3>Nenhum caso</h3>
      <p v-if="can('investigation.create')">Crie um caso e adicione a ele explorações, consultas e arquivos de qualquer context.</p>
      <p v-else>Os casos compartilhados com você ou sob sua responsabilidade aparecem aqui.</p>
    </div>
    <div v-else class="card table-card">
      <table class="queue" data-testid="investigations-table">
        <thead>
          <tr>
            <th><button class="sort" data-testid="sort-title" @click="sortBy('title')">Caso{{ sortMark('title') }}</button></th>
            <th><button class="sort" @click="sortBy('kind_preset')">Tipo{{ sortMark('kind_preset') }}</button></th>
            <th><button class="sort" @click="sortBy('item_count')">Material{{ sortMark('item_count') }}</button></th>
            <th><button class="sort" data-testid="sort-suggested" @click="sortBy('suggested_count')">Sugestões{{ sortMark('suggested_count') }}</button></th>
            <th><button class="sort" @click="sortBy('status')">Status{{ sortMark('status') }}</button></th>
            <th><button class="sort" @click="sortBy('assignee')">Responsável{{ sortMark('assignee') }}</button></th>
            <th><button class="sort" data-testid="sort-deadline" @click="sortBy('deadline')">Prazo{{ sortMark('deadline') }}</button></th>
            <th><button class="sort" @click="sortBy('updated_at')">Atualizado{{ sortMark('updated_at') }}</button></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="inv in filtered" :key="inv.id" :data-testid="`investigation-row-${inv.id}`">
            <td>
              <RouterLink :to="`/investigations/${inv.id}`" class="case-title">{{ inv.title }}</RouterLink>
              <span v-if="accessMark(inv)" class="pill access" data-testid="access-mark">{{ accessMark(inv) }}</span>
              <div class="muted">{{ caseNumber(inv.id) }}<template v-if="inv.tags?.length"> · {{ inv.tags.join(', ') }}</template></div>
            </td>
            <td><span class="pill">{{ presetLabel(inv.kind_preset) }}</span></td>
            <td>{{ plural(inv.item_count ?? 0, 'item', 'itens') }}</td>
            <td>
              <span v-if="inv.suggested_count" class="pill suggested" data-testid="row-suggested">{{ plural(inv.suggested_count, 'sugestão', 'sugestões') }}</span>
              <span v-else class="muted">—</span>
            </td>
            <td><span class="status" :class="`status-${inv.status}`">{{ STATUS_LABELS[inv.status] ?? inv.status }}</span></td>
            <td>{{ who(responsible(inv)) }}</td>
            <td>
              <template v-if="deadlineOf(inv)">
                <span :class="{ late: deadlineOf(inv)!.daysLeft < URGENT_DAYS }" :title="`vence em ${formatDate(deadlineOf(inv)!.dueAt, { time: false })}`" data-testid="deadline">
                  {{ deadlineText(deadlineOf(inv)!) }}
                </span>
                <div class="bar" :class="{ late: deadlineOf(inv)!.daysLeft < URGENT_DAYS }">
                  <span :style="{ width: `${deadlineElapsed(deadlineOf(inv)!)}%` }"></span>
                </div>
              </template>
              <span v-else class="muted">—</span>
            </td>
            <td class="muted">{{ updated(inv) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="filtered.length === 0" class="muted no-match">Nenhum caso corresponde aos filtros.</p>
    </div>

    <div v-if="showCreate" class="modal-overlay" @click.self="showCreate = false">
      <div class="modal">
        <div class="modal-header">
          <h2>Novo caso</h2>
          <button class="modal-close" aria-label="Fechar" @click="showCreate = false">&times;</button>
        </div>
        <form @submit.prevent="create">
          <div class="form-group">
            <label for="new-inv-title">Título</label>
            <input id="new-inv-title" v-model="form.title" class="form-control" data-testid="new-investigation-title" required />
          </div>
          <div class="form-group">
            <label for="new-inv-preset">Tipo</label>
            <select id="new-inv-preset" v-model="form.kind_preset" class="form-control" data-testid="new-investigation-preset">
              <option v-for="(label, key) in KIND_PRESET_LABELS" :key="key" :value="key">{{ label }}</option>
            </select>
          </div>
          <div class="form-group">
            <label for="new-inv-assignee">E-mail do responsável</label>
            <input id="new-inv-assignee" v-model="form.assignee_email" type="email" class="form-control" placeholder="você, se vazio" />
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline" @click="showCreate = false">Cancelar</button>
            <button
              type="submit"
              class="btn btn-primary"
              data-testid="new-investigation-submit"
              :disabled="creating || !form.title.trim()"
            >
              Criar
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.filter-card {
  margin-bottom: 16px;
  padding: 16px;
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.filter-row .form-group {
  flex: 1;
  min-width: 160px;
  margin-bottom: 0;
}

.filter-row .search-group {
  flex: 2;
}

.counters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.counter {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.counter.on {
  border-color: var(--color-primary);
  box-shadow: inset 0 0 0 1px var(--color-primary);
}

.counter strong {
  font-size: 22px;
}

.counter span,
.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.counter.warn {
  border-color: var(--color-deadline-warn);
  color: var(--color-deadline-warn);
}

.table-card {
  overflow-x: auto;
  padding: 0;
}

.queue {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.queue th {
  text-align: left;
  font-size: 11px;
  text-transform: uppercase;
  color: var(--text-muted);
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
}

.sort {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  text-transform: inherit;
  color: inherit;
  cursor: pointer;
}

.pill.access {
  margin-left: 6px;
  background: var(--color-primary-subtle);
  color: var(--color-primary);
}

.queue td {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-color);
  vertical-align: middle;
}

.case-title {
  font-weight: 600;
}

.pill,
.status {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-secondary);
  font-size: 12px;
}

.status-analysis {
  background: #e0e7ff;
  color: #3730a3;
  font-weight: 600;
}

.status-decided {
  background: #ccfbf1;
  color: #115e59;
}

.late {
  color: var(--color-deadline-warn);
  font-weight: 600;
}

.bar {
  width: 140px;
  height: 4px;
  margin-top: 4px;
  border-radius: 2px;
  background: var(--bg-secondary);
  overflow: hidden;
}

.bar span {
  display: block;
  height: 100%;
  background: var(--color-primary);
}

.bar.late span {
  background: var(--color-deadline-warn);
}

.no-match {
  padding: 12px 14px;
}
.pill.suggested {
  background: var(--color-suggested-bg);
  border: 1px solid var(--color-suggested-fg);
  color: var(--color-suggested-fg);
}
</style>
