<script setup lang="ts">
/** The case queue (T1). */
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useInvestigationStore } from '@/stores/investigation';
import { useAuthStore } from '@/stores/auth';
import { usePermissions } from '@/composables/usePermissions';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import { STATUS_LABELS, deadlineOf } from '@/utils/investigationStatus';
import type { Investigation, InvestigationStatus } from '@/types/investigation';

const router = useRouter();
const store = useInvestigationStore();
const authStore = useAuthStore();
const toast = useToast();
const { can } = usePermissions();

const search = ref('');
const statusFilter = ref<'open' | 'all' | InvestigationStatus>('open');

onMounted(() => store.fetchInvestigations());

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return store.investigations.filter((inv) => {
    if (statusFilter.value === 'open' && (inv.status === 'decidido' || inv.status === 'arquivado')) {
      return false;
    }
    if (statusFilter.value !== 'open' && statusFilter.value !== 'all' && inv.status !== statusFilter.value) {
      return false;
    }
    if (!q) return true;
    return [inv.title, inv.typology, inv.origin, inv.assignee_email, inv.id]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q);
  });
});

const counters = computed(() => {
  const all = store.investigations;
  return {
    analise: all.filter((i) => i.status === 'analise').length,
    selecao: all.filter((i) => i.status === 'selecao').length,
    urgent: all.filter((i) => {
      const d = deadlineOf(i);
      return d !== null && d.daysLeft < 7;
    }).length,
    decided: all.filter((i) => i.status === 'decidido').length,
  };
});

function who(email?: string | null) {
  if (!email) return '—';
  return email === authStore.email ? 'you' : email;
}

function caseNumber(inv: Investigation) {
  return `#${inv.id.slice(0, 8)}`;
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
            <option v-for="(label, key) in STATUS_LABELS" :key="key" :value="key">{{ label }}</option>
          </select>
        </div>
      </div>
    </div>

    <div class="counters">
      <div class="card counter"><strong>{{ counters.analise }}</strong><span>in analysis</span></div>
      <div class="card counter"><strong>{{ counters.selecao }}</strong><span>awaiting selection</span></div>
      <div class="card counter" :class="{ warn: counters.urgent > 0 }">
        <strong>{{ counters.urgent }}</strong><span>deadline in under 7 days</span>
      </div>
      <div class="card counter"><strong>{{ counters.decided }}</strong><span>decided</span></div>
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
            <th>Case</th>
            <th>Typology</th>
            <th>Sources</th>
            <th>Status</th>
            <th>Assignee</th>
            <th>Deadline</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="inv in filtered" :key="inv.id" :data-testid="`investigation-row-${inv.id}`">
            <td>
              <RouterLink :to="`/investigations/${inv.id}`" class="case-title">{{ inv.title }}</RouterLink>
              <div class="muted">{{ caseNumber(inv) }}<template v-if="inv.origin"> · origin: {{ inv.origin }}</template></div>
            </td>
            <td><span v-if="inv.typology" class="pill">{{ inv.typology }}</span></td>
            <td>{{ inv.source_count ?? 0 }} source{{ inv.source_count === 1 ? '' : 's' }}</td>
            <td><span class="status" :class="`status-${inv.status}`">{{ STATUS_LABELS[inv.status] ?? inv.status }}</span></td>
            <td>{{ who(inv.assignee_email ?? inv.owner_email) }}</td>
            <td>
              <template v-if="deadlineOf(inv)">
                <span :class="{ late: deadlineOf(inv)!.daysLeft < 7 }">
                  {{ deadlineOf(inv)!.phase }} · {{ deadlineOf(inv)!.daysLeft }} d left
                </span>
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

.no-match {
  padding: 12px 14px;
}
</style>
