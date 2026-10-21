<script setup lang="ts">
/**
 * The case queue (05 §2, 06 §2b): a page of cases filtered, sorted and counted
 * by the server. Counters are filters; the case type's `in_queue` fields are
 * columns (and filters once a type is chosen).
 */
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useInvestigationStore } from '@/stores/investigation';
import { useAuthStore } from '@/stores/auth';
import { usePermissions } from '@/composables/usePermissions';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import { STATUS_LABELS, caseNumber, deadlineElapsed, deadlineOf, deadlineText } from '@/utils/investigationStatus';
import { formatDate, plural } from '@/utils/format';
import { fieldText } from '@/utils/caseFields';
import type { CaseTypeField, Investigation, InvestigationStatus, QueueParams } from '@/types/investigation';

const PAGE = 50;

const router = useRouter();
const store = useInvestigationStore();
const authStore = useAuthStore();
const toast = useToast();
const { can } = usePermissions();

const search = ref('');
type StatusFilter = 'active' | 'all' | 'urgent' | 'suggested' | InvestigationStatus;
const statusFilter = ref<StatusFilter>('active');
const typeFilter = ref('');
const assigneeFilter = ref<'' | 'me'>('');
const fieldFilters = ref<Record<string, string | number>>({});
type SortKey = 'title' | 'deadline' | 'updated_at' | `field.${string}`;
const sortKey = ref<SortKey>('updated_at');
const sortDir = ref<1 | -1>(-1);
const offset = ref(0);

const chosenType = computed(() => store.caseTypes.find((t) => t.slug === typeFilter.value) ?? null);
/** Columns: the chosen type's queue fields; across types, none. */
const queueFields = computed<CaseTypeField[]>(() => chosenType.value?.fields.filter((f) => f.in_queue) ?? []);

/** A field filter as the server reads it (`gte:` for amounts and dates, `contains:` for text). */
function fieldExpr(field: CaseTypeField, value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (field.type === 'enum') return `eq:${text}`;
  if (field.type === 'text') return `contains:${text}`;
  return `gte:${text}`;
}

const params = computed<QueueParams>(() => {
  const f = statusFilter.value;
  const fields = Object.fromEntries(
    queueFields.value.map((field) => [field.id, fieldExpr(field, fieldFilters.value[field.id] ?? '')]).filter(([, e]) => e),
  );
  return {
    q: search.value.trim() || undefined,
    status: f === 'active' ? 'open,analysis' : f === 'all' || f === 'urgent' || f === 'suggested' ? undefined : f,
    deadline: f === 'urgent' ? 'urgent' : undefined,
    suggested: f === 'suggested' ? true : undefined,
    case_type: typeFilter.value || undefined,
    assignee: assigneeFilter.value === 'me' ? authStore.email ?? undefined : undefined,
    fields,
    sort: `${sortDir.value === -1 ? '-' : ''}${sortKey.value}`,
    limit: PAGE,
    offset: offset.value,
  };
});

let timer: ReturnType<typeof setTimeout> | undefined;
function load() {
  clearTimeout(timer);
  timer = setTimeout(() => store.fetchInvestigations(params.value), 250);
}
// A new filter starts again at the first page.
watch([search, statusFilter, typeFilter, assigneeFilter, fieldFilters, sortKey, sortDir], () => {
  offset.value = 0;
  load();
}, { deep: true });
watch(offset, load);
watch(typeFilter, () => {
  fieldFilters.value = {};
  if (sortKey.value.startsWith('field.')) sortKey.value = 'updated_at';
});

onMounted(() => {
  void store.fetchCaseTypes();
  void store.fetchInvestigations(params.value);
});

/** Who the row belongs to for the "Assignee" column (assignee, else owner). */
const responsible = (inv: Investigation) => inv.assignee_email ?? inv.owner_email;

function sortBy(key: SortKey) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 1 ? -1 : 1;
  else {
    sortKey.value = key;
    sortDir.value = key === 'updated_at' || (key.startsWith('field.') && queueFields.value.find((f) => `field.${f.id}` === key)?.type !== 'text') ? -1 : 1;
  }
}

const sortMark = (key: SortKey) => (sortKey.value === key ? (sortDir.value === 1 ? ' ▲' : ' ▼') : '');

/** A counter is a status filter: clicking it again goes back to "In progress". */
function toggleCounter(filter: StatusFilter) {
  statusFilter.value = statusFilter.value === filter ? 'active' : filter;
}

const counts = computed(() => store.queueCounts);
const rangeText = computed(() => {
  if (!store.queueTotal) return '';
  return `${offset.value + 1}–${Math.min(offset.value + PAGE, store.queueTotal)} of ${store.queueTotal}`;
});

/** "shared with you" when the case is someone else's; "read only" when it cannot be changed. */
function accessMark(inv: Investigation): string | null {
  if (inv.owner_email === authStore.email) return null;
  return inv.has_write_access ? 'shared with you' : 'read only';
}

function who(email?: string | null) {
  if (!email) return '—';
  return email === authStore.email ? 'you' : email;
}

function updated(inv: Investigation) {
  return inv.updated_at ? formatDate(inv.updated_at, { time: false }) : '—';
}

// New investigation
const showCreate = ref(false);
const form = ref({ title: '', case_type: 'general', assignee_email: '', fields: {} as Record<string, string> });
const creating = ref(false);
const formType = computed(() => store.caseTypes.find((t) => t.slug === form.value.case_type) ?? null);
const missingRequired = computed(() => (formType.value?.fields ?? []).some((f) => f.required && !String(form.value.fields[f.id] ?? '').trim()));

function openCreate() {
  form.value = { title: '', case_type: typeFilter.value || 'general', assignee_email: '', fields: {} };
  showCreate.value = true;
}

async function create() {
  const title = form.value.title.trim();
  if (!title || creating.value || missingRequired.value) return;
  creating.value = true;
  try {
    const fields = Object.fromEntries(Object.entries(form.value.fields).filter(([, v]) => String(v).trim() !== ''));
    const inv = await store.createInvestigation({
      title,
      case_type: form.value.case_type,
      fields,
      assignee_email: form.value.assignee_email.trim() || undefined,
    });
    showCreate.value = false;
    router.push(`/investigations/${inv.id}`);
  } catch (e) {
    toast.error(getErrorMessage(e, 'Could not create the case'));
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
        + New case
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
            placeholder="title or description…"
            data-testid="investigations-search"
          />
        </div>
        <div class="form-group">
          <label for="inv-status">Status</label>
          <select id="inv-status" v-model="statusFilter" class="form-control" data-testid="investigations-status">
            <option value="active">In progress</option>
            <option value="all">All</option>
            <option value="urgent">Deadline close</option>
            <option value="suggested">With suggestions</option>
            <option v-for="(label, key) in STATUS_LABELS" :key="key" :value="key">{{ label }}</option>
          </select>
        </div>
        <div class="form-group">
          <label for="inv-type">Type</label>
          <select id="inv-type" v-model="typeFilter" class="form-control" data-testid="investigations-type">
            <option value="">All</option>
            <option v-for="t in store.caseTypes" :key="t.slug" :value="t.slug">{{ t.label }}</option>
          </select>
        </div>
        <div class="form-group">
          <label for="inv-assignee">Assignee</label>
          <select id="inv-assignee" v-model="assigneeFilter" class="form-control" data-testid="investigations-assignee">
            <option value="">Anyone</option>
            <option value="me">Me</option>
          </select>
        </div>
      </div>
      <div v-if="queueFields.length" class="filter-row fields-row" data-testid="queue-field-filters">
        <div v-for="f in queueFields" :key="f.id" class="form-group">
          <label :for="`qf-${f.id}`">{{ f.label }}<span v-if="f.type === 'money' || f.type === 'number'" class="muted"> ≥</span><span v-else-if="f.type === 'date'" class="muted"> from</span></label>
          <select v-if="f.type === 'enum'" :id="`qf-${f.id}`" v-model="fieldFilters[f.id]" class="form-control" :data-testid="`queue-field-${f.id}`">
            <option value="">Any</option>
            <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
          </select>
          <input
            v-else
            :id="`qf-${f.id}`"
            v-model="fieldFilters[f.id]"
            :type="f.type === 'date' ? 'date' : f.type === 'text' ? 'text' : 'number'"
            class="form-control"
            :data-testid="`queue-field-${f.id}`"
          />
        </div>
      </div>
    </div>

    <div class="counters">
      <button class="card counter" :class="{ on: statusFilter === 'analysis' }" data-testid="counter-analysis" @click="toggleCounter('analysis')">
        <strong>{{ counts.analysis ?? 0 }}</strong><span>in analysis</span>
      </button>
      <button class="card counter" :class="{ on: statusFilter === 'open' }" data-testid="counter-open" @click="toggleCounter('open')">
        <strong>{{ counts.open ?? 0 }}</strong><span>open</span>
      </button>
      <button
        class="card counter"
        :class="{ warn: (counts.urgent ?? 0) > 0, on: statusFilter === 'urgent' }"
        data-testid="counter-urgent"
        @click="toggleCounter('urgent')"
      >
        <strong>{{ counts.urgent ?? 0 }}</strong><span>deadline close<template v-if="counts.overdue"> · {{ counts.overdue }} overdue</template></span>
      </button>
      <button class="card counter" :class="{ on: statusFilter === 'closed' }" data-testid="counter-closed" @click="toggleCounter('closed')">
        <strong>{{ counts.closed ?? 0 }}</strong><span>closed</span>
      </button>
      <button class="card counter" :class="{ warn: (counts.suggested ?? 0) > 0, on: statusFilter === 'suggested' }" data-testid="counter-suggested" @click="toggleCounter('suggested')">
        <strong>{{ counts.suggested ?? 0 }}</strong><span>with suggestions to review</span>
      </button>
    </div>

    <div v-if="store.error" class="error-message">{{ store.error }}</div>
    <div v-else-if="!store.loading && (counts.total ?? 0) === 0" class="empty-state card" data-testid="investigations-empty">
      <h3>No cases</h3>
      <p v-if="can('investigation.create')">Create a case and add explorations, queries and files from any context to it.</p>
      <p v-else>The cases shared with you or assigned to you show here.</p>
    </div>
    <div v-else class="card table-card" :class="{ busy: store.loading }">
      <table class="queue" data-testid="investigations-table">
        <thead>
          <tr>
            <th><button class="sort" data-testid="sort-title" @click="sortBy('title')">Case{{ sortMark('title') }}</button></th>
            <th>Type</th>
            <th v-for="f in queueFields" :key="f.id">
              <button class="sort" :data-testid="`sort-field-${f.id}`" @click="sortBy(`field.${f.id}`)">{{ f.label }}{{ sortMark(`field.${f.id}`) }}</button>
            </th>
            <th>Material</th>
            <th>Suggestions</th>
            <th>Status</th>
            <th>Assignee</th>
            <th><button class="sort" data-testid="sort-deadline" @click="sortBy('deadline')">Deadline{{ sortMark('deadline') }}</button></th>
            <th><button class="sort" @click="sortBy('updated_at')">Updated{{ sortMark('updated_at') }}</button></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="inv in store.investigations" :key="inv.id" :data-testid="`investigation-row-${inv.id}`">
            <td>
              <RouterLink :to="`/investigations/${inv.id}`" class="case-title">{{ inv.title }}</RouterLink>
              <span v-if="accessMark(inv)" class="pill access" data-testid="access-mark">{{ accessMark(inv) }}</span>
              <div class="muted">{{ caseNumber(inv.id) }}<template v-if="inv.tags?.length"> · {{ inv.tags.join(', ') }}</template></div>
            </td>
            <td><span class="pill" data-testid="row-type">{{ store.caseTypeLabel(inv.case_type) }}</span></td>
            <td v-for="f in queueFields" :key="f.id" :data-testid="`row-field-${f.id}`">{{ fieldText(f, inv.fields?.[f.id]) }}</td>
            <td>{{ plural(inv.item_count ?? 0, 'item') }}</td>
            <td>
              <span v-if="inv.suggested_count" class="pill suggested" data-testid="row-suggested">{{ plural(inv.suggested_count, 'suggestion') }}</span>
              <span v-else class="muted">—</span>
            </td>
            <td><span class="status" :class="`status-${inv.status}`">{{ STATUS_LABELS[inv.status] ?? inv.status }}</span><span v-if="inv.stage" class="stage muted" data-testid="row-stage">{{ inv.stage }}</span></td>
            <td>{{ who(responsible(inv)) }}</td>
            <td>
              <template v-if="deadlineOf(inv)">
                <span :class="{ late: deadlineOf(inv)!.urgent }" :title="`due ${formatDate(deadlineOf(inv)!.dueAt)}`" data-testid="deadline">
                  {{ deadlineText(deadlineOf(inv)!) }}
                </span>
                <div class="bar" :class="{ late: deadlineOf(inv)!.urgent }">
                  <span :style="{ width: `${deadlineElapsed(deadlineOf(inv)!)}%` }"></span>
                </div>
              </template>
              <span v-else class="muted">—</span>
            </td>
            <td class="muted">{{ updated(inv) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!store.loading && store.investigations.length === 0" class="muted no-match">No case matches the filters.</p>
      <div v-if="store.queueTotal > PAGE" class="pager" data-testid="queue-pager">
        <button class="btn btn-outline btn-sm" :disabled="offset === 0" data-testid="queue-prev" @click="offset = Math.max(0, offset - PAGE)">Previous</button>
        <span class="muted" data-testid="queue-range">{{ rangeText }}</span>
        <button class="btn btn-outline btn-sm" :disabled="offset + PAGE >= store.queueTotal" data-testid="queue-next" @click="offset += PAGE">Next</button>
      </div>
    </div>

    <div v-if="showCreate" class="modal-overlay" @click.self="showCreate = false">
      <div class="modal">
        <div class="modal-header">
          <h2>New case</h2>
          <button class="modal-close" aria-label="Close" @click="showCreate = false">&times;</button>
        </div>
        <form @submit.prevent="create">
          <div class="form-group">
            <label for="new-inv-title">Title</label>
            <input id="new-inv-title" v-model="form.title" class="form-control" data-testid="new-investigation-title" required />
          </div>
          <div class="form-group">
            <label for="new-inv-type">Type</label>
            <select id="new-inv-type" v-model="form.case_type" class="form-control" data-testid="new-investigation-type">
              <option v-for="t in store.caseTypes" :key="t.slug" :value="t.slug">{{ t.label }}</option>
              <option v-if="!store.caseTypes.length" value="general">General</option>
            </select>
            <p v-if="formType?.description" class="muted">{{ formType.description }}</p>
          </div>
          <div v-for="f in formType?.fields ?? []" :key="f.id" class="form-group">
            <label :for="`new-field-${f.id}`">{{ f.label }}<span v-if="f.required" class="required"> *</span></label>
            <select v-if="f.type === 'enum'" :id="`new-field-${f.id}`" v-model="form.fields[f.id]" class="form-control" :data-testid="`new-field-${f.id}`">
              <option value="">—</option>
              <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
            </select>
            <input
              v-else
              :id="`new-field-${f.id}`"
              v-model="form.fields[f.id]"
              :type="f.type === 'date' ? 'date' : f.type === 'text' ? 'text' : 'number'"
              step="any"
              class="form-control"
              :data-testid="`new-field-${f.id}`"
            />
          </div>
          <div class="form-group">
            <label for="new-inv-assignee">Assignee e-mail</label>
            <input id="new-inv-assignee" v-model="form.assignee_email" type="email" class="form-control" placeholder="you, when empty" />
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline" @click="showCreate = false">Cancel</button>
            <button
              type="submit"
              class="btn btn-primary"
              data-testid="new-investigation-submit"
              :disabled="creating || !form.title.trim() || missingRequired"
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

.fields-row {
  margin-top: 12px;
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

.table-card.busy {
  opacity: 0.6;
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

.status-closed {
  background: #ccfbf1;
  color: #115e59;
}

.stage {
  display: block;
  margin-top: 2px;
  font-size: 11px;
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

.pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 10px 14px;
}

.required {
  color: var(--color-danger, #b91c1c);
}

.pill.suggested {
  background: var(--color-suggested-bg);
  border: 1px solid var(--color-suggested-fg);
  color: var(--color-suggested-fg);
}
</style>
