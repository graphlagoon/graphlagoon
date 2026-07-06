<script setup lang="ts">
/**
 * Query Console — a resizable bottom drawer to run a generic OpenCypher/SQL
 * query and view the raw tabular result. Distinct from DataTablePanel (which
 * mirrors the visualization's nodes/edges): here any projection is allowed and
 * results are shown as arbitrary columns/rows via <DataGrid>.
 */
import { ref, computed, onMounted } from 'vue';
import { X, Play } from 'lucide-vue-next';
import CypherEditor from './CypherEditor.vue';
import DataGrid from './DataGrid.vue';
import { useGraphStore } from '@/stores/graph';
import { useQueryConsoleStore } from '@/stores/queryConsole';
import { useDrawerResize } from '@/composables/useDrawerResize';

const emit = defineEmits<{ (e: 'close'): void }>();

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

const dataGridRef = ref<InstanceType<typeof DataGrid>>();

const placeholder = computed(() =>
  consoleStore.mode === 'cypher'
    ? 'MATCH (n:Person) RETURN n.node_id, n.name LIMIT 100'
    : 'SELECT * FROM nodes LIMIT 100',
);

const helpText = computed(() =>
  consoleStore.mode === 'cypher'
    ? 'OpenCypher — any projection allowed (e.g. RETURN n.name, count(*)).'
    : 'Read-only Spark SQL (SELECT only).',
);

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

// Optional peek at the transpiled SQL (cypher mode).
const showTranspiled = ref(false);

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

// Seed a helpful, editable example query the first time the console opens.
onMounted(() => {
  if (!consoleStore.cypherQuery) {
    const ctx = graphStore.currentContext;
    const idCol = ctx?.node_structure?.node_id_col || 'node_id';
    const label = ctx?.node_types?.[0] ? `:${ctx.node_types[0]}` : '';
    consoleStore.cypherQuery = `MATCH (n${label})\nRETURN n.${idCol}\nLIMIT 100`;
  }
  if (!consoleStore.sqlQuery) {
    const table = graphStore.currentContext?.node_table_name || 'nodes';
    consoleStore.sqlQuery = `SELECT * FROM ${table} LIMIT 100`;
  }
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
        <div class="mode-toggle">
          <button
            class="mode-btn"
            :class="{ active: consoleStore.mode === 'cypher' }"
            data-testid="query-console-mode-cypher"
            @click="setMode('cypher')"
          >
            OpenCypher
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
        <button class="action-btn" title="Clear query" @click="consoleStore.clearQuery">Clear</button>
        <button class="action-btn" title="Export CSV" :disabled="!showResults" @click="exportCSV">CSV</button>
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
      <div v-if="consoleStore.loading" class="results-state">
        <div class="loading"></div>
        <span>Running query…</span>
      </div>

      <div v-else-if="consoleStore.error" class="results-state error" data-testid="query-console-error">
        <p class="error-title">Query failed</p>
        <p class="error-message">{{ consoleStore.error }}</p>
      </div>

      <DataGrid
        v-else-if="showResults"
        ref="dataGridRef"
        :columns="consoleStore.columns"
        :rows="consoleStore.rows"
        :export-filename="exportFilename"
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
      <span v-if="consoleStore.hasRun && !consoleStore.error">
        {{ consoleStore.rowCount }} row{{ consoleStore.rowCount === 1 ? '' : 's' }}
        <span v-if="consoleStore.truncated" class="truncated-note">
          — showing first {{ consoleStore.rowCount }} (truncated)
        </span>
      </span>
      <span v-else></span>
      <button
        v-if="consoleStore.transpiledSql"
        class="link-btn"
        @click="showTranspiled = !showTranspiled"
      >
        {{ showTranspiled ? 'Hide' : 'Show' }} transpiled SQL
      </button>
    </div>
    <pre v-if="showTranspiled && consoleStore.transpiledSql" class="transpiled-sql">{{ consoleStore.transpiledSql }}</pre>
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

.close-btn {
  padding: 2px 8px;
  line-height: 1;
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

.link-btn {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 11px;
  color: var(--primary-color, #42b883);
  text-decoration: underline;
}

.transpiled-sql {
  margin: 0;
  padding: 8px 12px;
  max-height: 120px;
  overflow: auto;
  font-family: monospace;
  font-size: 11px;
  background: var(--bg-secondary, #f5f5f5);
  border-top: 1px solid var(--border-color, #ddd);
  white-space: pre-wrap;
  word-break: break-all;
  flex-shrink: 0;
}
</style>
