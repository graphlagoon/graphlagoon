<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useToast } from '@/composables/useToast';
import CypherEditor from './CypherEditor.vue';
import { X } from 'lucide-vue-next';

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

// Generate example query based on context types and displayed nodes
function generateExampleQuery(): string {
  const context = graphStore.currentContext;
  if (!context) {
    return 'MATCH (root { node_id: "{node_id_value}" })\nMATCH p = (root)-[*1..2]-()\nUNWIND relationships(p) AS r\nRETURN r';
  }

  // Get the node_id column name from context
  const nodeIdCol = context.node_structure?.node_id_col || 'node_id';

  // Try to get a random node from the displayed nodes
  const displayedNodes = graphStore.filteredNodes.length > 0
    ? graphStore.filteredNodes
    : graphStore.nodes;

  if (displayedNodes.length > 0) {
    // Pick a random node
    const randomIndex = Math.floor(Math.random() * displayedNodes.length);
    const randomNode = displayedNodes[randomIndex];
    const nodeIdValue = randomNode.node_id;

    // Generate traversal query from this node (BFS 1-2 hops)
    return `MATCH (root { ${nodeIdCol}: "${nodeIdValue}" })
MATCH p = (root)-[*1..2]-()
UNWIND relationships(p) AS r
RETURN r`;
  }

  // Fallback: BFS query with placeholders for user to replace
  const nodeTypeLabel = context.node_types?.[0] ? `:${context.node_types[0]}` : '';

  return `MATCH (root${nodeTypeLabel} { ${nodeIdCol}: "{${nodeIdCol}_value}" })
MATCH p = (root)-[*1..2]-()
UNWIND relationships(p) AS r
RETURN r`;
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

// Show edge structure columns as a hint
const edgeStructureHint = computed(() => {
  const ctx = graphStore.currentContext;
  if (!ctx?.edge_structure) return '';
  const es = ctx.edge_structure;
  const cols = [es.src_col, es.dst_col, es.relationship_type_col, es.edge_id_col].filter(Boolean);
  return `Required columns: ${cols.join(', ')}`;
});

// Watch for context changes to update example query
watch(() => graphStore.currentContext, (context) => {
  if (!context) return;

  // Check if there's a saved query from exploration
  const savedQuery = graphStore.graphQuery;
  if (savedQuery && savedQuery.trim().toUpperCase().startsWith('MATCH')) {
    cypherQuery.value = savedQuery;
  } else {
    // Generate example based on context types
    cypherQuery.value = generateExampleQuery();
  }
}, { immediate: true });

// Watch for exploration load or template execution to update query
watch(() => graphStore.graphQuery, (newQuery) => {
  if (!newQuery) return;
  if (newQuery.trim().toUpperCase().startsWith('MATCH')) {
    cypherQuery.value = newQuery;
    queryMode.value = 'cypher';
  } else if (newQuery.trim().toUpperCase().startsWith('SELECT')) {
    sqlQuery.value = newQuery;
    queryMode.value = 'sql';
  }
});

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

  const upper = trimmed.toUpperCase();

  // Must start with MATCH
  if (!upper.startsWith('MATCH')) {
    return { valid: false, error: 'Query must start with MATCH' };
  }

  // Must have RETURN r (with optional DISTINCT)
  if (!/\bRETURN\s+(?:DISTINCT\s+)?r\b/i.test(trimmed)) {
    return { valid: false, error: 'Must have RETURN r (or RETURN DISTINCT r)' };
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
  return queryMode.value === 'cypher'
    ? 'MATCH (s:Person)-[r:KNOWS]->(d) RETURN r'
    : 'SELECT * FROM nodes WHERE node_type = \'Person\'';
});

const helpText = computed(() => {
  return queryMode.value === 'cypher'
    ? 'OpenCypher query. Must end with RETURN r.'
    : 'Spark SQL query. Click "Run" to execute and visualize results.';
});

const inMessiWeTrust = computed({
  get: () => graphStore.behaviors.inMessiWeTrust,
  set: (val: boolean) => graphStore.updateBehaviors({ inMessiWeTrust: val }),
});

// Procedural BFS options
const proceduralBfs = computed({
  get: () => graphStore.vlpRenderingMode === 'procedural',
  set: (val: boolean) => { graphStore.vlpRenderingMode = val ? 'procedural' : 'cte'; },
});

const materializationStrategy = computed({
  get: () => graphStore.materializationStrategy,
  set: (val: 'temp_tables' | 'numbered_views') => { graphStore.materializationStrategy = val; },
});

// External links (Databricks only)
const useExternalLinks = computed({
  get: () => graphStore.useExternalLinks,
  set: (val: boolean) => { graphStore.useExternalLinks = val; },
});

const buttonLabel = computed(() => {
  if (isProcessing.value || graphStore.loading) {
    if (queryMode.value === 'cypher') {
      return inMessiWeTrust.value ? 'Running...' : 'Transpiling...';
    }
    return 'Running...';
  }
  if (queryMode.value === 'cypher') {
    return inMessiWeTrust.value ? 'Run Query' : 'Transpile to SQL';
  }
  return 'Run Query';
});

async function handleAction() {
  if (isActionDisabled.value) return;

  isProcessing.value = true;

  try {
    if (queryMode.value === 'cypher') {
      // Transpile the query
      const sql = await graphStore.transpileCypher(cypherQuery.value);
      if (sql) {
        sqlQuery.value = sql;

        if (inMessiWeTrust.value) {
          // In Messi We Trust: auto-execute without review
          await graphStore.executeGraphQuery(sql);
          // Save the original Cypher query (not the SQL) for exploration state
          graphStore.setGraphQuery(cypherQuery.value);
          if (graphStore.error) {
            toast.error(`Query failed: ${graphStore.error}`);
          } else {
            toast.success(`Loaded ${graphStore.nodes.length} nodes and ${graphStore.edges.length} edges`);
          }
        } else {
          // Normal flow: switch to SQL mode for review
          // Save the Cypher query for exploration state
          graphStore.setGraphQuery(cypherQuery.value);
          queryMode.value = 'sql';
          toast.success('Query transpiled successfully');
        }
      } else if (graphStore.error) {
        toast.error(`Transpile failed: ${graphStore.error}`);
      }
    } else {
      // Execute SQL query
      await graphStore.executeGraphQuery(sqlQuery.value);
      if (graphStore.error) {
        toast.error(`Query failed: ${graphStore.error}`);
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

function clearQuery() {
  if (queryMode.value === 'cypher') {
    cypherQuery.value = '';
  } else {
    sqlQuery.value = '';
  }
  graphStore.setGraphQuery('');
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
        <button class="btn btn-outline btn-sm" @click="clearQuery">Clear</button>
        <button class="btn-icon-only close-btn" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <div class="mode-toggle">
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
      ></textarea>

      <p v-if="queryMode === 'cypher' && cypherValidation.error" class="error-text">
        {{ cypherValidation.error }}
      </p>
      <p v-else class="help-text">{{ helpText }}</p>

      <!-- In Messi We Trust option - only visible in cypher mode -->
      <label v-if="queryMode === 'cypher'" class="checkbox-label messi-option">
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
    <div v-if="queryMode === 'cypher'" class="cte-section">
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

    <!-- Procedural BFS Section - only in cypher mode -->
    <div v-if="queryMode === 'cypher'" class="bfs-section">
      <label class="checkbox-label bfs-option">
        <input
          type="checkbox"
          v-model="proceduralBfs"
          :disabled="isProcessing"
        />
        <span>Procedural BFS</span>
        <span class="bfs-hint">(temp tables instead of WITH RECURSIVE)</span>
      </label>

      <div v-if="proceduralBfs" class="bfs-strategy">
        <label class="strategy-label">Materialization</label>
        <select
          v-model="materializationStrategy"
          :disabled="isProcessing"
          class="strategy-select"
        >
          <option value="temp_tables">Temp Tables (Databricks)</option>
          <option value="numbered_views">Numbered Views (PySpark 4.2+)</option>
        </select>
      </div>
    </div>

    <!-- External Links Section - for large results -->
    <div class="external-links-section">
      <label class="checkbox-label external-links-option">
        <input
          type="checkbox"
          v-model="useExternalLinks"
          :disabled="isProcessing"
        />
        <span>Large results mode</span>
        <span class="external-links-hint">(external links for results &gt; 25 MiB)</span>
      </label>
    </div>

    <div class="query-actions">
      <button
        class="btn btn-primary btn-run"
        @click="handleAction"
        :disabled="isActionDisabled"
      >
        {{ buttonLabel }}
      </button>
    </div>
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

.bfs-section {
  margin-bottom: 16px;
}

.bfs-option {
  padding: 8px 10px;
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 6px;
  border: 1px solid var(--border-color, #ddd);
}

.bfs-option:hover {
  background: var(--bg-tertiary, #eee);
}

.bfs-hint {
  color: var(--text-muted, #666);
  font-size: 10px;
}

.bfs-strategy {
  margin-top: 8px;
  padding: 0 4px;
}

.strategy-label {
  display: block;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted, #666);
  margin-bottom: 4px;
}

.strategy-select {
  width: 100%;
  padding: 6px 8px;
  font-size: 12px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  background: var(--bg-color, #fafafa);
  color: var(--text-color, #333);
  cursor: pointer;
}

.strategy-select:focus {
  outline: none;
  border-color: var(--primary-color, #42b883);
  box-shadow: 0 0 0 2px rgba(66, 184, 131, 0.2);
}

.external-links-section {
  margin-bottom: 16px;
}

.external-links-option {
  padding: 8px 10px;
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 6px;
  border: 1px solid var(--border-color, #ddd);
}

.external-links-option:hover {
  background: var(--bg-tertiary, #eee);
}

.external-links-hint {
  color: var(--text-muted, #666);
  font-size: 10px;
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
