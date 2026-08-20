<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useContextsStore } from '@/stores/contexts';
import { api } from '@/services/api';
import { parseTableName } from '@/utils/contextForm';
import {
  resolveDatasourceDescriptor,
  resolveDatasourceType,
  useDatasourceDescriptors,
  type DatasourceDescriptor,
} from '@/composables/useDatasourceCapabilities';
import type { DatasourceType, GraphContext, ColumnInfo } from '@/types/graph';

/**
 * Create/edit modal for a graph context.
 *
 * CREATE mode drives everything from live warehouse schema: table selects,
 * per-column structural mapping, a "Discover" button for node/relationship
 * types, and property columns computed from the live table (all live columns
 * minus the structural ones).
 *
 * EDIT mode deliberately does LESS: table names are immutable (shown as
 * static text — see docs/dev/decision-log.md for why) and structural columns
 * are plain text fields with no per-column live-schema fetch. Submitting an
 * edit never touches node_properties/edge_properties — that is what the
 * schema-diff review flow (SchemaDriftModal) is for. A generic edit form
 * silently resyncing properties as a side effect of renaming a tag would
 * bypass that review entirely.
 *
 * Type "Discover" IS available in both modes: it only reads the two type
 * columns and rewrites the node_types/relationship_types text fields, which
 * are already hand-editable here. It touches no property column, so it does
 * not bypass anything — withholding it in edit mode just forced people to
 * retype values the button could fetch.
 *
 * The DATASOURCE picker comes first because it decides how much of the rest of
 * the form exists. A native graph database (Neptune) has no tables and no
 * column mapping, so choosing it collapses the form to name/description/tags
 * plus optional types — everything table-shaped is warehouse-only.
 */
const props = defineProps<{
  open: boolean;
  mode: 'create' | 'edit';
  context?: GraphContext | null;
  /** Prefilled table names for the DEV Generator hand-off. Create mode only. */
  prefillEdgeTable?: string;
  prefillNodeTable?: string;
}>();

const emit = defineEmits<{
  close: [];
  saved: [GraphContext];
}>();

const contextsStore = useContextsStore();

function emptyForm() {
  return {
    title: '',
    description: '',
    tags: '',
    datasource_type: 'sql_warehouse' as DatasourceType,
    datasource_name: '',
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
    default_behaviors: '',
  };
}

function formFromContext(context: GraphContext) {
  return {
    title: context.title,
    description: context.description || '',
    tags: (context.tags || []).join(', '),
    datasource_type: resolveDatasourceType(context),
    datasource_name: context.datasource_name || '',
    edge_table_name: context.edge_table_name || '',
    node_table_name: context.node_table_name || '',
    edge_id_col: context.edge_structure.edge_id_col,
    src_col: context.edge_structure.src_col,
    dst_col: context.edge_structure.dst_col,
    relationship_type_col: context.edge_structure.relationship_type_col,
    node_id_col: context.node_structure.node_id_col,
    node_type_col: context.node_structure.node_type_col,
    node_types: (context.node_types || []).join(', '),
    relationship_types: (context.relationship_types || []).join(', '),
    default_behaviors:
      context.default_behaviors && Object.keys(context.default_behaviors).length > 0
        ? JSON.stringify(context.default_behaviors, null, 2)
        : '',
  };
}

const form = ref(emptyForm());

const datasourceOptions = useDatasourceDescriptors();
/** Only worth showing a picker when there is more than one backend to pick. */
const showDatasourcePicker = computed(() => datasourceOptions.value.length > 1);
/** The full descriptor of what the form currently points at. */
const selectedDatasource = computed(() =>
  resolveDatasourceDescriptor({
    datasource_type: form.value.datasource_type,
    datasource_name: form.value.datasource_name || null,
  }),
);
const capabilities = computed(() => selectedDatasource.value.capabilities);
/** Table/column configuration only exists for table-backed datasources. */
const showTableConfig = computed(() => capabilities.value.supportsCatalog);

function selectDatasource(option: DatasourceDescriptor) {
  // Immutable after creation: switching backends would orphan every
  // exploration, template and cluster program saved against the context.
  if (props.mode === 'edit') return;
  form.value.datasource_type = option.type;
  form.value.datasource_name = option.name || '';
}

/** Parse error for the default_behaviors textarea, or null when it's valid/empty. */
const defaultBehaviorsError = computed(() => {
  const raw = form.value.default_behaviors.trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'Not valid JSON';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'Must be a JSON object, e.g. {"viewMode": "3d"}';
  }
  return null;
});

// --- Create-mode-only: live schema fetch, table selects, type discovery -----

const edgeTableColumns = ref<ColumnInfo[]>([]);
const nodeTableColumns = ref<ColumnInfo[]>([]);
const loadingEdgeSchema = ref(false);
const loadingNodeSchema = ref(false);
const schemaError = ref<string | null>(null);
const loadingSchemaDiscovery = ref(false);
const schemaDiscoveryError = ref<string | null>(null);

async function fetchEdgeTableSchema() {
  const tableName = form.value.edge_table_name;
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
    const colNames = schema.columns.map((c) => c.name.toLowerCase());
    if (colNames.includes('src')) form.value.src_col = 'src';
    if (colNames.includes('dst')) form.value.dst_col = 'dst';
    if (colNames.includes('edge_id')) form.value.edge_id_col = 'edge_id';
    if (colNames.includes('relationship_type')) form.value.relationship_type_col = 'relationship_type';
  } catch (e) {
    console.error('Failed to fetch edge table schema:', e);
    schemaError.value = `Failed to fetch schema for ${tableName}`;
  } finally {
    loadingEdgeSchema.value = false;
  }
}

async function fetchNodeTableSchema() {
  const tableName = form.value.node_table_name;
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
    const colNames = schema.columns.map((c) => c.name.toLowerCase());
    if (colNames.includes('node_id')) form.value.node_id_col = 'node_id';
    if (colNames.includes('node_type')) form.value.node_type_col = 'node_type';
  } catch (e) {
    console.error('Failed to fetch node table schema:', e);
    schemaError.value = `Failed to fetch schema for ${tableName}`;
  } finally {
    loadingNodeSchema.value = false;
  }
}

/** Both tables chosen (warehouse), or a datasource that needs none. */
const canDiscoverTypes = computed(
  () =>
    !showTableConfig.value ||
    Boolean(form.value.edge_table_name && form.value.node_table_name),
);

/**
 * Whether discovery exists at all for the selection. A REST connection only
 * has it when its spec declared a handler; offering the button otherwise
 * would promise a 400.
 */
const showDiscoverButton = computed(
  () =>
    selectedDatasource.value.type !== 'rest' ||
    selectedDatasource.value.restOps?.schemaDiscovery === true,
);

async function discoverTypes() {
  const edgeTable = form.value.edge_table_name;
  const nodeTable = form.value.node_table_name;
  const needsTables = showTableConfig.value;

  if (needsTables && (!edgeTable || !nodeTable)) {
    schemaDiscoveryError.value = 'Please select both edge and node tables first';
    return;
  }

  loadingSchemaDiscovery.value = true;
  schemaDiscoveryError.value = null;

  try {
    // A native graph database reads its own label catalog; the tables and
    // column mapping below mean nothing to it.
    const result = await api.discoverSchema(
      needsTables
        ? {
            datasource_type: form.value.datasource_type,
            edge_table: edgeTable,
            node_table: nodeTable,
            columns: {
              node_id_col: form.value.node_id_col,
              node_type_col: form.value.node_type_col,
              edge_id_col: form.value.edge_id_col,
              src_col: form.value.src_col,
              dst_col: form.value.dst_col,
              relationship_type_col: form.value.relationship_type_col,
            },
          }
        : {
            datasource_type: form.value.datasource_type,
            ...(form.value.datasource_name
              ? { datasource_name: form.value.datasource_name }
              : {}),
          },
    );
    form.value.node_types = result.node_types.join(', ');
    form.value.relationship_types = result.relationship_types.join(', ');
    if (!result.node_types.length && !result.relationship_types.length) {
      schemaDiscoveryError.value = needsTables
        ? 'No types found. Tables may be empty or columns may not match.'
        : 'No labels found. The graph may be empty.';
    }
  } catch (e: any) {
    console.error('Failed to discover schema types:', e);
    const detail = e?.response?.data?.detail?.error?.message;
    schemaDiscoveryError.value = detail || 'Failed to discover types from tables';
  } finally {
    loadingSchemaDiscovery.value = false;
  }
}

const availableEdgeTables = computed(() => [...contextsStore.datasets.edge_tables].sort());
const availableNodeTables = computed(() => [...contextsStore.datasets.node_tables].sort());

// Only meaningful in create mode for a table-backed datasource: edit mode's
// table names never change, and a native graph database has no table schema
// to fetch (the request would 400 on a null table name).
watch(() => form.value.edge_table_name, () => {
  if (showTableConfig.value) fetchEdgeTableSchema();
});
watch(() => form.value.node_table_name, () => {
  if (showTableConfig.value) fetchNodeTableSchema();
});

// --- Open/close lifecycle ----------------------------------------------------

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return;

    edgeTableColumns.value = [];
    nodeTableColumns.value = [];
    schemaError.value = null;
    schemaDiscoveryError.value = null;

    if (props.mode === 'edit' && props.context) {
      form.value = formFromContext(props.context);
    } else {
      form.value = emptyForm();
      if (props.prefillEdgeTable) form.value.edge_table_name = props.prefillEdgeTable;
      if (props.prefillNodeTable) form.value.node_table_name = props.prefillNodeTable;
      await contextsStore.fetchDatasets();
    }
  },
  { immediate: true },
);

// --- Submit -------------------------------------------------------------------

function splitCsv(value: string): string[] {
  return value.split(',').map((t) => t.trim()).filter(Boolean);
}

async function submit() {
  // Guard: the submit button is disabled on a parse error, but don't rely on the UI —
  // a malformed dict must never reach the API.
  if (defaultBehaviorsError.value) return;

  try {
    const rawBehaviors = form.value.default_behaviors.trim();
    const defaultBehaviors = rawBehaviors
      ? (JSON.parse(rawBehaviors) as Record<string, unknown>)
      : undefined;

    const tags = splitCsv(form.value.tags);
    const nodeTypes = splitCsv(form.value.node_types);
    const relationshipTypes = splitCsv(form.value.relationship_types);

    const edge_structure = {
      edge_id_col: form.value.edge_id_col,
      src_col: form.value.src_col,
      dst_col: form.value.dst_col,
      relationship_type_col: form.value.relationship_type_col,
    };
    const node_structure = {
      node_id_col: form.value.node_id_col,
      node_type_col: form.value.node_type_col,
    };

    let saved: GraphContext;

    if (props.mode === 'create' && !showTableConfig.value) {
      // Table-less datasource: the backend discovers structure itself, so the
      // whole table/column half of this form is simply not sent.
      saved = await contextsStore.createContext({
        title: form.value.title,
        description: form.value.description || undefined,
        tags,
        datasource_type: form.value.datasource_type,
        ...(form.value.datasource_name
          ? { datasource_name: form.value.datasource_name }
          : {}),
        node_types: nodeTypes.length > 0 ? nodeTypes : undefined,
        relationship_types: relationshipTypes.length > 0 ? relationshipTypes : undefined,
        default_behaviors: defaultBehaviors,
      });
    } else if (props.mode === 'create') {
      // Property columns = every live column minus the structural ones —
      // create mode always has live schema loaded (the selects require it).
      const edgeStructuralCols = new Set(Object.values(edge_structure).filter(Boolean));
      const nodeStructuralCols = new Set(Object.values(node_structure).filter(Boolean));
      const edgeProperties = edgeTableColumns.value
        .filter((col) => !edgeStructuralCols.has(col.name))
        .map((col) => ({ name: col.name, data_type: col.data_type }));
      const nodeProperties = nodeTableColumns.value
        .filter((col) => !nodeStructuralCols.has(col.name))
        .map((col) => ({ name: col.name, data_type: col.data_type }));

      saved = await contextsStore.createContext({
        title: form.value.title,
        description: form.value.description || undefined,
        tags,
        datasource_type: form.value.datasource_type,
        edge_table_name: form.value.edge_table_name,
        node_table_name: form.value.node_table_name,
        edge_structure,
        node_structure,
        edge_properties: edgeProperties.length > 0 ? edgeProperties : undefined,
        node_properties: nodeProperties.length > 0 ? nodeProperties : undefined,
        node_types: nodeTypes.length > 0 ? nodeTypes : undefined,
        relationship_types: relationshipTypes.length > 0 ? relationshipTypes : undefined,
        default_behaviors: defaultBehaviors,
      });
    } else {
      if (!props.context) return;
      // node_properties/edge_properties deliberately omitted — see the
      // component doc comment. Only fields this form actually edits are sent.
      saved = await contextsStore.updateContext(props.context.id, {
        title: form.value.title,
        description: form.value.description || undefined,
        tags,
        // Structure is meaningless without tables, so a table-less context
        // sends only what it actually has.
        ...(showTableConfig.value ? { edge_structure, node_structure } : {}),
        node_types: nodeTypes,
        relationship_types: relationshipTypes,
        default_behaviors: defaultBehaviors ?? {},
      });
    }

    emit('saved', saved);
  } catch (e) {
    console.error(e);
  }
}
</script>

<template>
  <div
    v-if="open"
    class="modal-overlay"
    data-testid="create-context-modal"
    @click.self="emit('close')"
  >
    <div class="modal">
      <div class="modal-header">
        <h2>{{ mode === 'edit' ? `Edit "${context?.title}"` : 'Create Graph Context' }}</h2>
        <button class="modal-close" @click="emit('close')">&times;</button>
      </div>

      <form @submit.prevent="submit">
        <!-- Picked first: the datasource decides how much of this form exists. -->
        <div v-if="showDatasourcePicker" class="form-group">
          <label>Datasource</label>
          <div class="datasource-picker" data-testid="datasource-picker">
            <button
              v-for="option in datasourceOptions"
              :key="option.id"
              type="button"
              class="datasource-option"
              :class="{
                selected: selectedDatasource.id === option.id,
                disabled: mode === 'edit',
              }"
              :disabled="mode === 'edit'"
              :data-testid="`datasource-option-${option.id}`"
              @click="selectDatasource(option)"
            >
              <span class="datasource-head">
                <span class="datasource-name">{{ option.copy.label }}</span>
                <span class="datasource-kind">{{ option.copy.kind }}</span>
              </span>
              <span class="datasource-tagline">{{ option.copy.tagline }}</span>
              <span class="datasource-desc">{{ option.copy.description }}</span>
              <span class="datasource-caveat">{{ option.copy.caveat }}</span>
            </button>
          </div>
          <span v-if="mode === 'edit'" class="hint">
            The datasource cannot be changed after creation.
          </span>
        </div>

        <div class="form-group">
          <label>Title *</label>
          <input
            v-model="form.title"
            type="text"
            class="form-control"
            placeholder="My Graph Context"
            required
          />
        </div>

        <div class="form-group">
          <label>Description</label>
          <textarea
            v-model="form.description"
            class="form-control"
            rows="3"
            placeholder="Optional description..."
          ></textarea>
        </div>

        <!-- Everything below is table-backed configuration; a native graph
             database has no tables and discovers its own structure. -->
        <template v-if="showTableConfig">
        <!-- Table selection: live selects in create mode, immutable text in edit mode -->
        <template v-if="mode === 'create'">
          <div class="form-group">
            <label>Edge Table *</label>
            <select v-model="form.edge_table_name" class="form-control" required>
              <option value="" disabled>Select edge table...</option>
              <option v-for="table in availableEdgeTables" :key="'edge-' + table" :value="table">
                {{ table }}
              </option>
            </select>
            <span v-if="availableEdgeTables.length === 0" class="hint">No edge tables available. Generate a graph first.</span>
          </div>

          <div class="form-group">
            <label>Node Table *</label>
            <select v-model="form.node_table_name" class="form-control" required>
              <option value="" disabled>Select node table...</option>
              <option v-for="table in availableNodeTables" :key="'node-' + table" :value="table">
                {{ table }}
              </option>
            </select>
            <span v-if="availableNodeTables.length === 0" class="hint">No node tables available. Generate a graph first.</span>
          </div>
        </template>
        <template v-else>
          <div class="form-group">
            <label>Edge Table</label>
            <input
              type="text"
              class="form-control"
              :value="form.edge_table_name"
              disabled
              title="Table names cannot be changed after creation. Delete and recreate the context to point at a different table."
            />
          </div>
          <div class="form-group">
            <label>Node Table</label>
            <input
              type="text"
              class="form-control"
              :value="form.node_table_name"
              disabled
              title="Table names cannot be changed after creation. Delete and recreate the context to point at a different table."
            />
          </div>
        </template>

        <!-- Edge Column Mapping -->
        <div class="column-config-section">
          <div class="section-header-row">
            <h4>Edge Table Columns</h4>
            <span v-if="loadingEdgeSchema" class="loading-indicator">Loading...</span>
            <button
              v-else-if="mode === 'create' && form.edge_table_name"
              type="button"
              class="btn btn-sm btn-outline"
              @click="fetchEdgeTableSchema"
            >
              Refresh
            </button>
          </div>
          <div v-if="schemaError && form.edge_table_name" class="schema-error">{{ schemaError }}</div>
          <div class="form-row">
            <div class="form-group">
              <label>Source Column *</label>
              <select
                v-if="mode === 'create' && edgeTableColumns.length > 0"
                v-model="form.src_col"
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
                v-model="form.src_col"
                type="text"
                class="form-control"
                placeholder="src"
                required
              />
            </div>
            <div class="form-group">
              <label>Destination Column *</label>
              <select
                v-if="mode === 'create' && edgeTableColumns.length > 0"
                v-model="form.dst_col"
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
                v-model="form.dst_col"
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
                v-if="mode === 'create' && edgeTableColumns.length > 0"
                v-model="form.relationship_type_col"
                class="form-control"
              >
                <option value="">None</option>
                <option v-for="col in edgeTableColumns" :key="col.name" :value="col.name">
                  {{ col.name }} ({{ col.data_type }})
                </option>
              </select>
              <input
                v-else
                v-model="form.relationship_type_col"
                type="text"
                class="form-control"
                placeholder="relationship_type"
              />
            </div>
            <div class="form-group">
              <label>Edge ID Column</label>
              <select
                v-if="mode === 'create' && edgeTableColumns.length > 0"
                v-model="form.edge_id_col"
                class="form-control"
              >
                <option value="">None</option>
                <option v-for="col in edgeTableColumns" :key="col.name" :value="col.name">
                  {{ col.name }} ({{ col.data_type }})
                </option>
              </select>
              <input
                v-else
                v-model="form.edge_id_col"
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
              v-else-if="mode === 'create' && form.node_table_name"
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
                v-if="mode === 'create' && nodeTableColumns.length > 0"
                v-model="form.node_id_col"
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
                v-model="form.node_id_col"
                type="text"
                class="form-control"
                placeholder="node_id"
                required
              />
            </div>
            <div class="form-group">
              <label>Node Type Column</label>
              <select
                v-if="mode === 'create' && nodeTableColumns.length > 0"
                v-model="form.node_type_col"
                class="form-control"
              >
                <option value="">None</option>
                <option v-for="col in nodeTableColumns" :key="col.name" :value="col.name">
                  {{ col.name }} ({{ col.data_type }})
                </option>
              </select>
              <input
                v-else
                v-model="form.node_type_col"
                type="text"
                class="form-control"
                placeholder="node_type"
              />
            </div>
          </div>
        </div>

        </template>

        <!-- Schema Types — every datasource has types; only how they are
             discovered differs. -->
        <div class="column-config-section">
          <div class="section-header-row">
            <h4>Schema Types</h4>
            <!-- Available in edit mode too: discovery only reads the type columns
                 (SELECT DISTINCT) and rewrites these two text fields. It never
                 touches node_properties/edge_properties, so it does not bypass the
                 schema-diff review the way a property recomputation here would. -->
            <button
              v-if="showDiscoverButton"
              type="button"
              class="btn btn-sm btn-outline"
              data-testid="discover-types-btn"
              :disabled="loadingSchemaDiscovery || !canDiscoverTypes"
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
                v-model="form.node_types"
                type="text"
                class="form-control"
                placeholder="Person, Company, Product"
              />
              <span class="hint">Comma-separated (or click Discover)</span>
            </div>
            <div class="form-group">
              <label>Relationship Types</label>
              <input
                v-model="form.relationship_types"
                type="text"
                class="form-control"
                placeholder="KNOWS, WORKS_AT, OWNS"
              />
              <span class="hint">Comma-separated (or click Discover)</span>
            </div>
          </div>
        </div>

        <p v-if="mode === 'edit'" class="hint">
          Property columns aren't edited here — use "Check schema" on the context card
          to review and resync them against the live table.
        </p>

        <div class="form-group">
          <label>Tags</label>
          <input
            v-model="form.tags"
            type="text"
            class="form-control"
            placeholder="env:prod, team:data, project:analytics"
          />
          <span class="hint">Comma-separated, use name:value format (e.g., env:prod)</span>
        </div>

        <div class="form-group">
          <label>Default Behaviors</label>
          <textarea
            v-model="form.default_behaviors"
            class="form-control"
            rows="3"
            spellcheck="false"
            data-testid="create-context-default-behaviors"
            placeholder='{"autoLoadOnOpen": true, "viewMode": "3d"}'
          />
          <span v-if="defaultBehaviorsError" class="hint hint-error">
            {{ defaultBehaviorsError }}
          </span>
          <span v-else class="hint">
            Optional JSON. Graph settings applied when this context is opened — useful
            when a graph's size or shape needs different defaults. Users can still change
            them in the Behaviors panel, and a saved exploration takes precedence.
          </span>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-outline" @click="emit('close')">
            Cancel
          </button>
          <button
            type="submit"
            class="btn btn-primary"
            data-testid="create-context-submit"
            :disabled="contextsStore.loading || !!defaultBehaviorsError"
          >
            {{ mode === 'edit' ? 'Save' : 'Create' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.datasource-picker {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px;
}

.datasource-option {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  text-align: left;
  border: 1px solid var(--border-color, #d0d7de);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  color: inherit;
}

.datasource-option:hover:not(.disabled) {
  border-color: var(--accent-color, #0969da);
}

.datasource-option.selected {
  border-color: var(--accent-color, #0969da);
  box-shadow: inset 0 0 0 1px var(--accent-color, #0969da);
}

.datasource-option.disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.datasource-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.datasource-name {
  font-weight: 600;
  font-size: 0.9rem;
}

.datasource-kind {
  font-size: 0.7rem;
  opacity: 0.6;
  white-space: nowrap;
}

/* The workload, not the product — this is the line that decides the choice. */
.datasource-tagline {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--accent-color, #0969da);
}

.datasource-desc {
  font-size: 0.75rem;
  opacity: 0.75;
  line-height: 1.35;
}

/* The trade-off. Set apart so it reads as a condition of the choice rather
   than more marketing, and never collapsed into the description above. */
.datasource-caveat {
  font-size: 0.72rem;
  line-height: 1.35;
  padding-top: 6px;
  border-top: 1px dashed var(--border-color, #d0d7de);
  opacity: 0.8;
}

.hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

.hint-error {
  color: var(--error-color);
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
</style>
