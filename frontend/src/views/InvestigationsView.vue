<script setup lang="ts">
/** The case queue (T1). */
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useInvestigationStore } from '@/stores/investigation';
import { useAuthStore } from '@/stores/auth';
import { usePermissions } from '@/composables/usePermissions';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import { PHASE_DAYS, STATUS_LABELS, URGENT_DAYS, caseNumber, deadlineOf } from '@/utils/investigationStatus';
import type { Investigation, InvestigationStatus } from '@/types/investigation';

const router = useRouter();
const store = useInvestigationStore();
const authStore = useAuthStore();
const toast = useToast();
const { can } = usePermissions();

const search = ref('');
type StatusFilter = 'open' | 'all' | 'urgent' | InvestigationStatus;
const statusFilter = ref<StatusFilter>('open');
const typologyFilter = ref('');
const assigneeFilter = ref('');
type SortKey = 'title' | 'typology' | 'source_count' | 'status' | 'assignee' | 'deadline' | 'updated_at';
const sortKey = ref<SortKey>('updated_at');
const sortDir = ref<1 | -1>(-1);

onMounted(() => store.fetchInvestigations());

const isUrgent = (inv: Investigation) => {
  const d = deadlineOf(inv);
  return d !== null && d.daysLeft < URGENT_DAYS;
};

/** Who the row belongs to for the "Assignee" column (assignee, else owner). */
const responsible = (inv: Investigation) => inv.assignee_email ?? inv.owner_email;

const typologies = computed(() => [...new Set(store.investigations.map((i) => i.typology).filter(Boolean) as string[])].sort());
const assignees = computed(() => [...new Set(store.investigations.map(responsible))].sort());

const SORTERS: Record<SortKey, (inv: Investigation) => string | number> = {
  title: (i) => i.title.toLowerCase(),
  typology: (i) => (i.typology ?? '').toLowerCase(),
  source_count: (i) => i.source_count ?? 0,
  status: (i) => ['selecao', 'analise', 'decidido', 'arquivado'].indexOf(i.status),
  assignee: (i) => responsible(i).toLowerCase(),
  deadline: (i) => deadlineOf(i)?.daysLeft ?? Number.POSITIVE_INFINITY,
  updated_at: (i) => i.updated_at ?? '',
};

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  const rows = store.investigations.filter((inv) => {
    const f = statusFilter.value;
    if (f === 'open' && (inv.status === 'decidido' || inv.status === 'arquivado')) return false;
    if (f === 'urgent' && !isUrgent(inv)) return false;
    if (f !== 'open' && f !== 'all' && f !== 'urgent' && inv.status !== f) return false;
    if (typologyFilter.value && inv.typology !== typologyFilter.value) return false;
    if (assigneeFilter.value && responsible(inv) !== assigneeFilter.value) return false;
    if (!q) return true;
    return [inv.title, inv.typology, inv.origin, inv.assignee_email, inv.owner_email, inv.id]
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
    sortDir.value = key === 'updated_at' || key === 'source_count' ? -1 : 1;
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
    analise: all.filter((i) => i.status === 'analise').length,
    selecao: all.filter((i) => i.status === 'selecao').length,
    urgent: all.filter(isUrgent).length,
    decided: all.filter((i) => i.status === 'decidido').length,
  };
});

/** "shared" when the case is someone else's; "read-only" when it cannot be changed. */
function accessMark(inv: Investigation): string | null {
  if (inv.owner_email === authStore.email) return null;
  return inv.has_write_access ? 'shared with you' : 'read-only';
}

/** Share of the phase already used, for the deadline bar. */
function elapsed(inv: Investigation) {
  const d = deadlineOf(inv);
  return d ? Math.min(100, Math.max(0, ((PHASE_DAYS - d.daysLeft) / PHASE_DAYS) * 100)) : 0;
}

function who(email?: string | null) {
  if (!email) return '—';
  return email === authStore.email ? 'you' : email;
}

function updated(inv: Investigation) {
  return inv.updated_at ? new Date(inv.updated_at).toLocaleDateString() : '—';
}

// New investigation
const showCreate = ref(false);
const form = ref({ title: '', typology: '', origin: '', assignee_email: '' });
const creating = ref(false);

function openCreate() {
  form.value = { title: '', typology: '', origin: '', assignee_email: '' };
  showCreate.value = true;
}

async function create() {
  const title = form.value.title.trim();
  if (!title || creating.value) return;
  creating.value = true;
  try {
    const inv = await store.createInvestigation({
      title,
      typology: form.value.typology.trim() || undefined,
      origin: form.value.origin.trim() || undefined,
      assignee_email: form.value.assignee_email.trim() || undefined,
    });
    showCreate.value = false;
    router.push(`/investigations/${inv.id}`);
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to create investigation'));
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="container">
    <div class="page-header">
      <h1>Investigations</h1>
      <button
        v-if="can('investigation.create')"
        class="btn btn-primary"
        data-testid="new-investigation-btn"
        @click="openCreate"
      >
        + New investigation
      </button>
    </div>

    <div class="card filter-card">
      <div class="filter-row">
        <div class="form-group search-group">
          <label for="inv-search">Search</label>
          <input
            id="inv-search"
            v-model="search"
            class="form-control"
            placeholder="case, typology, assignee…"
            data-testid="investigations-search"
          />
        </div>
        <div class="form-group">
          <label for="inv-status">Status</label>
          <select id="inv-status" v-model="statusFilter" class="form-control" data-testid="investigations-status">
            <option value="open">Open</option>
            <option value="all">All</option>
            <option value="urgent">Deadline under {{ URGENT_DAYS }} days</option>
            <option v-for="(label, key) in STATUS_LABELS" :key="key" :value="key">{{ label }}</option>
          </select>
        </div>
        <div class="form-group">
          <label for="inv-typology">Typology</label>
          <select id="inv-typology" v-model="typologyFilter" class="form-control" data-testid="investigations-typology">
            <option value="">All</option>
            <option v-for="t in typologies" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>
        <div class="form-group">
          <label for="inv-assignee">Assignee</label>
          <select id="inv-assignee" v-model="assigneeFilter" class="form-control" data-testid="investigations-assignee">
            <option value="">Anyone</option>
            <option v-for="a in assignees" :key="a" :value="a">{{ who(a) }}</option>
          </select>
        </div>
      </div>
    </div>

    <div class="counters">
      <button class="card counter" :class="{ on: statusFilter === 'analise' }" data-testid="counter-analise" @click="toggleCounter('analise')">
        <strong>{{ counters.analise }}</strong><span>in analysis</span>
      </button>
      <button class="card counter" :class="{ on: statusFilter === 'selecao' }" data-testid="counter-selecao" @click="toggleCounter('selecao')">
        <strong>{{ counters.selecao }}</strong><span>awaiting selection</span>
      </button>
      <button
        class="card counter"
        :class="{ warn: counters.urgent > 0, on: statusFilter === 'urgent' }"
        data-testid="counter-urgent"
        @click="toggleCounter('urgent')"
      >
        <strong>{{ counters.urgent }}</strong><span>deadline in under 7 days</span>
      </button>
      <button class="card counter" :class="{ on: statusFilter === 'decidido' }" data-testid="counter-decided" @click="toggleCounter('decidido')">
        <strong>{{ counters.decided }}</strong><span>decided</span>
      </button>
    </div>

    <div v-if="store.loading" class="loading"></div>
    <div v-else-if="store.error" class="error-message">{{ store.error }}</div>
    <div v-else-if="store.investigations.length === 0" class="empty-state card" data-testid="investigations-empty">
      <h3>No investigations</h3>
      <p v-if="can('investigation.create')">Create a case, then add explorations from any context to it.</p>
      <p v-else>Cases shared with you or assigned to you appear here.</p>
    </div>
    <div v-else class="card table-card">
      <table class="queue" data-testid="investigations-table">
        <thead>
          <tr>
            <th><button class="sort" data-testid="sort-title" @click="sortBy('title')">Case{{ sortMark('title') }}</button></th>
            <th><button class="sort" @click="sortBy('typology')">Typology{{ sortMark('typology') }}</button></th>
            <th><button class="sort" @click="sortBy('source_count')">Sources{{ sortMark('source_count') }}</button></th>
            <th><button class="sort" @click="sortBy('status')">Status{{ sortMark('status') }}</button></th>
            <th><button class="sort" @click="sortBy('assignee')">Assignee{{ sortMark('assignee') }}</button></th>
            <th><button class="sort" data-testid="sort-deadline" @click="sortBy('deadline')">Deadline{{ sortMark('deadline') }}</button></th>
            <th><button class="sort" @click="sortBy('updated_at')">Updated{{ sortMark('updated_at') }}</button></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="inv in filtered" :key="inv.id" :data-testid="`investigation-row-${inv.id}`">
            <td>
              <RouterLink :to="`/investigations/${inv.id}`" class="case-title">{{ inv.title }}</RouterLink>
              <span v-if="accessMark(inv)" class="pill access" data-testid="access-mark">{{ accessMark(inv) }}</span>
              <div class="muted">{{ caseNumber(inv.id) }}<template v-if="inv.origin"> · origin: {{ inv.origin }}</template></div>
            </td>
            <td><span v-if="inv.typology" class="pill">{{ inv.typology }}</span></td>
            <td>{{ inv.source_count ?? 0 }} source{{ inv.source_count === 1 ? '' : 's' }}</td>
            <td><span class="status" :class="`status-${inv.status}`">{{ STATUS_LABELS[inv.status] ?? inv.status }}</span></td>
            <td>{{ who(responsible(inv)) }}</td>
            <td>
              <template v-if="deadlineOf(inv)">
                <span :class="{ late: deadlineOf(inv)!.daysLeft < URGENT_DAYS }" data-testid="deadline">
                  {{ deadlineOf(inv)!.phase }} · {{ deadlineOf(inv)!.daysLeft }} d left
                </span>
                <div class="bar" :class="{ late: deadlineOf(inv)!.daysLeft < URGENT_DAYS }">
                  <span :style="{ width: `${elapsed(inv)}%` }"></span>
                </div>
              </template>
              <span v-else class="muted">—</span>
            </td>
            <td class="muted">{{ updated(inv) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="filtered.length === 0" class="muted no-match">No case matches the filters.</p>
    </div>

    <div v-if="showCreate" class="modal-overlay" @click.self="showCreate = false">
      <div class="modal">
        <div class="modal-header">
          <h2>New investigation</h2>
          <button class="modal-close" aria-label="Close" @click="showCreate = false">&times;</button>
        </div>
        <form @submit.prevent="create">
          <div class="form-group">
            <label for="new-inv-title">Title</label>
            <input id="new-inv-title" v-model="form.title" class="form-control" data-testid="new-investigation-title" required />
          </div>
          <div class="form-group">
            <label for="new-inv-typology">Typology</label>
            <input id="new-inv-typology" v-model="form.typology" class="form-control" placeholder="Golpe Pix" />
          </div>
          <div class="form-group">
            <label for="new-inv-origin">Origin</label>
            <input id="new-inv-origin" v-model="form.origin" class="form-control" placeholder="monitoring, MED notice, court order…" />
          </div>
          <div class="form-group">
            <label for="new-inv-assignee">Assignee e-mail</label>
            <input id="new-inv-assignee" v-model="form.assignee_email" type="email" class="form-control" placeholder="you, if empty" />
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline" @click="showCreate = false">Cancel</button>
            <button
              type="submit"
              class="btn btn-primary"
              data-testid="new-investigation-submit"
              :disabled="creating || !form.title.trim()"
            >
              Create
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
  border-color: #c2410c;
  color: #c2410c;
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

.status-analise {
  background: #e0e7ff;
  color: #3730a3;
  font-weight: 600;
}

.status-decidido {
  background: #ccfbf1;
  color: #115e59;
}

.late {
  color: #c2410c;
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
  background: #0f766e;
}

.bar.late span {
  background: #c2410c;
}

.no-match {
  padding: 12px 14px;
}
</style>
