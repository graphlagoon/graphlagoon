<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { ChevronDown, ChevronRight } from 'lucide-vue-next';
import { useRouter } from 'vue-router';
import { api } from '@/services/api';
import type { GraphModel, RandomGraphRequest, RandomGraphResponse, ExtraColumnDefinition, ColumnDataType, GeneratorType } from '@/types/graph';

const router = useRouter();

// Form state
const catalog = ref('dev_catalog');
const schemaName = ref('graphs');
const tableName = ref('test_graph');
const model = ref<GraphModel>('barabasi_albert');
const numNodes = ref(500);

// Model-specific params — default adjusted per model
const avgDegree = ref(6);  // auto-adjusted by watcher on model/numNodes change
const rewiringProb = ref(0.3);
const ensureConnected = ref(true);
const selfEdgesEnabled = ref(false);
const selfEdgesRatio = ref(0.3);
const multiEdgesEnabled = ref(false);
const multiEdgesMaxCount = ref(3);
const multiEdgesRatio = ref(0.3);
const bidirectionalEdgesEnabled = ref(false);
const bidirectionalEdgesRatio = ref(0.3);

// Node/edge types (comma-separated input)
const nodeTypesInput = ref('Person, Company, Product');
const edgeTypesInput = ref('KNOWS, WORKS_AT, BOUGHT');

// Column config
const showColumnConfig = ref(false);
const nodeIdCol = ref('node_id');
const nodeTypeCol = ref('node_type');
const edgeIdCol = ref('edge_id');
const srcCol = ref('src');
const dstCol = ref('dst');
const relationshipTypeCol = ref('relationship_type');

// Extra columns config
const showExtraColumns = ref(false);
const extraNodeColumns = ref<ExtraColumnDefinition[]>([]);
const extraEdgeColumns = ref<ExtraColumnDefinition[]>([]);

const dataTypes: { value: ColumnDataType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'int', label: 'Integer' },
  { value: 'float', label: 'Float' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'date', label: 'Date' },
  { value: 'timestamp', label: 'Timestamp' },
];

const generators: { value: GeneratorType; label: string; dataTypes: ColumnDataType[] }[] = [
  { value: 'random_string', label: 'Random String', dataTypes: ['string'] },
  { value: 'uuid', label: 'UUID', dataTypes: ['string'] },
  { value: 'sequence', label: 'Sequence (0,1,2...)', dataTypes: ['int'] },
  { value: 'random_int', label: 'Random Integer', dataTypes: ['int'] },
  { value: 'random_float', label: 'Random Float', dataTypes: ['float'] },
  { value: 'random_bool', label: 'Random Boolean', dataTypes: ['boolean'] },
  { value: 'random_date', label: 'Random Date', dataTypes: ['date', 'timestamp'] },
  { value: 'random_choice', label: 'Random Choice', dataTypes: ['string'] },
  { value: 'faker_name', label: 'Fake Name', dataTypes: ['string'] },
  { value: 'faker_email', label: 'Fake Email', dataTypes: ['string'] },
  { value: 'faker_address', label: 'Fake Address', dataTypes: ['string'] },
  { value: 'faker_company', label: 'Fake Company', dataTypes: ['string'] },
  { value: 'constant', label: 'Constant Value', dataTypes: ['string', 'int', 'float', 'boolean'] },
  { value: 'random_json_object', label: 'JSON Object', dataTypes: ['string'] },
  { value: 'random_json_array', label: 'JSON Array of Objects', dataTypes: ['string'] },
];

function getDefaultGenerator(dataType: ColumnDataType): GeneratorType {
  const gen = generators.find(g => g.dataTypes.includes(dataType));
  return gen?.value || 'random_string';
}

function getAvailableGenerators(dataType: ColumnDataType) {
  return generators.filter(g => g.dataTypes.includes(dataType));
}

function addNodeColumn() {
  extraNodeColumns.value.push({
    name: `node_col_${extraNodeColumns.value.length + 1}`,
    data_type: 'string',
    generator: 'random_string',
  });
}

function removeNodeColumn(index: number) {
  extraNodeColumns.value.splice(index, 1);
}

function addEdgeColumn() {
  extraEdgeColumns.value.push({
    name: `edge_col_${extraEdgeColumns.value.length + 1}`,
    data_type: 'string',
    generator: 'random_string',
  });
}

function removeEdgeColumn(index: number) {
  extraEdgeColumns.value.splice(index, 1);
}

function onDataTypeChange(col: ExtraColumnDefinition) {
  col.generator = getDefaultGenerator(col.data_type);
  // Reset generator-specific fields
  col.choices = undefined;
  col.constant_value = undefined;
  col.min_value = undefined;
  col.max_value = undefined;
  col.string_length = undefined;
}

function onGeneratorChange(col: ExtraColumnDefinition) {
  // Initialize defaults for the selected generator
  if (col.generator === 'random_choice' && !col.choices) {
    col.choices = [];
  }
  if (col.generator === 'random_string' && !col.string_length) {
    col.string_length = 10;
  }
  if ((col.generator === 'random_int' || col.generator === 'random_float') && col.min_value === undefined) {
    col.min_value = 0;
    col.max_value = 100;
  }
}

// Helper to parse comma-separated choices input
function setChoicesFromInput(col: ExtraColumnDefinition, input: string) {
  col.choices = input.split(',').map(s => s.trim()).filter(Boolean);
}

// UI state
const loading = ref(false);
const clearing = ref(false);
const error = ref<string | null>(null);
const result = ref<RandomGraphResponse | null>(null);
const clearMessage = ref<string | null>(null);

const graphModels: { value: GraphModel; label: string; description: string }[] = [
  { value: 'barabasi_albert', label: 'Barabási-Albert', description: 'Scale-free network with preferential attachment' },
  { value: 'erdos_renyi', label: 'Erdős-Rényi', description: 'Random graph G(n, p)' },
  { value: 'watts_strogatz', label: 'Watts-Strogatz', description: 'Small-world network' },
  { value: 'complete', label: 'Complete', description: 'Fully connected graph K_n' },
  { value: 'cycle', label: 'Cycle', description: 'Circular graph' },
  { value: 'star', label: 'Star', description: 'Hub and spoke topology' },
  { value: 'random_tree', label: 'Random Tree', description: 'Random spanning tree' },
];

const showAvgDegree = computed(() =>
  model.value === 'erdos_renyi' || model.value === 'barabasi_albert' || model.value === 'watts_strogatz'
);
const showRewiringProb = computed(() => model.value === 'watts_strogatz');

// Safe avg_degree that guarantees connectivity for each model
function safeAvgDegree(m: GraphModel, n: number): number {
  if (m === 'erdos_renyi') return Math.ceil(2 * Math.log(n));
  if (m === 'barabasi_albert') return 6;
  if (m === 'watts_strogatz') return 6;
  return 6;
}

// Auto-adjust avgDegree when model or numNodes changes
watch([model, numNodes], ([newModel, newN]) => {
  if (showAvgDegree.value) {
    avgDegree.value = safeAvgDegree(newModel, newN);
  }
});

const avgDegreeBelowThreshold = computed(() => {
  if (model.value === 'erdos_renyi') {
    return avgDegree.value < Math.log(numNodes.value);
  }
  return false;
});

const avgDegreeHint = computed(() => {
  const n = numNodes.value;
  const k = avgDegree.value;
  if (model.value === 'erdos_renyi') {
    const p = Math.min(1, k / Math.max(1, n - 1));
    const threshold = Math.log(n);
    const warning = k < threshold ? ' ⚠ below threshold, graph will be disconnected' : '';
    return `p = ${p.toFixed(4)}, connectivity threshold: avg_degree > ln(N) ≈ ${threshold.toFixed(1)}${warning}`;
  }
  if (model.value === 'barabasi_albert') {
    const m = Math.max(1, Math.round(k / 2));
    return `m = ${m}, always connected`;
  }
  if (model.value === 'watts_strogatz') {
    let kWs = Math.max(2, Math.round(k));
    if (kWs % 2 !== 0) kWs += 1;
    return `k = ${kWs} (rounded to even), always connected`;
  }
  return '';
});

async function generateGraph() {
  loading.value = true;
  error.value = null;
  result.value = null;

  try {
    const request: RandomGraphRequest = {
      catalog: catalog.value,
      schema_name: schemaName.value,
      table_name: tableName.value,
      model: model.value,
      num_nodes: numNodes.value,
      node_types: nodeTypesInput.value.split(',').map(s => s.trim()).filter(Boolean),
      edge_types: edgeTypesInput.value.split(',').map(s => s.trim()).filter(Boolean),
    };

    // Add model-specific params
    if (showAvgDegree.value) {
      request.avg_degree = avgDegree.value;
    }
    if (showRewiringProb.value) {
      request.rewiring_prob = rewiringProb.value;
    }
    request.ensure_connected = ensureConnected.value;
    if (selfEdgesEnabled.value) {
      request.self_edges_ratio = selfEdgesRatio.value;
    }
    if (multiEdgesEnabled.value) {
      request.multi_edges_max_count = multiEdgesMaxCount.value;
      request.multi_edges_ratio = multiEdgesRatio.value;
    }
    if (bidirectionalEdgesEnabled.value) {
      request.bidirectional_edges_ratio = bidirectionalEdgesRatio.value;
    }

    // Add column config if customized
    if (showColumnConfig.value) {
      request.columns = {
        node_id_col: nodeIdCol.value,
        node_type_col: nodeTypeCol.value,
        edge_id_col: edgeIdCol.value,
        src_col: srcCol.value,
        dst_col: dstCol.value,
        relationship_type_col: relationshipTypeCol.value,
      };
    }

    // Add extra columns config
    if (extraNodeColumns.value.length > 0) {
      request.extra_node_columns = extraNodeColumns.value;
    }
    if (extraEdgeColumns.value.length > 0) {
      request.extra_edge_columns = extraEdgeColumns.value;
    }

    result.value = await api.createRandomGraph(request);

    // Refresh the catalog to ensure tables are registered and available
    try {
      await api.refreshCatalog();
    } catch (refreshError) {
      console.warn('Could not refresh catalog:', refreshError);
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Failed to generate graph';
  } finally {
    loading.value = false;
  }
}

function createContextFromResult() {
  if (!result.value) return;
  router.push({
    path: '/contexts',
    query: {
      create: 'true',
      edge_table: result.value.edge_table,
      node_table: result.value.node_table,
    },
  });
}

async function clearAllData() {
  if (!confirm('Are you sure you want to delete ALL data? This will remove all graph contexts, explorations, and generated tables.')) {
    return;
  }

  clearing.value = true;
  clearMessage.value = null;
  error.value = null;

  try {
    const response = await api.clearAllData();
    clearMessage.value = response.message;
    result.value = null;
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Failed to clear data';
  } finally {
    clearing.value = false;
  }
}
</script>

<template>
  <div class="container">
    <div class="page-header">
      <h1>DEV Graph Generator</h1>
      <p class="subtitle">Generate random graphs using NetworkX models (simulating Unity Catalog)</p>
    </div>

    <div class="card">
      <h2>Table Naming (catalog.schema.table)</h2>
      <div class="form-row">
        <div class="form-group">
          <label>Catalog</label>
          <input v-model="catalog" type="text" class="form-control" placeholder="dev_catalog" />
        </div>
        <div class="form-group">
          <label>Schema</label>
          <input v-model="schemaName" type="text" class="form-control" placeholder="graphs" />
        </div>
        <div class="form-group">
          <label>Table Name</label>
          <input v-model="tableName" type="text" class="form-control" placeholder="test_graph" />
        </div>
      </div>
      <p class="hint">
        Tables will be created as: <code>{{ catalog }}.{{ schemaName }}.edges_{{ tableName }}</code>
        and <code>{{ catalog }}.{{ schemaName }}.nodes_{{ tableName }}</code>
      </p>
    </div>

    <div class="card">
      <h2>Graph Model</h2>
      <div class="form-group">
        <label>Model</label>
        <select v-model="model" class="form-control">
          <option v-for="m in graphModels" :key="m.value" :value="m.value">
            {{ m.label }} - {{ m.description }}
          </option>
        </select>
      </div>

      <div class="form-group">
        <label>Number of Nodes</label>
        <input v-model.number="numNodes" type="number" class="form-control" min="3" max="10000" />
      </div>

      <div v-if="showAvgDegree" class="form-group">
        <label>Average Degree</label>
        <input v-model.number="avgDegree" type="number" class="form-control" min="1" max="100" step="1" />
        <span class="hint" :class="{ 'hint-warning': avgDegreeBelowThreshold }">{{ avgDegreeHint }}</span>
      </div>

      <div v-if="showRewiringProb" class="form-group">
        <label>Rewiring Probability (β)</label>
        <input v-model.number="rewiringProb" type="number" class="form-control" min="0" max="1" step="0.1" />
        <span class="hint">Probability of rewiring each edge (does not affect average degree)</span>
      </div>

      <div class="checkbox-group">
        <label>
          <input v-model="ensureConnected" type="checkbox" />
          Ensure connected graph
        </label>
        <span class="hint">Adds random edges between disconnected components</span>
      </div>

      <div class="checkbox-group">
        <label>
          <input v-model="selfEdgesEnabled" type="checkbox" />
          Generate self-edges (loops)
        </label>
        <span class="hint">Add edges where source = destination</span>
      </div>

      <div v-if="selfEdgesEnabled" class="form-group">
        <label>Self-edges ratio ({{ Math.round(selfEdgesRatio * 100) }}%)</label>
        <input v-model.number="selfEdgesRatio" type="range" class="form-control" min="0.05" max="1" step="0.05" />
        <span class="hint">Percentage of total edges that will be self-edges</span>
      </div>

      <div class="checkbox-group">
        <label>
          <input v-model="multiEdgesEnabled" type="checkbox" />
          Generate multi-edges (parallel edges)
        </label>
        <span class="hint">Add multiple edges between the same pair of nodes</span>
      </div>

      <div v-if="multiEdgesEnabled" class="form-row">
        <div class="form-group">
          <label>Max extra edges per pair</label>
          <input v-model.number="multiEdgesMaxCount" type="number" class="form-control" min="1" max="20" step="1" />
          <span class="hint">Up to N additional edges between a node pair</span>
        </div>
        <div class="form-group">
          <label>Fill ratio ({{ Math.round(multiEdgesRatio * 100) }}%)</label>
          <input v-model.number="multiEdgesRatio" type="range" class="form-control" min="0.05" max="1" step="0.05" />
          <span class="hint">Fraction of existing edges that get duplicated</span>
        </div>
      </div>

      <div class="checkbox-group">
        <label>
          <input v-model="bidirectionalEdgesEnabled" type="checkbox" />
          Generate bidirectional edges
        </label>
        <span class="hint">Add reverse edges (B&#8594;A for each A&#8594;B)</span>
      </div>

      <div v-if="bidirectionalEdgesEnabled" class="form-group">
        <label>Bidirectional ratio ({{ Math.round(bidirectionalEdgesRatio * 100) }}%)</label>
        <input v-model.number="bidirectionalEdgesRatio" type="range" class="form-control" min="0.05" max="1" step="0.05" />
        <span class="hint">Fraction of existing edges that get a reverse counterpart</span>
      </div>
    </div>

    <div class="card">
      <h2>Node & Edge Types</h2>
      <div class="form-group">
        <label>Node Types (comma-separated)</label>
        <input v-model="nodeTypesInput" type="text" class="form-control" placeholder="Person, Company, Product" />
      </div>
      <div class="form-group">
        <label>Edge Types (comma-separated)</label>
        <input v-model="edgeTypesInput" type="text" class="form-control" placeholder="KNOWS, WORKS_AT, BOUGHT" />
      </div>
    </div>

    <div class="card">
      <div class="card-header-toggle" @click="showColumnConfig = !showColumnConfig">
        <h2>Column Names (Advanced)</h2>
        <component :is="showColumnConfig ? ChevronDown : ChevronRight" :size="16" />
      </div>

      <div v-if="showColumnConfig" class="column-config">
        <p class="hint">Customize column names for the generated tables</p>
        <div class="form-row">
          <div class="form-group">
            <label>Node ID Column</label>
            <input v-model="nodeIdCol" type="text" class="form-control" />
          </div>
          <div class="form-group">
            <label>Node Type Column</label>
            <input v-model="nodeTypeCol" type="text" class="form-control" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Edge ID Column</label>
            <input v-model="edgeIdCol" type="text" class="form-control" />
          </div>
          <div class="form-group">
            <label>Source Column</label>
            <input v-model="srcCol" type="text" class="form-control" />
          </div>
          <div class="form-group">
            <label>Destination Column</label>
            <input v-model="dstCol" type="text" class="form-control" />
          </div>
          <div class="form-group">
            <label>Relationship Type Column</label>
            <input v-model="relationshipTypeCol" type="text" class="form-control" />
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header-toggle" @click="showExtraColumns = !showExtraColumns">
        <h2>Extra Random Columns</h2>
        <component :is="showExtraColumns ? ChevronDown : ChevronRight" :size="16" />
      </div>

      <div v-if="showExtraColumns" class="extra-columns-config">
        <p class="hint">Add custom columns with random data to nodes and edges</p>

        <!-- Extra Node Columns -->
        <div class="extra-columns-section">
          <div class="section-header">
            <h3>Node Columns</h3>
            <button type="button" class="btn btn-sm btn-secondary" @click="addNodeColumn">+ Add Column</button>
          </div>

          <div v-if="extraNodeColumns.length === 0" class="empty-state">
            No extra node columns. Click "Add Column" to add one.
          </div>

          <div v-for="(col, index) in extraNodeColumns" :key="index" class="column-row">
            <div class="form-group">
              <label>Name</label>
              <input v-model="col.name" type="text" class="form-control" placeholder="column_name" />
            </div>
            <div class="form-group">
              <label>Data Type</label>
              <select v-model="col.data_type" class="form-control" @change="onDataTypeChange(col)">
                <option v-for="dt in dataTypes" :key="dt.value" :value="dt.value">{{ dt.label }}</option>
              </select>
            </div>
            <div class="form-group">
              <label>Generator</label>
              <select v-model="col.generator" class="form-control" @change="onGeneratorChange(col)">
                <option v-for="gen in getAvailableGenerators(col.data_type)" :key="gen.value" :value="gen.value">
                  {{ gen.label }}
                </option>
              </select>
            </div>
            <!-- Random Choice: choices input -->
            <div v-if="col.generator === 'random_choice'" class="form-group form-group-wide">
              <label>Choices (comma-separated)</label>
              <input
                type="text"
                class="form-control"
                placeholder="financeiro, tecnologia, saude, varejo"
                :value="(col.choices || []).join(', ')"
                @blur="setChoicesFromInput(col, ($event.target as HTMLInputElement).value)"
              />
            </div>
            <!-- Constant: value input -->
            <div v-if="col.generator === 'constant'" class="form-group form-group-sm">
              <label>Value</label>
              <input v-model="col.constant_value" type="text" class="form-control" placeholder="value" />
            </div>
            <!-- Random Int / Float: min/max -->
            <template v-if="col.generator === 'random_int' || col.generator === 'random_float'">
              <div class="form-group form-group-sm">
                <label>Min</label>
                <input v-model.number="col.min_value" type="number" class="form-control" placeholder="0" />
              </div>
              <div class="form-group form-group-sm">
                <label>Max</label>
                <input v-model.number="col.max_value" type="number" class="form-control" placeholder="100" />
              </div>
            </template>
            <!-- Random String: length -->
            <div v-if="col.generator === 'random_string'" class="form-group form-group-sm">
              <label>Length</label>
              <input v-model.number="col.string_length" type="number" class="form-control" min="1" max="1000" placeholder="10" />
            </div>
            <!-- JSON generator options -->
            <template v-if="col.generator === 'random_json_object' || col.generator === 'random_json_array'">
              <div class="form-group form-group-sm">
                <label>Max Depth</label>
                <input v-model.number="col.json_max_depth" type="number" class="form-control" min="1" max="5" placeholder="2" />
              </div>
              <div class="form-group form-group-sm">
                <label>Max Keys</label>
                <input v-model.number="col.json_max_keys" type="number" class="form-control" min="1" max="10" placeholder="5" />
              </div>
            </template>
            <template v-if="col.generator === 'random_json_array'">
              <div class="form-group form-group-sm">
                <label>Min Items</label>
                <input v-model.number="col.json_array_min_items" type="number" class="form-control" min="1" max="20" placeholder="3" />
              </div>
              <div class="form-group form-group-sm">
                <label>Max Items</label>
                <input v-model.number="col.json_array_max_items" type="number" class="form-control" min="1" max="50" placeholder="6" />
              </div>
            </template>
            <button type="button" class="btn btn-sm btn-danger remove-btn" @click="removeNodeColumn(index)">×</button>
          </div>
        </div>

        <!-- Extra Edge Columns -->
        <div class="extra-columns-section">
          <div class="section-header">
            <h3>Edge Columns</h3>
            <button type="button" class="btn btn-sm btn-secondary" @click="addEdgeColumn">+ Add Column</button>
          </div>

          <div v-if="extraEdgeColumns.length === 0" class="empty-state">
            No extra edge columns. Click "Add Column" to add one.
          </div>

          <div v-for="(col, index) in extraEdgeColumns" :key="index" class="column-row">
            <div class="form-group">
              <label>Name</label>
              <input v-model="col.name" type="text" class="form-control" placeholder="column_name" />
            </div>
            <div class="form-group">
              <label>Data Type</label>
              <select v-model="col.data_type" class="form-control" @change="onDataTypeChange(col)">
                <option v-for="dt in dataTypes" :key="dt.value" :value="dt.value">{{ dt.label }}</option>
              </select>
            </div>
            <div class="form-group">
              <label>Generator</label>
              <select v-model="col.generator" class="form-control" @change="onGeneratorChange(col)">
                <option v-for="gen in getAvailableGenerators(col.data_type)" :key="gen.value" :value="gen.value">
                  {{ gen.label }}
                </option>
              </select>
            </div>
            <!-- Random Choice: choices input -->
            <div v-if="col.generator === 'random_choice'" class="form-group form-group-wide">
              <label>Choices (comma-separated)</label>
              <input
                type="text"
                class="form-control"
                placeholder="financeiro, tecnologia, saude, varejo"
                :value="(col.choices || []).join(', ')"
                @blur="setChoicesFromInput(col, ($event.target as HTMLInputElement).value)"
              />
            </div>
            <!-- Constant: value input -->
            <div v-if="col.generator === 'constant'" class="form-group form-group-sm">
              <label>Value</label>
              <input v-model="col.constant_value" type="text" class="form-control" placeholder="value" />
            </div>
            <!-- Random Int / Float: min/max -->
            <template v-if="col.generator === 'random_int' || col.generator === 'random_float'">
              <div class="form-group form-group-sm">
                <label>Min</label>
                <input v-model.number="col.min_value" type="number" class="form-control" placeholder="0" />
              </div>
              <div class="form-group form-group-sm">
                <label>Max</label>
                <input v-model.number="col.max_value" type="number" class="form-control" placeholder="100" />
              </div>
            </template>
            <!-- Random String: length -->
            <div v-if="col.generator === 'random_string'" class="form-group form-group-sm">
              <label>Length</label>
              <input v-model.number="col.string_length" type="number" class="form-control" min="1" max="1000" placeholder="10" />
            </div>
            <!-- JSON generator options -->
            <template v-if="col.generator === 'random_json_object' || col.generator === 'random_json_array'">
              <div class="form-group form-group-sm">
                <label>Max Depth</label>
                <input v-model.number="col.json_max_depth" type="number" class="form-control" min="1" max="5" placeholder="2" />
              </div>
              <div class="form-group form-group-sm">
                <label>Max Keys</label>
                <input v-model.number="col.json_max_keys" type="number" class="form-control" min="1" max="10" placeholder="5" />
              </div>
            </template>
            <template v-if="col.generator === 'random_json_array'">
              <div class="form-group form-group-sm">
                <label>Min Items</label>
                <input v-model.number="col.json_array_min_items" type="number" class="form-control" min="1" max="20" placeholder="3" />
              </div>
              <div class="form-group form-group-sm">
                <label>Max Items</label>
                <input v-model.number="col.json_array_max_items" type="number" class="form-control" min="1" max="50" placeholder="6" />
              </div>
            </template>
            <button type="button" class="btn btn-sm btn-danger remove-btn" @click="removeEdgeColumn(index)">×</button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="error" class="error-message">{{ error }}</div>

    <div v-if="result" class="card result-card">
      <h2>Graph Generated Successfully!</h2>
      <div class="result-details">
        <p><strong>Model:</strong> {{ result.model }}</p>
        <p><strong>Nodes:</strong> {{ result.num_nodes }}</p>
        <p><strong>Edges:</strong> {{ result.num_edges }}</p>
        <p><strong>Node Table:</strong> <code>{{ result.node_table }}</code></p>
        <p><strong>Edge Table:</strong> <code>{{ result.edge_table }}</code></p>
      </div>
      <button class="btn btn-primary" @click="createContextFromResult">
        Create Graph Context from this Graph
      </button>
    </div>

    <div class="actions">
      <button class="btn btn-primary btn-lg" :disabled="loading" @click="generateGraph">
        {{ loading ? 'Generating...' : 'Generate Graph' }}
      </button>
    </div>

    <!-- Danger Zone -->
    <div class="card danger-zone">
      <h2>Danger Zone</h2>
      <p class="hint">These actions are irreversible. Use with caution.</p>

      <div v-if="clearMessage" class="success-message">{{ clearMessage }}</div>

      <button class="btn btn-danger" :disabled="clearing" @click="clearAllData">
        {{ clearing ? 'Clearing...' : 'Clear All Data' }}
      </button>
      <span class="hint">Deletes all graph contexts, explorations, and generated tables.</span>
    </div>
  </div>
</template>

<style scoped>
.subtitle {
  color: var(--text-muted);
  margin-top: 8px;
}

.form-row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.form-row .form-group {
  flex: 1;
  min-width: 150px;
}

.hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

.hint-warning {
  color: var(--danger-color, #f44336);
  font-weight: 600;
}

code {
  background: var(--bg-secondary);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
}

.card-header-toggle {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
}

.card-header-toggle h2 {
  margin-bottom: 0;
}

.column-config {
  margin-top: 16px;
}

.extra-columns-config {
  margin-top: 16px;
}

.checkbox-group {
  margin-bottom: 16px;
}

.checkbox-group label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.checkbox-group input[type="checkbox"] {
  width: 18px;
  height: 18px;
}

.extra-columns-section {
  margin-top: 20px;
  padding: 16px;
  background: var(--bg-secondary);
  border-radius: 8px;
}

.extra-columns-section h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.column-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
  margin-bottom: 12px;
  padding: 12px;
  background: var(--bg-primary);
  border-radius: 6px;
}

.column-row .form-group {
  flex: 1;
  margin-bottom: 0;
}

.column-row .form-group label {
  font-size: 11px;
  margin-bottom: 4px;
}

.column-row .form-group-sm {
  flex: 0 0 80px;
}

.column-row .form-group-wide {
  flex: 1 1 100%;
}

.remove-btn {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  padding: 0;
  font-size: 18px;
  line-height: 1;
}

.empty-state {
  padding: 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.btn-sm {
  padding: 6px 12px;
  font-size: 13px;
}

.btn-secondary {
  background: var(--bg-tertiary, #6c757d);
  color: white;
  border: none;
}

.btn-secondary:hover {
  background: var(--bg-tertiary-hover, #5a6268);
}

.result-card {
  background: var(--success-bg, #e8f5e9);
  border: 1px solid var(--success-color, #4caf50);
}

.result-details {
  margin: 16px 0;
}

.result-details p {
  margin: 8px 0;
}

.actions {
  margin-top: 24px;
  display: flex;
  justify-content: center;
}

.btn-lg {
  padding: 12px 32px;
  font-size: 16px;
}

.danger-zone {
  margin-top: 48px;
  border: 1px solid var(--danger-color, #f44336);
  background: var(--danger-bg, #ffebee);
}

.danger-zone h2 {
  color: var(--danger-color, #f44336);
}

.success-message {
  padding: 12px;
  margin-bottom: 16px;
  background: var(--success-bg, #e8f5e9);
  border: 1px solid var(--success-color, #4caf50);
  border-radius: 4px;
  color: var(--success-color, #4caf50);
}
</style>
