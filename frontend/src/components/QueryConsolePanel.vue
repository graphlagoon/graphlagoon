<script setup lang="ts">
/**
 * Query Console — a resizable bottom drawer to run a generic OpenCypher/SQL
 * query and view the raw tabular result. Distinct from DataTablePanel (which
 * mirrors the visualization's nodes/edges): here any projection is allowed and
 * results are shown as arbitrary columns/rows via <DataGrid>.
 */
import { ref, computed, onMounted } from 'vue';
import { X, Play, SlidersHorizontal } from 'lucide-vue-next';
import CypherEditor from './CypherEditor.vue';
import DataGrid from './DataGrid.vue';
import QueryErrorModal from './QueryErrorModal.vue';
import QueryRunningState from './QueryRunningState.vue';
import TemplateEditorModal from './TemplateEditorModal.vue';
import TranspileSettingsModal from './TranspileSettingsModal.vue';
import { useGraphStore } from '@/stores/graph';
import {
  useDatasourceCapabilities,
  useDatasourceDescriptor,
} from '@/composables/useDatasourceCapabilities';
import { useQueryConsoleStore } from '@/stores/queryConsole';
import { useDrawerResize } from '@/composables/useDrawerResize';
import { toDelimited } from '@/utils/tableExport';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'focus-node', nodeId: string): void;
}>();

const graphStore = useGraphStore();
const consoleStore = useQueryConsoleStore();

const { height, isResizing, onMouseDown } = useDrawerResize({
  initialHeight: 440,
  minHeight: 240,
  maxHeightRatio: 0.8,
});

// Autocomplete inputs for the Cypher editor (same source as GraphQueryPanel).
const nodeTypes = computed(() => graphStore.currentContext?.node_types || []);
const relationshipTypes = computed(() => graphStore.currentContext?.relationship_types || []);
const nodeProperties = computed(() => graphStore.currentContext?.node_properties || []);
const edgeProperties = computed(() => graphStore.currentContext?.edge_properties || []);

const capabilities = useDatasourceCapabilities(computed(() => graphStore.currentContext));
const datasource = useDatasourceDescriptor(computed(() => graphStore.currentContext));
const isRestContext = computed(() => datasource.value.type === 'rest');
/** What the single query mode is called — the connection's own language for REST. */
const queryModeLabel = computed(() =>
  isRestContext.value
    ? datasource.value.copy.queryLanguage || 'Query'
    : 'OpenCypher',
);

const dataGridRef = ref<InstanceType<typeof DataGrid>>();

const placeholder = computed(() =>
  consoleStore.mode === 'cypher'
    ? 'MATCH (n:Person) RETURN n.node_id, n.name LIMIT 100'
    : 'SELECT * FROM nodes LIMIT 100',
);

const helpText = computed(() => {
  if (isRestContext.value) {
    return `${queryModeLabel.value} — sent to the connection as-is; nodes come back as rows.`;
  }
  return consoleStore.mode === 'cypher'
    ? 'OpenCypher — any projection allowed (e.g. RETURN n.name, count(*)).'
    : 'Read-only Spark SQL (SELECT only).';
});

const runLabel = computed(() => (consoleStore.loading ? 'Running…' : 'Run'));
const runDisabled = computed(() => {
  if (consoleStore.loading) return true;
  const q = consoleStore.mode === 'cypher' ? consoleStore.cypherQuery : consoleStore.sqlQuery;
  return !q.trim();
});

const showResults = computed(
  () => consoleStore.hasRun && !consoleStore.error && consoleStore.columns.length > 0,
);
const showEmpty = computed(
  () => consoleStore.hasRun && !consoleStore.error && consoleStore.columns.length === 0,
);

const exportFilename = computed(
  () => `query-${graphStore.currentContext?.title || 'result'}`,
);

// The active query text for the current mode (used for save-as-template).
const activeQuery = computed(() =>
  consoleStore.mode === 'cypher' ? consoleStore.cypherQuery : consoleStore.sqlQuery,
);
const canSave = computed(() => activeQuery.value.trim().length > 0);

// Detect which result column holds the node id, so its cells can bridge to the
// 3D graph. Matches the context's node_id_col (or a literal "node_id" column).
const nodeIdField = computed<string | undefined>(() => {
  const idCol = capabilities.value.supportsCatalog
    ? graphStore.currentContext?.node_structure?.node_id_col
    : undefined;
  // '~id' is what a native graph database labels its identity column when a
  // query projects one (e.g. RETURN id(n) AS `~id`).
  const candidates = [idCol, 'node_id', '~id']
    .filter(Boolean)
    .map(s => String(s).toLowerCase());
  const col = consoleStore.columns.find(c => candidates.includes(c.header.toLowerCase()));
  return col?.field;
});

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '';
  return ms >= 100 ? `${Math.round(ms)}` : `${Math.round(ms * 10) / 10}`;
}

const showErrorModal = ref(false);
const showSaveTemplate = ref(false);
const showTranspileSettings = ref(false);
const copied = ref(false);

// Surface a hint on the gear when procedural BFS is active for cypher queries.
const transpileActive = computed(
  () => consoleStore.mode === 'cypher' && graphStore.vlpRenderingMode === 'procedural',
);

function setMode(mode: 'cypher' | 'sql') {
  consoleStore.mode = mode;
}

function run() {
  if (runDisabled.value) return;
  consoleStore.runQuery();
}

function onEditorKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    run();
  }
}

function exportCSV() {
  dataGridRef.value?.exportCSV();
}

async function copyResult() {
  const tsv = toDelimited(consoleStore.rawColumns, consoleStore.rawRows, '\t');
  await navigator.clipboard.writeText(tsv);
  copied.value = true;
  window.setTimeout(() => { copied.value = false; }, 1500);
}

// Clicking a node-id cell focuses + selects that node in the 3D graph.
function onFocusNode(payload: { id: string; multi: boolean }) {
  graphStore.selectNode(payload.id, payload.multi);
  emit('focus-node', payload.id);
}

// Seed a helpful, editable example query the first time the console opens.
onMounted(() => {
  if (!consoleStore.cypherQuery) {
    const ctx = graphStore.currentContext;
    const label = ctx?.node_types?.[0] ? `:${ctx.node_types[0]}` : '';
    if (isRestContext.value) {
      // Cypher shapes mean nothing to a REST connection; its spec ships the
      // example (possibly empty — better blank than gibberish).
      consoleStore.cypherQuery = datasource.value.copy.exampleQuery || '';
    } else if (capabilities.value.supportsCatalog) {
      const idCol = ctx?.node_structure?.node_id_col || 'node_id';
      consoleStore.cypherQuery = `MATCH (n${label})\nRETURN n.${idCol}\nLIMIT 100`;
    } else {
      consoleStore.cypherQuery = `MATCH (n${label})\nRETURN n\nLIMIT 100`;
    }
  }
  if (!consoleStore.sqlQuery && capabilities.value.supportsSql) {
    // Nodeless (triple-store-only) context: the edge table is the only real
    // table, so it is the only useful seed.
    const table =
      graphStore.currentContext?.node_table_name ||
      graphStore.currentContext?.edge_table_name ||
      'nodes';
    consoleStore.sqlQuery = `SELECT * FROM ${table} LIMIT 100`;
  }
  // Never leave the console in a mode this datasource cannot run.
  if (!capabilities.value.supportsSql) consoleStore.mode = 'cypher';
});
</script>

<template>
  <div class="query-console-drawer" :style="{ height: height + 'px' }" data-testid="query-console">
    <!-- Drag handle -->
    <div class="drawer-handle" :class="{ resizing: isResizing }" @mousedown="onMouseDown">
      <div class="handle-grip"></div>
    </div>

    <!-- Header -->
    <div class="drawer-header">
      <div class="header-left">
        <span class="drawer-title">Query Console</span>
        <div v-if="capabilities.supportsSql" class="mode-toggle">
          <button
            class="mode-btn"
            :class="{ active: consoleStore.mode === 'cypher' }"
            data-testid="query-console-mode-cypher"
            @click="setMode('cypher')"
          >
            {{ queryModeLabel }}
          </button>
          <button
            class="mode-btn"
            :class="{ active: consoleStore.mode === 'sql' }"
            data-testid="query-console-mode-sql"
            @click="setMode('sql')"
          >
            SQL
          </button>
        </div>
      </div>
      <div class="header-right">
        <button
          class="run-btn"
          :disabled="runDisabled"
          data-testid="query-console-run"
          @click="run"
        >
          <Play :size="13" />
          <span>{{ runLabel }}</span>
        </button>
        <button
          v-if="capabilities.supportsTranspile"
          class="action-btn btn-icon-only settings-btn"
          :class="{ active: transpileActive }"
          title="Advanced transpile & optimization settings"
          data-testid="query-console-settings"
          @click="showTranspileSettings = true"
        >
          <SlidersHorizontal :size="14" />
        </button>
        <button
          class="action-btn"
          title="Save this query as a reusable template"
          :disabled="!canSave"
          data-testid="query-console-save-template"
          @click="showSaveTemplate = true"
        >Save</button>
        <span class="btn-sep"></span>
        <button class="action-btn" title="Export CSV (respects filters)" :disabled="!showResults" @click="exportCSV">CSV</button>
        <button class="action-btn" title="Copy result to clipboard (TSV)" :disabled="!showResults" @click="copyResult">
          {{ copied ? 'Copied!' : 'Copy' }}
        </button>
        <button class="action-btn btn-icon-only close-btn" aria-label="Close" @click="emit('close')">
          <X :size="16" />
        </button>
      </div>
    </div>

    <!-- Editor -->
    <div class="editor-row" @keydown="onEditorKeydown">
      <CypherEditor
        v-if="consoleStore.mode === 'cypher'"
        v-model="consoleStore.cypherQuery"
        :placeholder="placeholder"
        :disabled="consoleStore.loading"
        :node-types="nodeTypes"
        :relationship-types="relationshipTypes"
        :node-properties="nodeProperties"
        :edge-properties="edgeProperties"
      />
      <textarea
        v-else
        v-model="consoleStore.sqlQuery"
        class="sql-textarea"
        rows="4"
        :placeholder="placeholder"
        :disabled="consoleStore.loading"
        data-testid="query-console-sql"
      ></textarea>
      <div class="editor-hint">
        <span>{{ helpText }}</span>
        <span class="kbd-hint">Ctrl/⌘ + Enter to run</span>
      </div>
    </div>

    <!-- Results -->
    <div class="results-area">
      <div v-if="consoleStore.loading" class="results-state" data-testid="query-console-loading">
        <QueryRunningState
          :can-cancel="consoleStore.canCancel"
          :chunk-progress="consoleStore.chunkProgress"
          @cancel="consoleStore.cancelQuery()"
        />
      </div>

      <div
        v-else-if="consoleStore.canceled"
        class="results-state hint"
        data-testid="query-console-canceled"
      >
        <span>Query canceled.</span>
      </div>

      <div v-else-if="consoleStore.error" class="results-state error" data-testid="query-console-error">
        <p class="error-title">
          <span v-if="consoleStore.error.code" class="error-code">{{ consoleStore.error.code }}</span>
          Query failed
        </p>
        <p class="error-message">{{ consoleStore.error.message }}</p>
        <button class="details-btn" data-testid="query-console-error-details" @click="showErrorModal = true">
          Details
        </button>
      </div>

      <DataGrid
        v-else-if="showResults"
        ref="dataGridRef"
        :columns="consoleStore.columns"
        :rows="consoleStore.rows"
        :export-filename="exportFilename"
        :node-id-field="nodeIdField"
        @focus-node="onFocusNode"
      />

      <div v-else-if="showEmpty" class="results-state">
        <span>Query returned no rows.</span>
      </div>

      <div v-else class="results-state hint">
        <span>Write a query and press Run to see results.</span>
      </div>
    </div>

    <!-- Footer -->
    <div class="drawer-footer">
      <span v-if="consoleStore.hasRun && !consoleStore.error" data-testid="query-console-footer">
        {{ consoleStore.rowCount }} row{{ consoleStore.rowCount === 1 ? '' : 's' }}
        <template v-if="consoleStore.columns.length"> · {{ consoleStore.columns.length }} col{{ consoleStore.columns.length === 1 ? '' : 's' }}</template>
        <template v-if="consoleStore.metadata?.total_ms != null">
          · {{ fmtMs(consoleStore.metadata.total_ms) }} ms<template v-if="consoleStore.metadata.transpilation_ms != null"> (transpile {{ fmtMs(consoleStore.metadata.transpilation_ms) }} ms)</template>
        </template>
        <span v-if="consoleStore.truncated" class="truncated-note">
          — showing first {{ consoleStore.rowCount }} (truncated)
        </span>
      </span>
      <span v-else></span>
    </div>

    <!-- Full error details (opened from the inline "Details" button) -->
    <QueryErrorModal
      v-if="showErrorModal"
      :error="consoleStore.error"
      @close="showErrorModal = false"
    />

    <!-- Save the current query as a reusable template -->
    <TemplateEditorModal
      v-if="showSaveTemplate"
      :template="null"
      :initial-query="activeQuery"
      :initial-query-type="consoleStore.mode"
      @close="showSaveTemplate = false"
    />

    <!-- Advanced transpile & optimization settings (shared with graph panel) -->
    <TranspileSettingsModal
      v-if="showTranspileSettings"
      @close="showTranspileSettings = false"
    />
  </div>
</template>

<style scoped>
.query-console-drawer {
  display: flex;
  flex-direction: column;
  background: var(--card-background, #fff);
  border-top: 1px solid var(--border-color, #ddd);
  overflow: hidden;
}

/* ─── Drag handle ─── */
.drawer-handle {
  height: 8px;
  cursor: ns-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary, #f5f5f5);
  border-bottom: 1px solid var(--border-color, #ddd);
  flex-shrink: 0;
}

.drawer-handle:hover,
.drawer-handle.resizing {
  background: var(--border-color, #ddd);
}

.handle-grip {
  width: 40px;
  height: 3px;
  border-radius: 2px;
  background: var(--text-muted, #999);
  opacity: 0.5;
}

.drawer-handle:hover .handle-grip {
  opacity: 0.8;
}

/* ─── Header ─── */
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color, #ddd);
  flex-shrink: 0;
}

.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.drawer-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-color, #333);
}

.mode-toggle {
  display: flex;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  overflow: hidden;
}

.mode-btn {
  padding: 4px 10px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted, #666);
  transition: all 0.15s;
}

.mode-btn.active {
  background: var(--primary-color, #42b883);
  color: white;
}

.mode-btn:not(.active):hover {
  background: var(--bg-secondary, #f5f5f5);
}

.run-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border: 1px solid var(--primary-color, #42b883);
  border-radius: 4px;
  background: var(--primary-color, #42b883);
  color: white;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  transition: all 0.15s;
}

.run-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-btn {
  padding: 4px 8px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  background: none;
  cursor: pointer;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted, #666);
  transition: all 0.15s;
}

.action-btn:hover:not(:disabled) {
  background: var(--bg-secondary, #f5f5f5);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.settings-btn {
  display: inline-flex;
  align-items: center;
  padding: 4px 6px;
}

.settings-btn.active {
  color: var(--primary-color, #42b883);
  border-color: var(--primary-color, #42b883);
}

.close-btn {
  padding: 2px 8px;
  line-height: 1;
}

.btn-sep {
  width: 1px;
  height: 18px;
  background: var(--border-color, #ddd);
  margin: 0 2px;
}

/* ─── Editor ─── */
.editor-row {
  flex-shrink: 0;
  padding: 8px 12px 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sql-textarea {
  width: 100%;
  font-family: monospace;
  font-size: 12px;
  padding: 8px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  resize: vertical;
  box-sizing: border-box;
}

/* Keep the editor bounded so the results table always has room. */
.editor-row :deep(.cm-editor) {
  max-height: 160px;
}

.editor-row :deep(.cm-scroller) {
  overflow: auto;
}

.editor-hint {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-muted, #999);
}

.kbd-hint {
  opacity: 0.8;
}

/* ─── Results ─── */
.results-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column; /* so the DataGrid stretches to full width */
  overflow: hidden;
  padding: 4px 4px 0;
}

.results-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted, #999);
}

.results-state.error {
  color: var(--color-error, #e53e3e);
}

.error-title {
  font-weight: 600;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.error-code {
  font-family: monospace;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(229, 62, 62, 0.12);
  color: var(--color-error, #e53e3e);
}

.error-message {
  margin: 0;
  max-width: 600px;
  text-align: center;
  font-family: monospace;
  font-size: 11px;
  color: var(--text-muted, #777);
  word-break: break-word;
}

.details-btn {
  border: 1px solid var(--border-color, #ddd);
  background: var(--card-background, #fff);
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  color: var(--text-color, #333);
}

.details-btn:hover {
  background: var(--bg-secondary, #f5f5f5);
}

/* ─── Footer ─── */
.drawer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  font-size: 11px;
  color: var(--text-muted, #999);
  border-top: 1px solid var(--border-color, #ddd);
  flex-shrink: 0;
}

.truncated-note {
  color: var(--color-warning, #d69e2e);
}
</style>
