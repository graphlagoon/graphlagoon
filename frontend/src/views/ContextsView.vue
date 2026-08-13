<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useContextsStore } from '@/stores/contexts';
import { useAuthStore } from '@/stores/auth';
import { usePersistence } from '@/composables/usePersistence';
import { api } from '@/services/api';
import { fuzzyMatch, parseTag } from '@/utils/contextForm';
import { useSchemaDrift } from '@/composables/useSchemaDrift';
import {
  DATASOURCE_LABELS,
  capabilitiesFor,
  resolveDatasourceType,
} from '@/composables/useDatasourceCapabilities';
import GraphContextFormModal from '@/components/GraphContextFormModal.vue';
import SchemaDriftBanner from '@/components/SchemaDriftBanner.vue';
import SchemaDriftModal from '@/components/SchemaDriftModal.vue';
import type { GraphContext } from '@/types/graph';

const router = useRouter();
const route = useRoute();
const contextsStore = useContextsStore();
const authStore = useAuthStore();
const { sharingEnabled, isSuperuser } = usePersistence();

// Check if current user is the owner of a context
function isOwner(context: GraphContext): boolean {
  return context.owner_email === authStore.email;
}

// Owner-level actions (share/delete): owner or superuser
function canManage(context: GraphContext): boolean {
  return isOwner(context) || isSuperuser.value;
}

// Search state
// TODO: For large datasets, search should be done via API for better performance
const searchQuery = ref('');

// Filtered contexts based on search
const filteredContexts = computed(() => {
  if (!searchQuery.value.trim()) {
    return contextsStore.contexts;
  }
  const query = searchQuery.value.trim();
  return contextsStore.contexts.filter(ctx => {
    // Search in title, description, tags, datasource and table names
    const searchableText = [
      ctx.title,
      ctx.description || '',
      ctx.tags?.join(' ') || '',
      DATASOURCE_LABELS[resolveDatasourceType(ctx)],
      ctx.edge_table_name || '',
      ctx.node_table_name || '',
    ].join(' ');
    return fuzzyMatch(searchableText, query);
  });
});

// --- Create/edit form modal ---------------------------------------------------

const formModalOpen = ref(false);
const formModalMode = ref<'create' | 'edit'>('create');
const formModalContext = ref<GraphContext | null>(null);
const formModalPrefillEdge = ref('');
const formModalPrefillNode = ref('');

function openCreateModal() {
  formModalMode.value = 'create';
  formModalContext.value = null;
  formModalPrefillEdge.value = '';
  formModalPrefillNode.value = '';
  formModalOpen.value = true;
}

function openEditModal(context: GraphContext) {
  formModalMode.value = 'edit';
  formModalContext.value = context;
  formModalOpen.value = true;
}

function closeFormModal() {
  formModalOpen.value = false;
}

function onFormSaved() {
  formModalOpen.value = false;
}

onMounted(async () => {
  await contextsStore.fetchContexts();

  // Check if we came from DEV Generator with prefilled data
  if (route.query.create === 'true') {
    formModalPrefillEdge.value = (route.query.edge_table as string) || '';
    formModalPrefillNode.value = (route.query.node_table as string) || '';
    openCreateModal();
    router.replace({ query: {} });
  }

  // Reused by the "Check context schema" CTA in QueryErrorModal, which
  // navigates here with ?edit=<id> when it can't resolve stale schema inline.
  if (route.query.edit) {
    const contextId = route.query.edit as string;
    const context = contextsStore.contexts.find((c) => c.id === contextId);
    if (context) openEditModal(context);
    router.replace({ query: {} });
  }
});

// --- Schema drift check (on-demand per row — never on mount, that would fire
// 2N warehouse statements for N contexts) --------------------------------------

const { state: schemaDriftState, check: checkSchemaDrift } = useSchemaDrift();
const driftModalContextId = ref<string | null>(null);
const driftModalHasWriteAccess = ref(false);

function checkContextSchema(context: GraphContext) {
  void checkSchemaDrift(context.id);
}

function openDriftModal(context: GraphContext) {
  driftModalContextId.value = context.id;
  driftModalHasWriteAccess.value = context.has_write_access;
}

function closeDriftModal() {
  driftModalContextId.value = null;
}

function onDriftApplied() {
  driftModalContextId.value = null;
  void contextsStore.fetchContexts();
}

function openGraph(context: GraphContext) {
  router.push(`/graph/${context.id}`);
}

async function deleteContext(context: GraphContext) {
  if (!confirm(`Delete "${context.title}"?`)) return;

  try {
    await contextsStore.deleteContext(context.id);
  } catch (e) {
    console.error(e);
  }
}

// Share modal state
const showShareModal = ref(false);
const shareContextRef = ref<GraphContext | null>(null);
const shareForm = ref({
  email: '',
  permission: 'read' as 'read' | 'write',
});

const allowedShareDomains = computed<string[]>(
  () => window.__GRAPH_LAGOON_CONFIG__?.allowed_share_domains ?? []
);

function openShare(context: GraphContext) {
  shareContextRef.value = context;
  showShareModal.value = true;
}

async function share() {
  if (!shareContextRef.value) return;

  try {
    await contextsStore.shareContext(shareContextRef.value.id, shareForm.value.email, shareForm.value.permission);
    showShareModal.value = false;
    shareForm.value = { email: '', permission: 'read' };
  } catch (e) {
    console.error('Failed to share context:', e);
  }
}

async function unshare(contextId: string, email: string) {
  try {
    await api.unshareGraphContext(contextId, email);
    await contextsStore.fetchContexts();
    // Update modal state if still open
    if (shareContextRef.value?.id === contextId) {
      const updated = contextsStore.contexts.find(c => c.id === contextId);
      if (updated) shareContextRef.value = updated;
    }
  } catch (e) {
    console.error('Failed to unshare context:', e);
  }
}

const PUBLIC_SHARE_EMAIL = '*';

const myDomain = computed(() => {
  const email = authStore.email ?? '';
  return email.includes('@') ? email.split('@')[1].toLowerCase() : '';
});

const canShareWithMyDomain = computed(
  () =>
    !!myDomain.value &&
    allowedShareDomains.value.some(d => d.toLowerCase() === myDomain.value)
);

function isPublic(context: GraphContext | null): boolean {
  return context?.shared_with?.includes(PUBLIC_SHARE_EMAIL) ?? false;
}

function isDomainShared(context: GraphContext | null): boolean {
  return context?.shared_with?.includes(`*@${myDomain.value}`) ?? false;
}

async function quickShare(email: string) {
  if (!shareContextRef.value) return;
  const contextId = shareContextRef.value.id;

  try {
    // Keep the modal open so the new entry shows in the shared list
    await contextsStore.shareContext(contextId, email, 'read');
    const updated = contextsStore.contexts.find(c => c.id === contextId);
    if (updated) shareContextRef.value = updated;
  } catch (e) {
    console.error('Failed to share context:', e);
  }
}

</script>

<template>
  <div class="container">
    <div class="page-header">
      <h1>Graph Contexts</h1>
      <button class="btn btn-primary" data-testid="create-context-btn" @click="openCreateModal">
        Create New
      </button>
    </div>

    <!-- Search input -->
    <div v-if="contextsStore.contexts.length > 0" class="search-bar card">
      <input
        v-model="searchQuery"
        type="text"
        class="form-control"
        data-testid="contexts-search"
        placeholder="Search contexts by title, description, tags..."
      />
      <span v-if="searchQuery" class="search-results-count">
        {{ filteredContexts.length }} of {{ contextsStore.contexts.length }} contexts
      </span>
    </div>

    <div v-if="contextsStore.loading" class="loading"></div>

    <div v-else-if="contextsStore.error" class="error-message">
      {{ contextsStore.error }}
    </div>

    <div v-else-if="contextsStore.contexts.length === 0" class="empty-state card">
      <h3>No Graph Contexts</h3>
      <p>Create your first graph context or generate a graph in DEV mode</p>
      <button class="btn btn-primary" @click="openCreateModal">
        Create Context
      </button>
    </div>

    <div v-else-if="filteredContexts.length === 0" class="empty-state card">
      <h3>No Results</h3>
      <p>No contexts match "{{ searchQuery }}"</p>
      <button class="btn btn-outline" @click="searchQuery = ''">
        Clear Search
      </button>
    </div>

    <div v-else class="card" data-testid="contexts-list">
      <div
        v-for="context in filteredContexts"
        :key="context.id"
        class="list-item"
      >
        <div class="list-item-content">
          <div class="list-item-title">{{ context.title }}</div>
          <div class="list-item-subtitle">
            <span class="datasource-badge" :data-datasource="resolveDatasourceType(context)">
              {{ DATASOURCE_LABELS[resolveDatasourceType(context)] }}
            </span>
            <template v-if="context.edge_table_name && context.node_table_name">
              <code>{{ context.edge_table_name }}</code> /
              <code>{{ context.node_table_name }}</code>
            </template>
            <span v-else class="subtitle-note">openCypher · native graph</span>
          </div>
          <div class="list-item-meta">
            Created by {{ context.owner_email }}
            <span v-if="!isOwner(context)" class="badge" :class="context.has_write_access ? 'badge-write' : 'badge-readonly'">
              {{ context.has_write_access ? 'Read & Write' : 'Read only' }}
            </span>
            <span v-if="isPublic(context)" class="badge badge-public">Public</span>
          </div>
          <div v-if="context.tags?.length" class="tags">
            <span v-for="tag in context.tags" :key="tag" class="tag">
              <template v-if="parseTag(tag)">
                <span class="tag-name">{{ parseTag(tag)!.name }}</span>
                <span class="tag-value">{{ parseTag(tag)!.value }}</span>
              </template>
              <template v-else>{{ tag }}</template>
            </span>
          </div>
          <SchemaDriftBanner
            v-if="schemaDriftState(context.id).drift"
            :status="schemaDriftState(context.id).drift!.status"
            :counts="schemaDriftState(context.id).drift!.counts"
            class="drift-banner-slot"
            @review="openDriftModal(context)"
          />
        </div>
        <div class="list-item-actions">
          <button class="btn btn-outline" @click="openGraph(context)">
            Open
          </button>
          <button
            v-if="capabilitiesFor(resolveDatasourceType(context)).supportsDrift"
            class="btn btn-outline"
            data-testid="check-schema-btn"
            :disabled="schemaDriftState(context.id).loading"
            title="Checking is read-only and available to anyone with access to this context"
            @click="checkContextSchema(context)"
          >
            {{ schemaDriftState(context.id).loading ? 'Checking…' : 'Check schema' }}
          </button>
          <button
            v-if="context.has_write_access"
            class="btn btn-outline"
            data-testid="edit-context-btn"
            @click="openEditModal(context)"
          >
            Edit
          </button>
          <button
            v-if="sharingEnabled && canManage(context)"
            class="btn btn-outline"
            @click="openShare(context)"
          >
            Share
          </button>
          <button v-if="canManage(context)" class="btn btn-danger" @click="deleteContext(context)">
            Delete
          </button>
        </div>
      </div>
    </div>

    <!-- Share Modal -->
    <div v-if="sharingEnabled && showShareModal" class="modal-overlay" @click.self="showShareModal = false">
      <div class="modal share-modal">
        <div class="modal-header">
          <h2>Share "{{ shareContextRef?.title }}"</h2>
          <button class="modal-close" @click="showShareModal = false">&times;</button>
        </div>

        <div v-if="shareContextRef?.shared_with?.length" class="shared-list">
          <h4>Currently shared with:</h4>
          <ul>
            <li v-for="email in shareContextRef.shared_with" :key="email">
              <span class="shared-email">
                <span v-if="email === PUBLIC_SHARE_EMAIL" class="badge badge-public">Public</span>
                <span v-else-if="email.startsWith('*@')" class="badge badge-domain">Domain</span>
                {{ email === PUBLIC_SHARE_EMAIL ? 'Everyone (public)' : email }}
              </span>
              <button class="btn-remove" @click="unshare(shareContextRef!.id, email)">&times;</button>
            </li>
          </ul>
        </div>

        <div class="quick-share">
          <button
            v-if="!isPublic(shareContextRef)"
            type="button"
            class="btn btn-outline"
            data-testid="make-public-btn"
            @click="quickShare(PUBLIC_SHARE_EMAIL)"
          >
            Make public (read-only for everyone)
          </button>
          <p v-else class="form-hint">
            This context is public — anyone can view it. Remove "Everyone (public)" above to unpublish.
          </p>
          <template v-if="canShareWithMyDomain">
            <button
              v-if="!isDomainShared(shareContextRef)"
              type="button"
              class="btn btn-outline"
              data-testid="share-domain-btn"
              @click="quickShare(`*@${myDomain}`)"
            >
              Share with my domain (*@{{ myDomain }})
            </button>
            <p v-else class="form-hint">
              Shared with everyone at @{{ myDomain }}.
            </p>
          </template>
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

    <GraphContextFormModal
      :open="formModalOpen"
      :mode="formModalMode"
      :context="formModalContext"
      :prefill-edge-table="formModalPrefillEdge"
      :prefill-node-table="formModalPrefillNode"
      @close="closeFormModal"
      @saved="onFormSaved"
    />

    <SchemaDriftModal
      v-if="driftModalContextId"
      :open="!!driftModalContextId"
      :context-id="driftModalContextId"
      :has-write-access="driftModalHasWriteAccess"
      @close="closeDriftModal"
      @applied="onDriftApplied"
    />
  </div>
</template>

<style scoped>
.datasource-badge {
  display: inline-block;
  padding: 1px 6px;
  margin-right: 6px;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  background: var(--badge-bg, rgba(125, 125, 125, 0.16));
}

.datasource-badge[data-datasource='neptune'] {
  background: rgba(56, 139, 253, 0.18);
  color: var(--accent-color, #0969da);
}

.subtitle-note {
  opacity: 0.7;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  padding: 12px 16px;
}

.search-bar .form-control {
  flex: 1;
}

.search-results-count {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
}

.list-item-content {
  flex: 1;
}

.list-item-meta {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

code {
  background: var(--bg-secondary);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.drift-banner-slot {
  margin-top: 8px;
  max-width: 480px;
}

.tag {
  display: inline-flex;
  font-size: 11px;
  border-radius: 4px;
  overflow: hidden;
  background: var(--bg-secondary);
}

.tag-name {
  padding: 2px 6px;
  background: var(--primary-color, #2196f3);
  color: white;
  font-weight: 500;
}

.tag-value {
  padding: 2px 6px;
  color: var(--text-color);
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

.badge-domain {
  background: var(--primary-color, #4a90d9);
  color: white;
  margin-right: 4px;
}

.badge-public {
  background: #2e7d32;
  color: white;
  margin-right: 4px;
}

.share-modal {
  max-width: 400px;
}

.quick-share {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
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
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  color: var(--text-muted);
  padding: 4px 0;
}

.shared-email {
  display: flex;
  align-items: center;
}

.btn-remove {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  color: var(--text-muted);
  padding: 0 4px;
}

.btn-remove:hover {
  color: var(--danger-color, #f44336);
}

.form-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
