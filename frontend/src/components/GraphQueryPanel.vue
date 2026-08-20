<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useToast } from '@/composables/useToast';
import CypherEditor from './CypherEditor.vue';
import TranspileSettingsModal from './TranspileSettingsModal.vue';
import {
  useDatasourceCapabilities,
  useDatasourceDescriptor,
} from '@/composables/useDatasourceCapabilities';
import { generateBfsExampleQuery } from '@/utils/exampleQuery';
import { X, SlidersHorizontal } from 'lucide-vue-next';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const graphStore = useGraphStore();
const toast = useToast();

// Get node and relationship types from current context for autocomplete
const nodeTypes = computed(() => graphStore.currentContext?.node_types || []);
const relationshipTypes = computed(() => graphStore.currentContext?.relationship_types || []);
const nodeProperties = computed(() => graphStore.currentContext?.node_properties || []);
const edgeProperties = computed(() => graphStore.currentContext?.edge_properties || []);

// Generate example query based on context schema and displayed nodes.
// The BFS shape (RETURN r, dynamic node_id_col, no hardcoded label) lives in
// the pure util so it can be unit-tested — see utils/exampleQuery.ts.
function generateExampleQuery(): string {
  const displayedNodes = graphStore.filteredNodes.length > 0
    ? graphStore.filteredNodes
    : graphStore.nodes;
  return generateBfsExampleQuery(graphStore.currentContext, displayedNodes);
}

type QueryMode = 'cypher' | 'sql';
const queryMode = ref<QueryMode>('cypher');
const cypherQuery = ref('');
const sqlQuery = ref('SELECT * FROM nodes LIMIT 100');
const isProcessing = ref(false);

// CTE pre-filter state
const ctePrefilterEnabled = ref(false);
const ctePrefilterText = computed({
  get: () => graphStore.ctePrefilter,
  set: (val: string) => { graphStore.ctePrefilter = val; },
});

// When checkbox is disabled, clear the store value
watch(ctePrefilterEnabled, (enabled) => {
  if (!enabled) {
    graphStore.ctePrefilter = '';
  }
});

// When exploration loads with a CTE, auto-enable checkbox
watch(() => graphStore.ctePrefilter, (val) => {
  if (val && val.trim()) {
    ctePrefilterEnabled.value = true;
  }
}, { immediate: true });

const capabilities = useDatasourceCapabilities(computed(() => graphStore.currentContext));
const datasource = useDatasourceDescriptor(computed(() => graphStore.currentContext));
// A REST connection's query language is opaque to the frontend: no Cypher
// heuristics apply, and placeholder/example text comes from the connection.
const isRestContext = computed(() => datasource.value.type === 'rest');

// Show edge structure columns as a hint. Column names only mean something for a
// table-backed datasource; a native graph database has labels, not columns.
const edgeStructureHint = computed(() => {
  if (!capabilities.value.supportsCatalog) return '';
  const ctx = graphStore.currentContext;
  if (!ctx?.edge_structure) return '';
  const es = ctx.edge_structure;
  const cols = [es.src_col, es.dst_col, es.relationship_type_col, es.edge_id_col].filter(Boolean);
  return `Required columns: ${cols.join(', ')}`;
});

// A backend that speaks Cypher natively always runs the query directly: there
// is no SQL to review, so the transpile two-step (and the "In Messi We Trust"
// toggle that governs it) simply does not exist there.
const runsDirectly = computed(
  () => !capabilities.value.supportsTranspile || inMessiWeTrust.value,
);

// Watch for context changes to update example query
watch(() => graphStore.currentContext, (context) => {
  if (!context) return;

  // Check if there's a saved query from exploration. The MATCH gate is a
  // Cypher heuristic — an opaque REST query language has no such marker, so
  // any non-empty saved query is accepted there.
  const savedQuery = graphStore.graphQuery;
  const looksUsable = isRestContext.value
    ? Boolean(savedQuery && savedQuery.trim())
    : Boolean(savedQuery && savedQuery.trim().toUpperCase().startsWith('MATCH'));
  if (savedQuery && looksUsable) {
    cypherQuery.value = savedQuery;
  } else {
    // Generate example based on context types
    cypherQuery.value = generateExampleQuery();
  }
}, { immediate: true });

// Watch for exploration load or template execution to update query
watch(() => graphStore.graphQuery, (newQuery) => {
  if (!newQuery) return;
  if (isRestContext.value || newQuery.trim().toUpperCase().startsWith('MATCH')) {
    cypherQuery.value = newQuery;
    queryMode.value = 'cypher';
  } else if (newQuery.trim().toUpperCase().startsWith('SELECT') && capabilities.value.supportsSql) {
    sqlQuery.value = newQuery;
    queryMode.value = 'sql';
  }
});

// Switching to a context without SQL must not leave the panel stuck in a mode
// it can no longer run (e.g. after loading an exploration from another context).
watch(
  () => capabilities.value.supportsSql,
  (supportsSql) => {
    if (!supportsSql) queryMode.value = 'cypher';
  },
  { immediate: true },
);

// Sync transpiled SQL (immediate to catch value set while panel was closed)
watch(() => graphStore.lastTranspiledSql, (sql) => {
  if (sql) {
    sqlQuery.value = sql;
  }
}, { immediate: true });

// Validate cypher query structure
function validateCypherQuery(query: string): { valid: boolean; error: string | null } {
  const trimmed = query.trim();
  if (!trimmed) {
    return { valid: false, error: null }; // Empty is invalid but no error shown
  }

  // Opaque query language: the connection defines its own grammar, so the
  // only thing worth checking client-side is that something was typed.
  if (isRestContext.value) {
    return { valid: true, error: null };
  }

  const upper = trimmed.toUpperCase();

  // Must start with MATCH
  if (!upper.startsWith('MATCH')) {
    return { valid: false, error: 'Query must start with MATCH' };
  }

  // "RETURN r" is a transpiler contract: the generated SQL projects edges as a
  // NAMED_STRUCT column literally named `r`. A native graph database returns
  // real nodes and relationships from any projection, so requiring a specific
  // variable name there would reject perfectly good queries (RETURN p).
  if (capabilities.value.supportsTranspile) {
    if (!/\bRETURN\s+(?:DISTINCT\s+)?r\b/i.test(trimmed)) {
      return { valid: false, error: 'Must have RETURN r (or RETURN DISTINCT r)' };
    }
  } else if (!/\bRETURN\b/i.test(trimmed)) {
    return { valid: false, error: 'Query must have a RETURN clause' };
  }

  return { valid: true, error: null };
}

// Real-time validation for cypher queries
const cypherValidation = computed(() => validateCypherQuery(cypherQuery.value));

// Check if action button should be disabled
const isActionDisabled = computed(() => {
  if (isProcessing.value) return true;
  if (graphStore.loading) return true; // Disable if any graph operation is in progress
  if (!query.value.trim()) return true;
  if (queryMode.value === 'cypher' && !cypherValidation.value.valid) return true;
  return false;
});

// Get the active query based on mode
const query = computed({
  get: () => queryMode.value === 'cypher' ? cypherQuery.value : sqlQuery.value,
  set: (val: string) => {
    if (queryMode.value === 'cypher') {
      cypherQuery.value = val;
    } else {
      sqlQuery.value = val;
    }
  }
});

// Save query to store when it changes
watch(query, (newQuery) => {
  graphStore.setGraphQuery(newQuery);
});

const placeholder = computed(() => {
  if (isRestContext.value) {
    return datasource.value.copy.queryPlaceholder || 'Query for this connection';
  }
  return queryMode.value === 'cypher'
    ? 'MATCH (s:Person)-[r:KNOWS]->(d) RETURN r'
    : 'SELECT * FROM nodes WHERE node_type = \'Person\'';
});

const helpText = computed(() => {
  if (isRestContext.value) {
    const language = datasource.value.copy.queryLanguage || 'query';
    return `${language} — sent to the connection as-is.`;
  }
  return queryMode.value === 'cypher'
    ? 'OpenCypher query. Must end with RETURN r.'
    : 'Spark SQL query. Click "Run" to execute and visualize results.';
});

const inMessiWeTrust = computed({
  get: () => graphStore.behaviors.inMessiWeTrust,
  set: (val: boolean) => graphStore.updateBehaviors({ inMessiWeTrust: val }),
});

// Advanced transpile & optimization settings (procedural BFS, materialization,
// per-optimization flags, large results mode) live in a shared modal, opened
// from the gear icon in the panel header.
const showTranspileSettings = ref(false);

const buttonLabel = computed(() => {
  if (isProcessing.value || graphStore.loading) {
    if (queryMode.value === 'cypher') {
      return runsDirectly.value ? 'Running...' : 'Transpiling...';
    }
    return 'Running...';
  }
  if (queryMode.value === 'cypher') {
    return runsDirectly.value ? 'Run Query' : 'Transpile to SQL';
  }
  return 'Run Query';
});

async function handleAction() {
  if (isActionDisabled.value) return;

  isProcessing.value = true;

  try {
    if (queryMode.value === 'cypher') {
      if (runsDirectly.value) {
        // In Messi We Trust: submit the Cypher itself — the backend transpiles
        // at submit time and the store owns the CTE fallback, so a failed
        // procedural run (transpile OR execution) is retried in CTE mode.
        // The transpile-then-execute-SQL two-step would bypass that fallback.
        const sql = await graphStore.executeCypherQuery(cypherQuery.value);
        // Keep the SQL tab in sync with what actually ran (fallback included).
        if (sql) sqlQuery.value = sql;
        if (graphStore.queryError) {
          toast.error(`Query failed: ${graphStore.queryError.message}`);
        } else {
          toast.success(`Loaded ${graphStore.nodes.length} nodes and ${graphStore.edges.length} edges`);
        }
      } else {
        // Normal flow: transpile (with CTE fallback) and switch to SQL mode
        // for review.
        const sql = await graphStore.transpileCypher(cypherQuery.value);
        if (sql) {
          sqlQuery.value = sql;
          // Save the Cypher query for exploration state
          graphStore.setGraphQuery(cypherQuery.value);
          queryMode.value = 'sql';
          toast.success('Query transpiled successfully');
        } else if (graphStore.queryError) {
          toast.error(`Transpile failed: ${graphStore.queryError.message}`);
        }
      }
    } else {
      // Execute SQL query
      await graphStore.executeGraphQuery(sqlQuery.value);
      // queryError, not error — query failures land in queryError; `error` is
      // the context-load error and stays null here, which made the old check
      // report success for failed runs.
      if (graphStore.queryError) {
        toast.error(`Query failed: ${graphStore.queryError.message}`);
      } else {
        toast.success(`Loaded ${graphStore.nodes.length} nodes and ${graphStore.edges.length} edges`);
      }
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : 'Unknown error';
    toast.error(`Error: ${errorMsg}`);
  } finally {
    isProcessing.value = false;
  }
}



function setMode(mode: QueryMode) {
  queryMode.value = mode;
}
</script>

<template>
  <div class="query-panel">
    <div class="panel-header">
      <h3>Graph Query</h3>
      <div class="header-actions">
        <button
          v-if="capabilities.supportsTranspile"
          class="btn-icon-only settings-btn"
          :class="{ active: graphStore.vlpRenderingMode === 'procedural' }"
          title="Advanced transpile & optimization settings"
          data-testid="graph-query-settings"
          @click="showTranspileSettings = true"
        >
          <SlidersHorizontal :size="16" />
        </button>
        <button class="btn-icon-only close-btn" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <div v-if="capabilities.supportsSql" class="mode-toggle">
      <button
        class="mode-btn"
        :class="{ active: queryMode === 'cypher' }"
        @click="setMode('cypher')"
      >
        OpenCypher
      </button>
      <button
        class="mode-btn"
        :class="{ active: queryMode === 'sql' }"
        data-testid="graph-query-mode-sql"
        @click="setMode('sql')"
      >
        SQL
      </button>
    </div>

    <div class="query-section">
      <label>{{ queryMode === 'cypher' ? 'OpenCypher Query' : 'SQL Query' }}</label>

      <!-- Cypher mode: CodeMirror editor with syntax highlighting -->
      <CypherEditor
        v-if="queryMode === 'cypher'"
        v-model="cypherQuery"
        :placeholder="placeholder"
        :disabled="isProcessing"
        :has-error="!!cypherValidation.error"
        :node-types="nodeTypes"
        :relationship-types="relationshipTypes"
        :node-properties="nodeProperties"
        :edge-properties="edgeProperties"
      />

      <!-- SQL mode: plain textarea -->
      <textarea
        v-else
        id="query"
        v-model="sqlQuery"
        rows="6"
        :placeholder="placeholder"
        :disabled="isProcessing"
        data-testid="graph-query-sql"
      ></textarea>

      <p v-if="queryMode === 'cypher' && cypherValidation.error" class="error-text">
        {{ cypherValidation.error }}
      </p>
      <p v-else class="help-text">{{ helpText }}</p>

      <!-- In Messi We Trust option - only visible in cypher mode -->
      <label
        v-if="queryMode === 'cypher' && capabilities.supportsTranspile"
        class="checkbox-label messi-option"
      >
        <input
          type="checkbox"
          v-model="inMessiWeTrust"
          :disabled="isProcessing"
        />
        <span>Trust transpiled SQL</span>
        <span class="messi-hint">(trust the experimental gsql2rsql )</span>
      </label>
    </div>

    <!-- CTE Pre-filter Section - only in cypher mode -->
    <div
      v-if="queryMode === 'cypher' && capabilities.supportsCtePrefilter"
      class="cte-section"
    >
      <label class="checkbox-label cte-option">
        <input
          type="checkbox"
          v-model="ctePrefilterEnabled"
          :disabled="isProcessing"
        />
        <span>Pre-filter edges (CTE)</span>
      </label>

      <div v-if="ctePrefilterEnabled" class="cte-editor">
        <p class="cte-hint">
          Define <code>MY_FINAL_EDGES</code> using <code>__EDGES__</code> as source table.
        </p>
        <p v-if="edgeStructureHint" class="cte-hint">{{ edgeStructureHint }}</p>
        <textarea
          v-model="ctePrefilterText"
          rows="5"
          placeholder="MY_FINAL_EDGES AS (&#10;  SELECT * FROM __EDGES__&#10;  WHERE relationship_type = 'KNOWS'&#10;)"
          :disabled="isProcessing"
          class="cte-textarea"
        ></textarea>
      </div>
    </div>

    <div class="query-actions">
      <button
        class="btn btn-primary btn-run"
        data-testid="graph-query-run"
        @click="handleAction"
        :disabled="isActionDisabled"
      >
        {{ buttonLabel }}
      </button>
    </div>

    <!-- Advanced transpile & optimization settings (shared with Query Console) -->
    <TranspileSettingsModal
      v-if="showTranspileSettings"
      @close="showTranspileSettings = false"
    />
  </div>
</template>

<style scoped>
.query-panel {
  width: 300px;
  background: var(--card-background);
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
}

.settings-btn {
  color: var(--text-muted, #666);
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  background: none;
}

.settings-btn:hover {
  background: var(--bg-secondary, #f0f0f0);
  color: var(--text-primary, #333);
}

.settings-btn.active {
  color: var(--primary-color, #42b883);
  border-color: var(--primary-color, #42b883);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.panel-header h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 4px;
}

.btn-sm {
  padding: 4px 8px;
  font-size: 12px;
}

.close-btn {
  font-size: 16px;
  padding: 2px 8px;
}

.mode-toggle {
  display: flex;
  margin-bottom: 16px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  overflow: hidden;
}

.mode-btn {
  flex: 1;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 500;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 0.15s;
  color: var(--text-muted, #666);
}

.mode-btn:hover:not(.active) {
  background: var(--bg-secondary, #f5f5f5);
}

.mode-btn.active {
  background: var(--primary-color, #42b883);
  color: white;
}

.query-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  margin-bottom: 16px;
}

.query-section label {
  display: block;
  margin-bottom: 6px;
  font-weight: 500;
  font-size: 14px;
}

.query-section textarea {
  flex: 1;
  min-height: 120px;
  padding: 10px 12px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
  resize: vertical;
  background: var(--bg-color, #fafafa);
}

.query-section textarea:focus {
  outline: none;
  border-color: var(--primary-color, #42b883);
  box-shadow: 0 0 0 2px rgba(66, 184, 131, 0.2);
}

.help-text {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-muted, #666);
}

.error-text {
  margin-top: 6px;
  font-size: 11px;
  color: var(--error-color, #e74c3c);
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  width: 14px;
  height: 14px;
  cursor: pointer;
}

.messi-option {
  margin-top: 10px;
  padding: 8px 10px;
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 6px;
  border: 1px solid var(--border-color, #ddd);
}

.messi-option:hover {
  background: var(--bg-tertiary, #eee);
}

.messi-hint {
  color: var(--text-muted, #666);
  font-size: 10px;
}

.query-section textarea.has-error {
  border-color: var(--error-color, #e74c3c);
}

.query-section textarea.has-error:focus {
  box-shadow: 0 0 0 2px rgba(231, 76, 60, 0.2);
}

.cte-section {
  margin-bottom: 16px;
}

.cte-option {
  padding: 8px 10px;
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 6px;
  border: 1px solid var(--border-color, #ddd);
}

.cte-option:hover {
  background: var(--bg-tertiary, #eee);
}

.cte-editor {
  margin-top: 8px;
}

.cte-hint {
  font-size: 11px;
  color: var(--text-muted, #666);
  margin: 4px 0;
  line-height: 1.4;
}

.cte-hint code {
  background: var(--bg-secondary, #f0f0f0);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 10px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
}

.cte-textarea {
  width: 100%;
  min-height: 80px;
  padding: 10px 12px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
  resize: vertical;
  background: var(--bg-color, #fafafa);
  box-sizing: border-box;
}

.cte-textarea:focus {
  outline: none;
  border-color: var(--primary-color, #42b883);
  box-shadow: 0 0 0 2px rgba(66, 184, 131, 0.2);
}

.query-actions {
  display: flex;
  gap: 8px;
}

.btn-run {
  flex: 1;
  padding: 10px 16px;
}

.btn {
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  border: 1px solid var(--border-color, #ddd);
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-outline {
  background: transparent;
  color: var(--text-color, #333);
}

.btn-outline:hover:not(:disabled) {
  background: var(--bg-secondary, #f5f5f5);
}

.btn-primary {
  background: var(--primary-color, #42b883);
  border-color: var(--primary-color, #42b883);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: var(--primary-hover, #3aa876);
}
</style>
