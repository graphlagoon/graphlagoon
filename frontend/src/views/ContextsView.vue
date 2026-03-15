<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useContextsStore } from '@/stores/contexts';
import { useAuthStore } from '@/stores/auth';
import { usePersistence } from '@/composables/usePersistence';
import { api } from '@/services/api';
import type { GraphContext, ColumnInfo } from '@/types/graph';

const router = useRouter();
const route = useRoute();
const contextsStore = useContextsStore();
const authStore = useAuthStore();
const { sharingEnabled } = usePersistence();

// Check if current user is the owner of a context
function isOwner(context: GraphContext): boolean {
  return context.owner_email === authStore.email;
}

// Search state
// TODO: For large datasets, search should be done via API for better performance
const searchQuery = ref('');

// Simple fuzzy search function - matches if query terms appear in any order
function fuzzyMatch(text: string, query: string): boolean {
  const textLower = text.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every(term => textLower.includes(term));
}

// Filtered contexts based on search
const filteredContexts = computed(() => {
  if (!searchQuery.value.trim()) {
    return contextsStore.contexts;
  }
  const query = searchQuery.value.trim();
  return contextsStore.contexts.filter(ctx => {
    // Search in title, description, tags, and table names
    const searchableText = [
      ctx.title,
      ctx.description || '',
      ctx.tags?.join(' ') || '',
      ctx.edge_table_name,
      ctx.node_table_name,
    ].join(' ');
    return fuzzyMatch(searchableText, query);
  });
});

// Helper to parse tag into name:value parts
function parseTag(tag: string): { name: string; value: string } | null {
  const colonIndex = tag.indexOf(':');
  if (colonIndex > 0) {
    return {
      name: tag.substring(0, colonIndex).trim(),
      value: tag.substring(colonIndex + 1).trim(),
    };
  }
  return null;
}

// Create context modal
const showCreateModal = ref(false);
const createForm = ref({
  title: '',
  description: '',
  tags: '',
  edge_table_name: '',
  node_table_name: '',
  // Edge column mapping
  edge_id_col: 'edge_id',
  src_col: 'src',
  dst_col: 'dst',
  relationship_type_col: 'relationship_type',
  // Node column mapping
  node_id_col: 'node_id',
  node_type_col: 'node_type',
  // Schema types (comma-separated)
  node_types: '',
  relationship_types: '',
});

// Table schema state
const edgeTableColumns = ref<ColumnInfo[]>([]);
const nodeTableColumns = ref<ColumnInfo[]>([]);
const loadingEdgeSchema = ref(false);
const loadingNodeSchema = ref(false);
const schemaError = ref<string | null>(null);
const loadingSchemaDiscovery = ref(false);
const schemaDiscoveryError = ref<string | null>(null);

// Helper to parse table name (format: database.table or catalog.database.table)
function parseTableName(fullName: string): { catalog: string; database: string; table: string } | null {
  const parts = fullName.split('.');
  if (parts.length === 2) {
    return { catalog: 'spark_catalog', database: parts[0], table: parts[1] };
  } else if (parts.length === 3) {
    // Pass the catalog as-is, sql-warehouse handles the translation
    return { catalog: parts[0], database: parts[1], table: parts[2] };
  }
  return null;
}

// Fetch edge table schema when selected
async function fetchEdgeTableSchema() {
  const tableName = createForm.value.edge_table_name;
  if (!tableName) {
    edgeTableColumns.value = [];
    return;
  }

  const parsed = parseTableName(tableName);
  if (!parsed) {
    schemaError.value = `Invalid table name format: ${tableName}`;
    return;
  }

  loadingEdgeSchema.value = true;
  schemaError.value = null;

  try {
    const schema = await api.getTableSchema(parsed.table, parsed.database, parsed.catalog);
    edgeTableColumns.value = schema.columns;

    // Auto-select columns if they match common names
    const colNames = schema.columns.map(c => c.name.toLowerCase());
    if (colNames.includes('src')) createForm.value.src_col = 'src';
    if (colNames.includes('dst')) createForm.value.dst_col = 'dst';
    if (colNames.includes('edge_id')) createForm.value.edge_id_col = 'edge_id';
    if (colNames.includes('relationship_type')) createForm.value.relationship_type_col = 'relationship_type';
  } catch (e) {
    console.error('Failed to fetch edge table schema:', e);
    schemaError.value = `Failed to fetch schema for ${tableName}`;
  } finally {
    loadingEdgeSchema.value = false;
  }
}

// Fetch node table schema when selected
async function fetchNodeTableSchema() {
  const tableName = createForm.value.node_table_name;
  if (!tableName) {
    nodeTableColumns.value = [];
    return;
  }

  const parsed = parseTableName(tableName);
  if (!parsed) {
    schemaError.value = `Invalid table name format: ${tableName}`;
    return;
  }

  loadingNodeSchema.value = true;
  schemaError.value = null;

  try {
    const schema = await api.getTableSchema(parsed.table, parsed.database, parsed.catalog);
    nodeTableColumns.value = schema.columns;

    // Auto-select columns if they match common names
    const colNames = schema.columns.map(c => c.name.toLowerCase());
    if (colNames.includes('node_id')) createForm.value.node_id_col = 'node_id';
    if (colNames.includes('node_type')) createForm.value.node_type_col = 'node_type';
  } catch (e) {
    console.error('Failed to fetch node table schema:', e);
    schemaError.value = `Failed to fetch schema for ${tableName}`;
  } finally {
    loadingNodeSchema.value = false;
  }
}

// Watch for table selection changes
watch(() => createForm.value.edge_table_name, fetchEdgeTableSchema);
watch(() => createForm.value.node_table_name, fetchNodeTableSchema);

// Discover node_types and relationship_types from tables
async function discoverTypes() {
  const edgeTable = createForm.value.edge_table_name;
  const nodeTable = createForm.value.node_table_name;

  if (!edgeTable || !nodeTable) {
    schemaDiscoveryError.value = 'Please select both edge and node tables first';
    return;
  }

  loadingSchemaDiscovery.value = true;
  schemaDiscoveryError.value = null;

  try {
    const result = await api.discoverSchema({
      edge_table: edgeTable,
      node_table: nodeTable,
      columns: {
        node_id_col: createForm.value.node_id_col,
        node_type_col: createForm.value.node_type_col,
        edge_id_col: createForm.value.edge_id_col,
        src_col: createForm.value.src_col,
        dst_col: createForm.value.dst_col,
        relationship_type_col: createForm.value.relationship_type_col,
      },
    });
    createForm.value.node_types = result.node_types.join(', ');
    createForm.value.relationship_types = result.relationship_types.join(', ');
    if (!result.node_types.length && !result.relationship_types.length) {
      schemaDiscoveryError.value = 'No types found. Tables may be empty or columns may not match.';
    }
  } catch (e: any) {
    console.error('Failed to discover schema types:', e);
    const detail = e?.response?.data?.detail?.error?.message;
    schemaDiscoveryError.value = detail || 'Failed to discover types from tables';
  } finally {
    loadingSchemaDiscovery.value = false;
  }
}

// Separate lists for edge and node tables
const availableEdgeTables = computed(() => {
  return [...contextsStore.datasets.edge_tables].sort();
});

const availableNodeTables = computed(() => {
  return [...contextsStore.datasets.node_tables].sort();
});

// Fetch datasets when create modal opens
watch(showCreateModal, async (isOpen) => {
  if (isOpen) {
    await contextsStore.fetchDatasets();
  }
});

onMounted(async () => {
  await contextsStore.fetchContexts();

  // Check if we came from DEV Generator with prefilled data
  if (route.query.create === 'true') {
    createForm.value.edge_table_name = (route.query.edge_table as string) || '';
    createForm.value.node_table_name = (route.query.node_table as string) || '';
    showCreateModal.value = true;
    // Clear query params
    router.replace({ query: {} });
  }
});

function openGraph(context: GraphContext) {
  router.push(`/graph/${context.id}`);
}

async function createContext() {
  try {
    const tags = createForm.value.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const nodeTypes = createForm.value.node_types
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const relationshipTypes = createForm.value.relationship_types
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    // Structural column names
    const edgeStructuralCols = new Set([
      createForm.value.edge_id_col,
      createForm.value.src_col,
      createForm.value.dst_col,
      createForm.value.relationship_type_col,
    ].filter(Boolean));

    const nodeStructuralCols = new Set([
      createForm.value.node_id_col,
      createForm.value.node_type_col,
    ].filter(Boolean));

    // Compute property columns from loaded schema (excluding structural columns)
    const edgeProperties = edgeTableColumns.value
      .filter(col => !edgeStructuralCols.has(col.name))
      .map(col => ({
        name: col.name,
        data_type: col.data_type,
      }));

    const nodeProperties = nodeTableColumns.value
      .filter(col => !nodeStructuralCols.has(col.name))
      .map(col => ({
        name: col.name,
        data_type: col.data_type,
      }));

    await contextsStore.createContext({
      title: createForm.value.title,
      description: createForm.value.description || undefined,
      tags,
      edge_table_name: createForm.value.edge_table_name,
      node_table_name: createForm.value.node_table_name,
      edge_structure: {
        edge_id_col: createForm.value.edge_id_col,
        src_col: createForm.value.src_col,
        dst_col: createForm.value.dst_col,
        relationship_type_col: createForm.value.relationship_type_col,
      },
      node_structure: {
        node_id_col: createForm.value.node_id_col,
        node_type_col: createForm.value.node_type_col,
      },
      edge_properties: edgeProperties.length > 0 ? edgeProperties : undefined,
      node_properties: nodeProperties.length > 0 ? nodeProperties : undefined,
      node_types: nodeTypes.length > 0 ? nodeTypes : undefined,
      relationship_types: relationshipTypes.length > 0 ? relationshipTypes : undefined,
    });

    showCreateModal.value = false;
    createForm.value = {
      title: '',
      description: '',
      tags: '',
      edge_table_name: '',
      node_table_name: '',
      edge_id_col: 'edge_id',
      src_col: 'src',
      dst_col: 'dst',
      relationship_type_col: 'relationship_type',
      node_id_col: 'node_id',
      node_type_col: 'node_type',
      node_types: '',
      relationship_types: '',
    };
  } catch (e) {
    console.error(e);
  }
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

</script>

<template>
  <div class="container">
    <div class="page-header">
      <h1>Graph Contexts</h1>
      <button class="btn btn-primary" data-testid="create-context-btn" @click="showCreateModal = true">
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
      <button class="btn btn-primary" @click="showCreateModal = true">
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
            <code>{{ context.edge_table_name }}</code> /
            <code>{{ context.node_table_name }}</code>
          </div>
          <div class="list-item-meta">
            Created by {{ context.owner_email }}
            <span v-if="!isOwner(context)" class="badge" :class="context.has_write_access ? 'badge-write' : 'badge-readonly'">
              {{ context.has_write_access ? 'Read & Write' : 'Read only' }}
            </span>
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
        </div>
        <div class="list-item-actions">
          <button class="btn btn-outline" @click="openGraph(context)">
            Open
          </button>
          <button
            v-if="sharingEnabled && isOwner(context)"
            class="btn btn-outline"
            @click="openShare(context)"
          >
            Share
          </button>
          <button v-if="isOwner(context)" class="btn btn-danger" @click="deleteContext(context)">
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
                <span v-if="email.startsWith('*@')" class="badge badge-domain">Domain</span>
                {{ email }}
              </span>
              <button class="btn-remove" @click="unshare(shareContextRef!.id, email)">&times;</button>
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

    <!-- Create Modal -->
    <div v-if="showCreateModal" class="modal-overlay" data-testid="create-context-modal" @click.self="showCreateModal = false">
      <div class="modal">
        <div class="modal-header">
          <h2>Create Graph Context</h2>
          <button class="modal-close" @click="showCreateModal = false">&times;</button>
        </div>

        <form @submit.prevent="createContext">
          <div class="form-group">
            <label>Title *</label>
            <input
              v-model="createForm.title"
              type="text"
              class="form-control"
              placeholder="My Graph Context"
              required
            />
          </div>

          <div class="form-group">
            <label>Description</label>
            <textarea
              v-model="createForm.description"
              class="form-control"
              rows="3"
              placeholder="Optional description..."
            ></textarea>
          </div>

          <div class="form-group">
            <label>Edge Table *</label>
            <select
              v-model="createForm.edge_table_name"
              class="form-control"
              required
            >
              <option value="" disabled>Select edge table...</option>
              <option v-for="table in availableEdgeTables" :key="'edge-' + table" :value="table">
                {{ table }}
              </option>
            </select>
            <span v-if="availableEdgeTables.length === 0" class="hint">No edge tables available. Generate a graph first.</span>
          </div>

          <div class="form-group">
            <label>Node Table *</label>
            <select
              v-model="createForm.node_table_name"
              class="form-control"
              required
            >
              <option value="" disabled>Select node table...</option>
              <option v-for="table in availableNodeTables" :key="'node-' + table" :value="table">
                {{ table }}
              </option>
            </select>
            <span v-if="availableNodeTables.length === 0" class="hint">No node tables available. Generate a graph first.</span>
          </div>

          <!-- Edge Column Mapping -->
          <div class="column-config-section">
            <div class="section-header-row">
              <h4>Edge Table Columns</h4>
              <span v-if="loadingEdgeSchema" class="loading-indicator">Loading...</span>
              <button
                v-else-if="createForm.edge_table_name"
                type="button"
                class="btn btn-sm btn-outline"
                @click="fetchEdgeTableSchema"
              >
                Refresh
              </button>
            </div>
            <div v-if="schemaError && createForm.edge_table_name" class="schema-error">{{ schemaError }}</div>
            <div class="form-row">
              <div class="form-group">
                <label>Source Column *</label>
                <select
                  v-if="edgeTableColumns.length > 0"
                  v-model="createForm.src_col"
                  class="form-control"
                  required
                >
                  <option value="" disabled>Select column...</option>
                  <option v-for="col in edgeTableColumns" :key="col.name" :value="col.name">
                    {{ col.name }} ({{ col.data_type }})
                  </option>
                </select>
                <input
                  v-else
                  v-model="createForm.src_col"
                  type="text"
                  class="form-control"
                  placeholder="src"
                  required
                />
              </div>
              <div class="form-group">
                <label>Destination Column *</label>
                <select
                  v-if="edgeTableColumns.length > 0"
                  v-model="createForm.dst_col"
                  class="form-control"
                  required
                >
                  <option value="" disabled>Select column...</option>
                  <option v-for="col in edgeTableColumns" :key="col.name" :value="col.name">
                    {{ col.name }} ({{ col.data_type }})
                  </option>
                </select>
                <input
                  v-else
                  v-model="createForm.dst_col"
                  type="text"
                  class="form-control"
                  placeholder="dst"
                  required
                />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Relationship Type Column</label>
                <select
                  v-if="edgeTableColumns.length > 0"
                  v-model="createForm.relationship_type_col"
                  class="form-control"
                >
                  <option value="">None</option>
                  <option v-for="col in edgeTableColumns" :key="col.name" :value="col.name">
                    {{ col.name }} ({{ col.data_type }})
                  </option>
                </select>
                <input
                  v-else
                  v-model="createForm.relationship_type_col"
                  type="text"
                  class="form-control"
                  placeholder="relationship_type"
                />
              </div>
              <div class="form-group">
                <label>Edge ID Column</label>
                <select
                  v-if="edgeTableColumns.length > 0"
                  v-model="createForm.edge_id_col"
                  class="form-control"
                >
                  <option value="">None</option>
                  <option v-for="col in edgeTableColumns" :key="col.name" :value="col.name">
                    {{ col.name }} ({{ col.data_type }})
                  </option>
                </select>
                <input
                  v-else
                  v-model="createForm.edge_id_col"
                  type="text"
                  class="form-control"
                  placeholder="edge_id"
                />
              </div>
            </div>
          </div>

          <!-- Node Column Mapping -->
          <div class="column-config-section">
            <div class="section-header-row">
              <h4>Node Table Columns</h4>
              <span v-if="loadingNodeSchema" class="loading-indicator">Loading...</span>
              <button
                v-else-if="createForm.node_table_name"
                type="button"
                class="btn btn-sm btn-outline"
                @click="fetchNodeTableSchema"
              >
                Refresh
              </button>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Node ID Column *</label>
                <select
                  v-if="nodeTableColumns.length > 0"
                  v-model="createForm.node_id_col"
                  class="form-control"
                  required
                >
                  <option value="" disabled>Select column...</option>
                  <option v-for="col in nodeTableColumns" :key="col.name" :value="col.name">
                    {{ col.name }} ({{ col.data_type }})
                  </option>
                </select>
                <input
                  v-else
                  v-model="createForm.node_id_col"
                  type="text"
                  class="form-control"
                  placeholder="node_id"
                  required
                />
              </div>
              <div class="form-group">
                <label>Node Type Column</label>
                <select
                  v-if="nodeTableColumns.length > 0"
                  v-model="createForm.node_type_col"
                  class="form-control"
                >
                  <option value="">None</option>
                  <option v-for="col in nodeTableColumns" :key="col.name" :value="col.name">
                    {{ col.name }} ({{ col.data_type }})
                  </option>
                </select>
                <input
                  v-else
                  v-model="createForm.node_type_col"
                  type="text"
                  class="form-control"
                  placeholder="node_type"
                />
              </div>
            </div>
          </div>

          <!-- Schema Types Discovery -->
          <div class="column-config-section">
            <div class="section-header-row">
              <h4>Schema Types</h4>
              <button
                type="button"
                class="btn btn-sm btn-outline"
                :disabled="loadingSchemaDiscovery || !createForm.edge_table_name || !createForm.node_table_name"
                @click="discoverTypes"
              >
                <span v-if="loadingSchemaDiscovery">Discovering...</span>
                <span v-else>Discover</span>
              </button>
            </div>
            <div v-if="schemaDiscoveryError" class="schema-error">{{ schemaDiscoveryError }}</div>
            <div class="form-row">
              <div class="form-group">
                <label>Node Types</label>
                <input
                  v-model="createForm.node_types"
                  type="text"
                  class="form-control"
                  placeholder="Person, Company, Product"
                />
                <span class="hint">Comma-separated (or click Discover)</span>
              </div>
              <div class="form-group">
                <label>Relationship Types</label>
                <input
                  v-model="createForm.relationship_types"
                  type="text"
                  class="form-control"
                  placeholder="KNOWS, WORKS_AT, OWNS"
                />
                <span class="hint">Comma-separated (or click Discover)</span>
              </div>
            </div>
          </div>

          <div class="form-group">
            <label>Tags</label>
            <input
              v-model="createForm.tags"
              type="text"
              class="form-control"
              placeholder="env:prod, team:data, project:analytics"
            />
            <span class="hint">Comma-separated, use name:value format (e.g., env:prod)</span>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn btn-outline" @click="showCreateModal = false">
              Cancel
            </button>
            <button type="submit" class="btn btn-primary" data-testid="create-context-submit" :disabled="contextsStore.loading">
              Create
            </button>
          </div>
        </form>
      </div>
    </div>

  </div>
</template>

<style scoped>
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

.hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

.column-config-section {
  margin-top: 16px;
  padding: 12px;
  background: var(--bg-secondary);
  border-radius: 8px;
}

.column-config-section h4 {
  margin: 0 0 12px 0;
  font-size: 14px;
  color: var(--text-muted);
}

.form-row {
  display: flex;
  gap: 12px;
}

.form-row .form-group {
  flex: 1;
}

.section-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.section-header-row h4 {
  margin: 0;
}

.loading-indicator {
  font-size: 12px;
  color: var(--text-muted);
}

.schema-error {
  font-size: 12px;
  color: var(--danger-color, #f44336);
  margin-bottom: 12px;
}

.btn-sm {
  padding: 4px 8px;
  font-size: 12px;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
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

.share-modal {
  max-width: 400px;
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
