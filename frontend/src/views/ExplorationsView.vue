<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useContextsStore } from '@/stores/contexts';
import { useAuthStore } from '@/stores/auth';
import { usePersistence } from '@/composables/usePersistence';
import { api } from '@/services/api';
import type { Exploration } from '@/types/graph';

const router = useRouter();
const contextsStore = useContextsStore();
const authStore = useAuthStore();
const { sharingEnabled } = usePersistence();

const explorations = ref<Exploration[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const filterContextId = ref<string>('');

// Share modal state
const showShareModal = ref(false);
const shareExploration = ref<Exploration | null>(null);
const shareForm = ref({
  email: '',
  permission: 'read' as 'read' | 'write',
});

// Allowed domains for wildcard sharing
const allowedShareDomains = computed<string[]>(
  () => window.__GRAPH_LAGOON_CONFIG__?.allowed_share_domains ?? []
);

// Search state
// TODO: For large datasets, search should be done via API for better performance
const searchQuery = ref('');

// Simple fuzzy search function - matches if query terms appear in any order
function fuzzyMatch(text: string, query: string): boolean {
  const textLower = text.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every(term => textLower.includes(term));
}

onMounted(async () => {
  await contextsStore.fetchContexts();
  await loadAllExplorations();
});

async function loadAllExplorations() {
  loading.value = true;
  error.value = null;

  try {
    explorations.value = await api.getAllExplorations();
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : 'Failed to load explorations';
    error.value = errorMessage;
  } finally {
    loading.value = false;
  }
}

// Group explorations by context
const explorationsByContext = computed(() => {
  const grouped = new Map<string, { contextTitle: string; explorations: Exploration[] }>();

  // Filter by context if selected
  let filtered = explorations.value;
  if (filterContextId.value) {
    filtered = filtered.filter(e => e.graph_context_id === filterContextId.value);
  }

  // Filter by search query
  if (searchQuery.value.trim()) {
    const query = searchQuery.value.trim();
    filtered = filtered.filter(exp => {
      const context = contextsStore.contexts.find(c => c.id === exp.graph_context_id);
      const searchableText = [
        exp.title,
        exp.owner_email,
        context?.title || '',
      ].join(' ');
      return fuzzyMatch(searchableText, query);
    });
  }

  filtered.forEach(exploration => {
    const contextId = exploration.graph_context_id;
    if (!grouped.has(contextId)) {
      const context = contextsStore.contexts.find(c => c.id === contextId);
      grouped.set(contextId, {
        contextTitle: context?.title || 'Unknown Context',
        explorations: [],
      });
    }
    grouped.get(contextId)!.explorations.push(exploration);
  });

  // Sort groups by context title
  return Array.from(grouped.entries())
    .sort((a, b) => a[1].contextTitle.localeCompare(b[1].contextTitle));
});

function openExploration(exploration: Exploration) {
  router.push({
    path: `/graph/${exploration.graph_context_id}`,
    query: { exploration: exploration.id },
  });
}

async function deleteExploration(exploration: Exploration) {
  if (!confirm(`Delete "${exploration.title}"?`)) return;

  try {
    await api.deleteExploration(exploration.id);
    explorations.value = explorations.value.filter((e) => e.id !== exploration.id);
  } catch (e) {
    console.error(e);
  }
}

function isOwner(exploration: Exploration): boolean {
  return exploration.owner_email === authStore.email;
}

function openShare(exploration: Exploration) {
  shareExploration.value = exploration;
  showShareModal.value = true;
}

async function share() {
  if (!shareExploration.value) return;

  try {
    await api.shareExploration(shareExploration.value.id, {
      email: shareForm.value.email,
      permission: shareForm.value.permission,
    });
    shareForm.value = { email: '', permission: 'read' };
    // Reload to get updated shared_with list
    await loadAllExplorations();
    // Update modal state with refreshed data
    if (shareExploration.value) {
      const updated = explorations.value.find(e => e.id === shareExploration.value!.id);
      if (updated) shareExploration.value = updated;
    }
  } catch (e) {
    console.error('Failed to share exploration:', e);
  }
}

async function unshare(explorationId: string, email: string) {
  try {
    await api.unshareExploration(explorationId, email);
    await loadAllExplorations();
    // Update modal state if still open
    if (shareExploration.value?.id === explorationId) {
      const updated = explorations.value.find(e => e.id === explorationId);
      if (updated) shareExploration.value = updated;
    }
  } catch (e) {
    console.error('Failed to unshare exploration:', e);
  }
}
</script>

<template>
  <div class="container">
    <div class="page-header">
      <h1>Explorations</h1>
      <span class="exploration-count" v-if="explorations.length > 0">
        {{ explorations.length }} exploration{{ explorations.length !== 1 ? 's' : '' }}
      </span>
    </div>

    <div class="card filter-card">
      <div class="filter-row">
        <div class="form-group search-group">
          <label>Search</label>
          <input
            v-model="searchQuery"
            type="text"
            class="form-control"
            data-testid="explorations-search"
            placeholder="Search explorations..."
          />
        </div>
        <div class="form-group">
          <label>Filter by Context</label>
          <select v-model="filterContextId" class="form-control" data-testid="explorations-context-filter">
            <option value="">All Contexts</option>
            <option v-for="ctx in contextsStore.contexts" :key="ctx.id" :value="ctx.id">
              {{ ctx.title }}
            </option>
          </select>
        </div>
      </div>
    </div>

    <div v-if="loading" class="loading"></div>

    <div v-else-if="error" class="error-message">
      {{ error }}
    </div>

    <div v-else-if="explorations.length === 0" class="empty-state card">
      <h3>No Explorations</h3>
      <p>Open a graph context and save your first exploration from the visualization</p>
      <RouterLink to="/contexts" class="btn btn-primary">
        Go to Contexts
      </RouterLink>
    </div>

    <div v-else-if="explorationsByContext.length === 0" class="empty-state card">
      <h3>No Results</h3>
      <p>No explorations match your search criteria</p>
      <button class="btn btn-outline" @click="searchQuery = ''; filterContextId = ''">
        Clear Filters
      </button>
    </div>

    <div v-else class="explorations-list">
      <div
        v-for="[contextId, group] in explorationsByContext"
        :key="contextId"
        class="context-group card"
      >
        <div class="context-header">
          <h3 class="context-title">{{ group.contextTitle }}</h3>
          <RouterLink :to="`/graph/${contextId}`" class="btn btn-outline btn-sm">
            Open Graph
          </RouterLink>
        </div>

        <div
          v-for="exploration in group.explorations"
          :key="exploration.id"
          class="list-item"
        >
          <div class="list-item-content" @click="openExploration(exploration)">
            <div class="list-item-title">{{ exploration.title }}</div>
            <div class="list-item-subtitle">
              Updated {{ new Date(exploration.updated_at).toLocaleDateString() }}
              <span v-if="!isOwner(exploration)" class="badge" :class="exploration.has_write_access ? 'badge-write' : 'badge-readonly'">
                {{ exploration.owner_email }} · {{ exploration.has_write_access ? 'Read & Write' : 'Read only' }}
              </span>
            </div>
          </div>
          <div class="list-item-actions">
            <button class="btn btn-outline btn-sm" @click="openExploration(exploration)">
              Open
            </button>
            <button
              v-if="sharingEnabled && isOwner(exploration)"
              class="btn btn-outline btn-sm"
              @click="openShare(exploration)"
            >
              Share
            </button>
            <button
              v-if="isOwner(exploration)"
              class="btn btn-danger btn-sm"
              @click="deleteExploration(exploration)"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Share Modal (only available when database is enabled) -->
    <div v-if="sharingEnabled && showShareModal" class="modal-overlay" @click.self="showShareModal = false">
      <div class="modal">
        <div class="modal-header">
          <h2>Share "{{ shareExploration?.title }}"</h2>
          <button class="modal-close" @click="showShareModal = false">&times;</button>
        </div>

        <div v-if="shareExploration?.shared_with?.length" class="shared-list">
          <h4>Currently shared with:</h4>
          <ul>
            <li v-for="email in shareExploration.shared_with" :key="email">
              <span class="shared-email">
                <span v-if="email.startsWith('*@')" class="badge badge-domain">Domain</span>
                {{ email }}
              </span>
              <button class="btn-remove" @click="unshare(shareExploration!.id, email)">&times;</button>
            </li>
          </ul>
        </div>

        <form @submit.prevent="share">
          <div class="form-group">
            <label>Email</label>
            <input
              v-model="shareForm.email"
              type="text"
              class="form-control"
              :placeholder="allowedShareDomains.length ? 'user@example.com or *@domain.com' : 'user@example.com'"
              required
            />
            <p v-if="allowedShareDomains.length" class="form-hint">
              Wildcard sharing available for: {{ allowedShareDomains.map(d => `*@${d}`).join(', ') }}
            </p>
          </div>

          <div class="form-group">
            <label>Permission</label>
            <select v-model="shareForm.permission" class="form-control">
              <option value="read">Read only</option>
              <option value="write">Read & Write</option>
            </select>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn btn-outline" @click="showShareModal = false">
              Cancel
            </button>
            <button type="submit" class="btn btn-primary">
              Share
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
  gap: 12px;
}

.exploration-count {
  font-size: 14px;
  color: var(--text-muted);
  background: var(--bg-secondary);
  padding: 4px 10px;
  border-radius: 12px;
}

.filter-card {
  margin-bottom: 20px;
  padding: 16px;
}

.filter-row {
  display: flex;
  gap: 16px;
}

.filter-row .form-group {
  flex: 1;
  margin-bottom: 0;
}

.filter-row .search-group {
  flex: 2;
}

.explorations-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.context-group {
  overflow: hidden;
}

.context-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: var(--bg-secondary, #f5f5f5);
  border-bottom: 1px solid var(--border-color);
}

.context-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-color);
}

.list-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}

.list-item:last-child {
  border-bottom: none;
}

.list-item-content {
  cursor: pointer;
  flex: 1;
}

.list-item-content:hover .list-item-title {
  color: var(--primary-color);
}

.list-item-title {
  font-weight: 500;
  margin-bottom: 4px;
}

.list-item-subtitle {
  font-size: 12px;
  color: var(--text-muted);
}

.list-item-actions {
  display: flex;
  gap: 8px;
}

.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.badge {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  margin-left: 8px;
}

.badge-readonly {
  background: var(--bg-secondary);
  color: var(--text-muted);
}

.badge-write {
  background: #e8f5e9;
  color: #2e7d32;
}

.empty-state {
  text-align: center;
  padding: 40px;
}

.empty-state h3 {
  margin-bottom: 8px;
}

.empty-state p {
  color: var(--text-muted);
  margin-bottom: 16px;
}

/* Modal styles */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--card-background, white);
  border-radius: 8px;
  padding: 24px;
  width: 100%;
  max-width: 400px;
  max-height: 80vh;
  overflow-y: auto;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.modal-header h2 {
  margin: 0;
  font-size: 18px;
}

.modal-close {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--text-muted);
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  margin-bottom: 4px;
  font-weight: 500;
  font-size: 14px;
}

.form-control {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  font-size: 14px;
}

.shared-list {
  margin-bottom: 16px;
  padding: 12px;
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 4px;
}

.shared-list h4 {
  margin: 0 0 8px 0;
  font-size: 14px;
}

.shared-list ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.shared-list li {
  font-size: 13px;
  color: var(--text-muted);
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 0;
}

.shared-email {
  flex: 1;
}

.btn-remove {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.btn-remove:hover {
  color: var(--danger-color, #dc3545);
}

.badge-domain {
  background: var(--primary-color, #4a90d9);
  color: white;
  margin-right: 4px;
}

.form-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
