<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAdminStore } from '@/stores/admin';
import { usePersistence } from '@/composables/usePersistence';
import { useToast } from '@/composables/useToast';
import TransferOwnershipModal from '@/components/admin/TransferOwnershipModal.vue';
import GroupsPanel from '@/components/admin/GroupsPanel.vue';
import PermissionsMatrix from '@/components/admin/PermissionsMatrix.vue';
import PermissionInspector from '@/components/admin/PermissionInspector.vue';
import {
  CLEAR_CONFIRMATION,
  canClearEnvironment,
  describeAudit,
  filterConfig,
  filterContexts,
  filterExplorations,
  flagEntries,
  formatConfigValue,
  formatRelative,
  isIdleUser,
  sortUsers,
} from '@/utils/adminView';
import type { AdminTab } from '@/types/admin';
import type { Exploration, GraphContext } from '@/types/graph';
import { confirmAction } from '@/composables/useConfirm';

/**
 * Admin area — superuser only. The router guard hides it from everyone else;
 * the backend rejects every /api/admin/* call from a non-superuser regardless.
 * Shows the environment and fixes ownership; it does not edit settings.
 */

const router = useRouter();
const admin = useAdminStore();
const toast = useToast();
const { devMode } = usePersistence();

const TABS: Array<{ id: AdminTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'config', label: 'Config' },
  { id: 'users', label: 'Users' },
  { id: 'contexts', label: 'Contexts' },
  { id: 'explorations', label: 'Explorations' },
  { id: 'groups', label: 'Groups & permissions' },
  { id: 'audit', label: 'Audit' },
  { id: 'danger', label: 'Danger zone' },
];
const visibleTabs = computed(() => TABS.filter((t) => t.id !== 'danger' || devMode.value));

const tab = ref<AdminTab>('overview');
const loaded = ref<Set<AdminTab>>(new Set());

async function loadTab(id: AdminTab, force = false) {
  if (!force && loaded.value.has(id)) return;
  loaded.value.add(id);
  switch (id) {
    case 'overview':
      await admin.fetchOverview();
      break;
    case 'config':
      await admin.fetchConfig();
      break;
    case 'users':
      await admin.fetchUsers({ q: userQuery.value || undefined, page_size: 200 });
      break;
    case 'contexts':
      await Promise.all([admin.fetchContexts(), admin.fetchUsers({ page_size: 200 })]);
      break;
    case 'explorations':
      await Promise.all([admin.fetchExplorations(), admin.fetchContexts(), admin.fetchUsers({ page_size: 200 })]);
      break;
    case 'groups':
      // Users feed the member/inspector datalists; permissions feed the
      // matrix and the per-group rule counts.
      await Promise.all([
        admin.fetchGroups(),
        admin.fetchPermissions(),
        admin.fetchUsers({ page_size: 200 }),
      ]);
      break;
    case 'audit':
      await admin.fetchAudit({ page: auditPage.value, page_size: AUDIT_PAGE_SIZE, ...auditFilters.value });
      break;
    default:
      break;
  }
}

function selectTab(id: AdminTab) {
  tab.value = id;
  void loadTab(id);
}

onMounted(() => loadTab('overview'));

// --- Overview ---------------------------------------------------------------

const flags = computed(() => flagEntries(admin.overview));
const datasourceTypes = computed(() => {
  const ds = admin.overview?.public_config?.datasources as Record<string, boolean> | undefined;
  return ds ? Object.entries(ds) : [];
});
const connections = computed(
  () => (admin.overview?.public_config?.datasource_connections as Array<{ name: string; label?: string }>) || [],
);
const shareDomains = computed(() => (admin.overview?.public_config?.allowed_share_domains as string[]) || []);

// --- Config -----------------------------------------------------------------

const configQuery = ref('');
const filteredConfig = computed(() => filterConfig(admin.config, configQuery.value));

// --- Users ------------------------------------------------------------------

const userQuery = ref('');
const sortedUsers = computed(() => sortUsers(admin.users));
let userSearchTimer: ReturnType<typeof setTimeout> | undefined;
watch(userQuery, () => {
  clearTimeout(userSearchTimer);
  userSearchTimer = setTimeout(() => loadTab('users', true), 250);
});
const knownEmails = computed(() => admin.users.map((u) => u.email));

/** Clicking a user drills into their contexts / explorations. */
const ownerFilter = ref<string | null>(null);
function showResourcesOf(email: string, target: 'contexts' | 'explorations') {
  ownerFilter.value = email;
  selectTab(target);
}

// --- Contexts / explorations ------------------------------------------------

const resourceQuery = ref('');
const contextTitles = computed(() => new Map(admin.contexts.map((c) => [c.id, c.title])));
const filteredContexts = computed(() =>
  filterContexts(admin.contexts, { owner: ownerFilter.value, query: resourceQuery.value }),
);
const filteredExplorations = computed(() =>
  filterExplorations(admin.explorations, contextTitles.value, {
    owner: ownerFilter.value,
    query: resourceQuery.value,
  }),
);

async function removeContext(ctx: GraphContext) {
  const ok = await confirmAction({
    title: `Delete context “${ctx.title}”?`,
    message: `Owned by ${ctx.owner_email}. This also deletes its explorations.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  if (await admin.deleteContext(ctx.id)) toast.success(`Deleted "${ctx.title}"`);
  else toast.error(admin.error || 'Delete failed');
}

async function removeExploration(exp: Exploration) {
  const ok = await confirmAction({
    title: `Delete exploration “${exp.title}”?`,
    message: `Owned by ${exp.owner_email}.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  if (await admin.deleteExploration(exp.id)) toast.success(`Deleted "${exp.title}"`);
  else toast.error(admin.error || 'Delete failed');
}

// --- Transfer ---------------------------------------------------------------

const transferTarget = ref<{ kind: 'context' | 'exploration'; id: string; title: string; owner: string } | null>(null);

function openTransfer(kind: 'context' | 'exploration', item: GraphContext | Exploration) {
  transferTarget.value = { kind, id: item.id, title: item.title, owner: item.owner_email };
}

async function confirmTransfer(newOwner: string) {
  const target = transferTarget.value;
  if (!target) return;
  const ok =
    target.kind === 'context'
      ? await admin.transferContext(target.id, newOwner)
      : await admin.transferExploration(target.id, newOwner);
  if (ok) {
    toast.success(`"${target.title}" now belongs to ${newOwner}`);
    transferTarget.value = null;
    loaded.value.delete('users');
    loaded.value.delete('audit');
  } else {
    toast.error(admin.error || 'Transfer failed');
  }
}

// --- Audit ------------------------------------------------------------------

const AUDIT_PAGE_SIZE = 50;
const auditPage = ref(1);
const auditFilters = ref<{ user?: string; action?: string }>({});
const auditUser = ref('');
const auditAction = ref('');
const auditPages = computed(() => Math.max(1, Math.ceil(admin.auditTotal / AUDIT_PAGE_SIZE)));

function applyAuditFilters() {
  auditFilters.value = {
    user: auditUser.value.trim() || undefined,
    action: auditAction.value || undefined,
  };
  auditPage.value = 1;
  void loadTab('audit', true);
}
function goAuditPage(delta: number) {
  auditPage.value = Math.min(auditPages.value, Math.max(1, auditPage.value + delta));
  void loadTab('audit', true);
}

// --- Danger zone ------------------------------------------------------------

const clearInput = ref('');
const clearBusy = ref(false);
const canClear = computed(() => canClearEnvironment(clearInput.value, devMode.value) && !clearBusy.value);

async function clearEnvironment() {
  if (!canClear.value) return;
  clearBusy.value = true;
  try {
    if (await admin.clearEnvironment(clearInput.value)) {
      toast.success('Environment cleared');
      clearInput.value = '';
      loaded.value.clear();
      tab.value = 'overview';
      await loadTab('overview', true);
    } else {
      toast.error(admin.error || 'Clear failed');
    }
  } finally {
    clearBusy.value = false;
  }
}

function openGraph(id: string) {
  router.push(`/graph/${id}`);
}
</script>

<template>
  <div class="container admin-view" data-testid="admin-view">
    <div class="page-header">
      <h1>Admin</h1>
      <span class="admin-subtitle">Environment, users, ownership and audit — superusers only</span>
    </div>

    <div v-if="devMode" class="dev-banner" data-testid="admin-dev-banner">
      <strong>Dev mode.</strong> Identity is chosen by the client (login page), so this area is
      not a security boundary here. In production the proxy supplies the identity and only
      <code>GRAPH_LAGOON_SUPERUSER_EMAILS</code> reach it.
    </div>

    <nav class="admin-tabs" role="tablist">
      <button
        v-for="t in visibleTabs"
        :key="t.id"
        type="button"
        role="tab"
        class="admin-tab"
        :class="{ active: tab === t.id, danger: t.id === 'danger' }"
        :aria-selected="tab === t.id"
        :data-testid="`admin-tab-${t.id}`"
        @click="selectTab(t.id)"
      >
        {{ t.label }}
      </button>
    </nav>

    <div v-if="admin.error" class="error-message" data-testid="admin-error">{{ admin.error }}</div>

    <!-- Overview -->
    <section v-if="tab === 'overview'" class="tab-panel" data-testid="admin-overview">
      <div v-if="admin.loading.overview && !admin.overview" class="loading"></div>
      <template v-else-if="admin.overview">
        <div class="cards-grid">
          <div class="card stat-card">
            <h3>Environment</h3>
            <dl>
              <dt>Version</dt><dd>{{ admin.overview.version }}</dd>
              <dt>Mode</dt>
              <dd>
                <span class="badge" :class="admin.overview.dev_mode ? 'badge-warning' : 'badge-primary'">
                  {{ admin.overview.dev_mode ? 'dev' : 'production' }}
                </span>
                <span v-if="admin.overview.databricks_mode" class="badge badge-secondary">databricks</span>
              </dd>
              <dt>Persistence</dt>
              <dd>
                <code data-testid="admin-persistence">{{ admin.overview.persistence_backend }}</code>
                <span v-if="admin.overview.alembic_version" class="muted"> · migration {{ admin.overview.alembic_version }}</span>
              </dd>
              <dt>Database</dt>
              <dd>
                <span class="health" :data-status="admin.overview.health.database?.status">
                  {{ admin.overview.health.database?.status }}
                </span>
                <span v-if="admin.overview.health.database?.latency_ms != null" class="muted">
                  {{ admin.overview.health.database?.latency_ms }} ms
                </span>
              </dd>
              <dt>Warehouse</dt>
              <dd>
                <span v-if="admin.warehouseHealth" class="health" :data-status="admin.warehouseHealth.status">
                  {{ admin.warehouseHealth.status }}
                  <span v-if="admin.warehouseHealth.latency_ms != null" class="muted">{{ admin.warehouseHealth.latency_ms }} ms</span>
                  <span v-if="admin.warehouseHealth.detail" class="muted"> · {{ admin.warehouseHealth.detail }}</span>
                </span>
                <button
                  type="button"
                  class="btn btn-outline btn-sm"
                  data-testid="admin-probe-warehouse"
                  :disabled="admin.loading.warehouse"
                  title="On demand: probing can wake a stopped SQL warehouse"
                  @click="admin.probeWarehouse()"
                >
                  {{ admin.loading.warehouse ? 'Probing…' : 'Probe warehouse' }}
                </button>
              </dd>
            </dl>
          </div>

          <div class="card stat-card">
            <h3>Counts</h3>
            <div class="counts" data-testid="admin-counts">
              <div><span class="count">{{ admin.overview.counts.users }}</span><span>users</span></div>
              <div><span class="count">{{ admin.overview.counts.contexts }}</span><span>contexts</span></div>
              <div><span class="count">{{ admin.overview.counts.explorations }}</span><span>explorations</span></div>
              <div><span class="count">{{ admin.overview.counts.query_templates }}</span><span>templates</span></div>
              <div><span class="count">{{ admin.overview.counts.audit_entries }}</span><span>audit entries</span></div>
            </div>
          </div>

          <div class="card stat-card">
            <h3>Superusers</h3>
            <ul class="plain-list" data-testid="admin-superusers">
              <li v-for="email in admin.overview.superusers" :key="email"><code>{{ email }}</code></li>
              <li v-if="admin.overview.superusers.length === 0" class="muted">none configured</li>
            </ul>
            <p class="hint">Set by <code>GRAPH_LAGOON_SUPERUSER_EMAILS</code>; restart to apply changes.</p>
            <h4>Share domains</h4>
            <p v-if="shareDomains.length === 0" class="muted">no wildcard domains allowed</p>
            <p v-else><code v-for="d in shareDomains" :key="d" class="chip">*@{{ d }}</code></p>
          </div>

          <div class="card stat-card">
            <h3>Storage</h3>
            <dl>
              <dt>Snapshots</dt><dd><code>{{ admin.overview.storage.exploration_snapshots }}</code></dd>
              <dt>Precomputed graphs</dt><dd><code>{{ admin.overview.storage.precomputed_graphs }}</code></dd>
              <dt>Style presets</dt><dd><code>{{ admin.overview.storage.style_presets }}</code></dd>
            </dl>
          </div>

          <div class="card stat-card">
            <h3>Feature flags</h3>
            <ul class="plain-list" data-testid="admin-flags">
              <li v-for="f in flags" :key="f.key">
                <span class="flag-dot" :class="{ on: f.value }"></span><code>{{ f.key }}</code>
              </li>
            </ul>
          </div>

          <div class="card stat-card">
            <h3>Datasources</h3>
            <ul class="plain-list">
              <li v-for="[name, on] in datasourceTypes" :key="name">
                <span class="flag-dot" :class="{ on }"></span><code>{{ name }}</code>
              </li>
            </ul>
            <template v-if="connections.length">
              <h4>REST connections</h4>
              <ul class="plain-list">
                <li v-for="c in connections" :key="c.name"><code>{{ c.name }}</code> <span class="muted">{{ c.label }}</span></li>
              </ul>
            </template>
          </div>
        </div>
      </template>
    </section>

    <!-- Config -->
    <section v-else-if="tab === 'config'" class="tab-panel" data-testid="admin-config">
      <div class="search-bar card">
        <input v-model="configQuery" type="text" class="form-control" placeholder="Filter settings…" data-testid="admin-config-search" />
        <span class="muted">{{ filteredConfig.length }} of {{ admin.config.length }}</span>
      </div>
      <div v-if="admin.loading.config && admin.config.length === 0" class="loading"></div>
      <div v-else class="card table-card">
        <table class="admin-table">
          <thead><tr><th>Setting</th><th>Env var</th><th>Value</th></tr></thead>
          <tbody>
            <tr v-for="e in filteredConfig" :key="e.key" :data-kind="e.kind">
              <td><code>{{ e.key }}</code></td>
              <td class="muted"><code>{{ e.env_var }}</code></td>
              <td>
                <span v-if="e.kind === 'secret'" class="badge" :class="e.value === 'set' ? 'badge-primary' : 'badge-secondary'">
                  {{ e.value }}
                </span>
                <span v-else class="value">{{ formatConfigValue(e) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="hint">Settings are read at start-up; secrets are shown only as set / not set. Edit the environment and restart to change them.</p>
      </div>
    </section>

    <!-- Users -->
    <section v-else-if="tab === 'users'" class="tab-panel" data-testid="admin-users">
      <div class="search-bar card">
        <input v-model="userQuery" type="text" class="form-control" placeholder="Search users…" data-testid="admin-users-search" />
        <span class="muted">{{ admin.usersTotal }} users</span>
      </div>
      <div v-if="admin.loading.users && admin.users.length === 0" class="loading"></div>
      <div v-else-if="sortedUsers.length === 0" class="empty-state card"><h3>No users</h3><p>Users appear after their first request.</p></div>
      <div v-else class="card" data-testid="admin-users-list">
        <div v-for="u in sortedUsers" :key="u.email" class="list-item" :data-email="u.email">
          <div class="list-item-content">
            <div class="list-item-title">
              {{ u.email }}
              <span v-if="u.is_superuser" class="badge badge-warning" data-testid="admin-superuser-badge">superuser</span>
              <span v-else-if="isIdleUser(u)" class="badge badge-secondary">owns nothing</span>
            </div>
            <div class="list-item-subtitle">
              {{ u.display_name }} · last seen {{ formatRelative(u.last_seen_at) }} · joined {{ formatRelative(u.created_at) }}
            </div>
          </div>
          <div class="list-item-actions">
            <button type="button" class="btn btn-outline btn-sm" @click="showResourcesOf(u.email, 'contexts')">
              {{ u.contexts_owned }} contexts
            </button>
            <button type="button" class="btn btn-outline btn-sm" @click="showResourcesOf(u.email, 'explorations')">
              {{ u.explorations_owned }} explorations
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Contexts -->
    <section v-else-if="tab === 'contexts'" class="tab-panel" data-testid="admin-contexts">
      <div class="search-bar card">
        <input v-model="resourceQuery" type="text" class="form-control" placeholder="Search contexts…" data-testid="admin-contexts-search" />
        <span v-if="ownerFilter" class="chip owner-chip">
          owner: {{ ownerFilter }} <button type="button" class="chip-close" aria-label="Clear owner filter" @click="ownerFilter = null">&times;</button>
        </span>
        <span class="muted">{{ filteredContexts.length }} of {{ admin.contexts.length }}</span>
      </div>
      <div v-if="admin.loading.contexts && admin.contexts.length === 0" class="loading"></div>
      <div v-else-if="filteredContexts.length === 0" class="empty-state card"><h3>No contexts</h3></div>
      <div v-else class="card" data-testid="admin-contexts-list">
        <div v-for="ctx in filteredContexts" :key="ctx.id" class="list-item" :data-context-id="ctx.id">
          <div class="list-item-content">
            <div class="list-item-title">{{ ctx.title }}</div>
            <div class="list-item-subtitle">
              owner <code>{{ ctx.owner_email }}</code>
              · {{ ctx.datasource_type || 'sql_warehouse' }}
              · {{ ctx.shared_with?.length || 0 }} shares
              · updated {{ formatRelative(ctx.updated_at) }}
            </div>
          </div>
          <div class="list-item-actions">
            <button type="button" class="btn btn-outline btn-sm" @click="openGraph(ctx.id)">Open</button>
            <button type="button" class="btn btn-secondary btn-sm" data-testid="admin-transfer-btn" @click="openTransfer('context', ctx)">Transfer</button>
            <button type="button" class="btn btn-danger btn-sm" data-testid="admin-delete-context-btn" @click="removeContext(ctx)">Delete</button>
          </div>
        </div>
      </div>
    </section>

    <!-- Explorations -->
    <section v-else-if="tab === 'explorations'" class="tab-panel" data-testid="admin-explorations">
      <div class="search-bar card">
        <input v-model="resourceQuery" type="text" class="form-control" placeholder="Search explorations…" data-testid="admin-explorations-search" />
        <span v-if="ownerFilter" class="chip owner-chip">
          owner: {{ ownerFilter }} <button type="button" class="chip-close" aria-label="Clear owner filter" @click="ownerFilter = null">&times;</button>
        </span>
        <span class="muted">{{ filteredExplorations.length }} of {{ admin.explorations.length }}</span>
      </div>
      <div v-if="admin.loading.explorations && admin.explorations.length === 0" class="loading"></div>
      <div v-else-if="filteredExplorations.length === 0" class="empty-state card"><h3>No explorations</h3></div>
      <div v-else class="card" data-testid="admin-explorations-list">
        <div v-for="exp in filteredExplorations" :key="exp.id" class="list-item" :data-exploration-id="exp.id">
          <div class="list-item-content">
            <div class="list-item-title">{{ exp.title }}</div>
            <div class="list-item-subtitle">
              in {{ contextTitles.get(exp.graph_context_id) || exp.graph_context_id }}
              · owner <code>{{ exp.owner_email }}</code>
              · {{ exp.shared_with?.length || 0 }} shares
              · updated {{ formatRelative(exp.updated_at) }}
            </div>
          </div>
          <div class="list-item-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-testid="admin-transfer-exploration-btn" @click="openTransfer('exploration', exp)">Transfer</button>
            <button type="button" class="btn btn-danger btn-sm" @click="removeExploration(exp)">Delete</button>
          </div>
        </div>
      </div>
    </section>

    <!-- Groups & permissions -->
    <section v-else-if="tab === 'groups'" class="tab-panel" data-testid="admin-groups">
      <GroupsPanel />
      <PermissionsMatrix />
      <PermissionInspector />
    </section>

    <!-- Audit -->
    <section v-else-if="tab === 'audit'" class="tab-panel" data-testid="admin-audit">
      <div class="search-bar card audit-filters">
        <input v-model="auditUser" type="text" class="form-control" placeholder="Filter by user e-mail" data-testid="admin-audit-user" @keyup.enter="applyAuditFilters" />
        <select v-model="auditAction" class="form-control" data-testid="admin-audit-action" @change="applyAuditFilters">
          <option value="">All actions</option>
          <option v-for="a in admin.auditActions" :key="a" :value="a">{{ a }}</option>
        </select>
        <button type="button" class="btn btn-outline" @click="applyAuditFilters">Apply</button>
        <span class="muted">{{ admin.auditTotal }} entries</span>
      </div>
      <div v-if="admin.loading.audit && admin.audit.length === 0" class="loading"></div>
      <div v-else-if="admin.audit.length === 0" class="empty-state card"><h3>No audit entries</h3><p>Deletes, shares, transfers and publishes land here.</p></div>
      <div v-else class="card table-card">
        <table class="admin-table" data-testid="admin-audit-table">
          <thead><tr><th>When</th><th>User</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            <tr v-for="e in admin.audit" :key="e.id">
              <td class="muted nowrap" :title="e.created_at || ''">{{ formatRelative(e.created_at) }}</td>
              <td><code>{{ e.user_email }}</code></td>
              <td><span class="badge badge-secondary">{{ e.action }}</span></td>
              <td>{{ describeAudit(e) }}</td>
            </tr>
          </tbody>
        </table>
        <div class="pager">
          <button type="button" class="btn btn-outline btn-sm" :disabled="auditPage <= 1" @click="goAuditPage(-1)">‹ Newer</button>
          <span class="muted">page {{ auditPage }} / {{ auditPages }}</span>
          <button type="button" class="btn btn-outline btn-sm" :disabled="auditPage >= auditPages" @click="goAuditPage(1)">Older ›</button>
        </div>
      </div>
    </section>

    <!-- Danger zone -->
    <section v-else-if="tab === 'danger' && devMode" class="tab-panel" data-testid="admin-danger">
      <div class="card danger-zone">
        <h2>Clear environment</h2>
        <p class="hint">
          Deletes every context, exploration, share, query template and user, plus the generated
          warehouse tables. The audit trail is kept. Dev mode only; irreversible.
        </p>
        <div class="form-group">
          <label for="admin-clear-confirm">Type <code>{{ CLEAR_CONFIRMATION }}</code> to enable the button</label>
          <input id="admin-clear-confirm" v-model="clearInput" type="text" class="form-control" data-testid="admin-clear-input" autocomplete="off" />
        </div>
        <button type="button" class="btn btn-danger" data-testid="admin-clear-env" :disabled="!canClear" @click="clearEnvironment">
          {{ clearBusy ? 'Clearing…' : 'Clear environment' }}
        </button>
      </div>
    </section>

    <TransferOwnershipModal
      :open="transferTarget !== null"
      :kind="transferTarget?.kind || 'context'"
      :title="transferTarget?.title || ''"
      :current-owner="transferTarget?.owner || ''"
      :busy="admin.loading.transfer"
      :suggestions="knownEmails"
      @close="transferTarget = null"
      @confirm="confirmTransfer"
    />
  </div>
</template>

<style scoped>
.admin-subtitle { color: var(--text-secondary); font-size: var(--text-sm, 0.875rem); }
.dev-banner {
  background: #fef3c7; color: #78350f; border: 1px solid #fcd34d;
  border-radius: var(--radius-md, 6px); padding: var(--space-3, 12px) var(--space-4, 16px);
  margin-bottom: var(--space-4, 16px); font-size: var(--text-sm, 0.875rem);
}
.admin-tabs { display: flex; gap: var(--space-1, 4px); border-bottom: 1px solid var(--border-color, #e5e7eb); margin-bottom: var(--space-4, 16px); flex-wrap: wrap; }
.admin-tab {
  background: none; border: none; border-bottom: 2px solid transparent; padding: var(--space-2, 8px) var(--space-3, 12px);
  cursor: pointer; color: var(--text-secondary); font-weight: var(--font-medium, 500);
}
.admin-tab.active { color: var(--color-primary); border-bottom-color: var(--color-primary); }
.admin-tab.danger { color: var(--color-danger, #b91c1c); }
.cards-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-4, 16px); }
.stat-card h3 { margin: 0 0 var(--space-3, 12px); font-size: var(--text-base, 1rem); }
.stat-card h4 { margin: var(--space-3, 12px) 0 var(--space-2, 8px); font-size: var(--text-sm, 0.875rem); color: var(--text-secondary); }
.stat-card dl { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-2, 8px) var(--space-3, 12px); margin: 0; }
.stat-card dt { color: var(--text-secondary); font-size: var(--text-sm, 0.875rem); }
.stat-card dd { margin: 0; display: flex; gap: var(--space-2, 8px); align-items: center; flex-wrap: wrap; overflow-wrap: anywhere; }
.counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: var(--space-3, 12px); }
.counts > div { display: flex; flex-direction: column; align-items: center; }
.count { font-size: 1.6rem; font-weight: var(--font-semibold, 600); color: var(--color-primary); }
.plain-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-1, 4px); }
.flag-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #d1d5db; margin-right: var(--space-2, 8px); }
.flag-dot.on { background: #16a34a; }
.health { font-weight: var(--font-medium, 500); }
.health[data-status='ok'] { color: #16a34a; }
.health[data-status='memory'] { color: var(--text-secondary); }
.health[data-status='error'], .health[data-status='timeout'], .health[data-status='misconfigured'] { color: var(--color-danger, #b91c1c); }
.muted { color: var(--text-secondary); font-size: var(--text-sm, 0.875rem); }
.hint { color: var(--text-secondary); font-size: var(--text-sm, 0.875rem); margin: var(--space-3, 12px) 0 0; }
.chip { display: inline-flex; align-items: center; gap: var(--space-1, 4px); background: var(--bg-tertiary, #f3f4f6); border-radius: 999px; padding: 2px 10px; margin-right: var(--space-1, 4px); font-size: var(--text-sm, 0.875rem); }
.chip-close { background: none; border: none; cursor: pointer; color: var(--text-secondary); font-size: 1rem; line-height: 1; }
.search-bar { display: flex; align-items: center; gap: var(--space-3, 12px); margin-bottom: var(--space-4, 16px); }
.search-bar .form-control { flex: 1; }
.audit-filters select { max-width: 240px; }
.table-card { overflow-x: auto; }
.admin-table { width: 100%; border-collapse: collapse; font-size: var(--text-sm, 0.875rem); }
.admin-table th, .admin-table td { text-align: left; padding: var(--space-2, 8px); border-bottom: 1px solid var(--border-color, #e5e7eb); vertical-align: top; }
.admin-table th { color: var(--text-secondary); font-weight: var(--font-medium, 500); }
.admin-table .value { overflow-wrap: anywhere; }
.nowrap { white-space: nowrap; }
.pager { display: flex; align-items: center; justify-content: center; gap: var(--space-3, 12px); padding-top: var(--space-3, 12px); }
.badge-warning { background: #fef3c7; color: #92400e; }
.danger-zone { border: 1px solid var(--color-danger, #b91c1c); }
.danger-zone h2 { color: var(--color-danger, #b91c1c); margin-top: 0; }
</style>
