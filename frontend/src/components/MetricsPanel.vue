<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useMetricsStore } from '@/stores/metrics';
import { useGraphStore } from '@/stores/graph';
import { ALGORITHMS, getAlgorithmsByTarget } from '@/services/algorithmRegistry';
import { getMetricsCalculator } from '@/services/metricsCalculator';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import type { AlgorithmDefinition, ScaleType, Priority } from '@/types/metrics';
import { isCustomMetricId, customMetricId } from '@/types/customMetrics';
import { formatMetricValue } from '@/utils/metricFormat';
import { useFeatureFlags } from '@/composables/useFeatureFlags';
import type { CustomMetricDefinition } from '@/types/customMetrics';
import { useCustomMetricsStore } from '@/stores/customMetrics';
import CustomMetricEditorModal from './CustomMetricEditorModal.vue';
import CustomMetricSkillModal from './CustomMetricSkillModal.vue';
import { parseImportedCustomMetrics } from '@/utils/customMetricImport';
import { buildSourceSchema, downloadJson, readFileAsText, safeFilename } from '@/utils/portableExport';
import { PORTABLE_EXPORT_VERSION, type PortableCustomMetrics } from '@/types/portable';
import { Activity, ChevronDown, ChevronRight, Play, Pause, X, Bot, Download } from 'lucide-vue-next';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'show-resource-monitor'): void;
}>();

const metricsStore = useMetricsStore();
const graphStore = useGraphStore();
const customMetricsStore = useCustomMetricsStore();
const { customMetricsEnabled } = useFeatureFlags();
const calculator = getMetricsCalculator();
const toast = useToast();

// UI State
const activeTab = ref<'compute' | 'mapping' | 'custom'>('compute');

// ─── Custom metrics (writer-authored, sandboxed) ───
const customEditorOpen = ref(false);
const customEditing = ref<CustomMetricDefinition | null>(null);
const customSkillOpen = ref(false);

function openCustomEditor(def: CustomMetricDefinition | null) {
  customEditing.value = def;
  customEditorOpen.value = true;
}

function customStatus(id: string) {
  return customMetricsStore.runStates.get(id);
}

function customStatusLabel(id: string): string {
  const s = customStatus(id);
  if (!s || s.status === 'idle') return 'not computed — use Recompute';
  if (s.status === 'stale') return 'stale — the graph changed, use Recompute';
  if (s.status === 'queued') return 'queued';
  if (s.status === 'running') return `running ${s.progress}%`;
  if (s.status === 'error') return `error: ${s.error ?? 'unknown'}`;
  const errs = s.errorCount > 0 ? ` · ${s.errorCount} item error${s.errorCount === 1 ? '' : 's'}` : '';
  return `done in ${Math.round(s.elapsedMs)} ms${errs}`;
}

// Import JSON (several metrics at once) / Export JSON (all)
const customImportOpen = ref(false);
const customImportText = ref('');
const customImportError = ref<string | null>(null);
const customFileInput = ref<HTMLInputElement | null>(null);

const customParsedImport = computed(() => {
  const text = customImportText.value.trim();
  return text ? parseImportedCustomMetrics(text) : null;
});

async function pickCustomFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  customImportError.value = null;
  try {
    customImportText.value = await readFileAsText(file);
  } catch {
    customImportError.value = 'Could not read the file';
  } finally {
    input.value = '';
  }
}

/** Add or update every pasted metric (match by id, then by name). */
function applyCustomImport() {
  customImportError.value = null;
  const result = parseImportedCustomMetrics(customImportText.value);
  if (!result.ok) {
    customImportError.value = result.error;
    return;
  }
  const { updated, added } = customMetricsStore.upsertDefinitions(result.definitions);
  customImportText.value = '';
  customImportOpen.value = false;
  const parts = [];
  if (added) parts.push(`${added} added`);
  if (updated) parts.push(`${updated} updated`);
  toast.success(`Custom metrics imported: ${parts.join(', ')}`);
}

function exportCustomMetrics() {
  const payload: PortableCustomMetrics = {
    graphlagoon_export: 'custom-metrics',
    export_version: PORTABLE_EXPORT_VERSION,
    source: buildSourceSchema({
      context: graphStore.currentContext,
      loadedNodeTypes: graphStore.nodeTypes,
      loadedEdgeTypes: graphStore.edgeTypes,
    }),
    metrics: customMetricsStore.definitions.map((d) => ({ ...d })),
  };
  downloadJson(safeFilename(`metrics-${graphStore.currentContext?.title || 'context'}`), payload);
}

function deleteCustomMetric(def: CustomMetricDefinition) {
  // `addDefinition` re-persists and recomputes, which is exactly what undoing
  // a delete should do; the definition lands at the end of the list, and
  // nothing about a metric depends on its position.
  customMetricsStore.removeDefinition(def.id);
  toast.undoable(`Metric “${def.name}” deleted`, () => customMetricsStore.addDefinition(def));
}
const selectedAlgorithm = ref<string | null>(null);
const isComputing = ref(false);
const expandedSections = ref({
  graphInfo: true,
  compute: true,
  nodeMapping: true,
  edgeMapping: true,
});

// Algorithm selection
const nodeAlgorithms = computed(() => getAlgorithmsByTarget('node'));
const edgeAlgorithms = computed(() => getAlgorithmsByTarget('edge'));

const selectedAlgorithmDef = computed<AlgorithmDefinition | null>(() => {
  if (!selectedAlgorithm.value) return null;
  return ALGORITHMS.find(a => a.id === selectedAlgorithm.value) || null;
});

// Algorithm parameters
const algorithmParams = ref<Record<string, unknown>>({});
const edgeTypeFilter = ref<string[]>([]);
const computePriority = ref<Priority>('medium');

// Watch for algorithm changes to reset params
watch(selectedAlgorithm, (algoId) => {
  if (algoId) {
    const algo = ALGORITHMS.find(a => a.id === algoId);
    if (algo) {
      algorithmParams.value = { ...algo.defaultParams };
    }
  }
});

// Graph info
const graphInfo = computed(() => metricsStore.graphInfo);

// Computed metrics
const nodeMetrics = computed(() => metricsStore.nodeMetrics);
const edgeMetrics = computed(() => metricsStore.edgeMetrics);
const numericNodeMetrics = computed(() => metricsStore.numericNodeMetrics);
const numericEdgeMetrics = computed(() => metricsStore.numericEdgeMetrics);
// Built-in + algorithm runs only: custom metrics have their own tab (with the
// same table toggle) — listing them twice was noise.
const computedMetricsList = computed(() =>
  [...nodeMetrics.value, ...edgeMetrics.value].filter((m) => !isCustomMetricId(m.id)),
);

// Active computations
const activeComputations = computed(() =>
  Array.from(metricsStore.activeComputations.values())
);

// Visual mapping state
const nodeSizeMapping = computed({
  get: () => metricsStore.visualMapping.nodeSize,
  set: (value) => metricsStore.updateNodeSizeMapping(value)
});

const edgeWeightMapping = computed({
  get: () => metricsStore.visualMapping.edgeWeight,
  set: (value) => metricsStore.updateEdgeWeightMapping(value)
});

// Scale type options
const scaleOptions: { value: ScaleType; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'log', label: 'Logarithmic' },
  { value: 'sqrt', label: 'Square Root' },
];

// Compute metric
async function computeMetric() {
  if (!selectedAlgorithm.value) return;

  isComputing.value = true;
  try {
    await calculator.computeMetric({
      algorithmId: selectedAlgorithm.value,
      params: algorithmParams.value,
      edgeTypeFilter: edgeTypeFilter.value,
      priority: computePriority.value,
    });
  } catch (error) {
    console.error('Computation failed:', error);
    toast.error(getErrorMessage(error, 'Metric computation failed'));
  } finally {
    isComputing.value = false;
  }
}

// Cancel computation
function cancelComputation(id: string) {
  calculator.cancelComputation(id);
}

// Pause/resume computation
function togglePause(id: string) {
  const comp = metricsStore.activeComputations.get(id);
  if (comp) {
    if (comp.status === 'paused') {
      calculator.resumeComputation(id);
    } else {
      calculator.pauseComputation(id);
    }
  }
}

// Delete metric
function deleteMetric(id: string) {
  metricsStore.deleteMetric(id);
}

// Resource monitoring interval
let resourceInterval: number | null = null;

onMounted(() => {
  // Refresh resource metrics periodically
  resourceInterval = window.setInterval(() => {
    calculator.refreshResourceMetrics();
  }, 1000);
});

onUnmounted(() => {
  if (resourceInterval) {
    clearInterval(resourceInterval);
  }
});

// Format elapsed time
function formatTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

// Toggle section
function toggleSection(section: keyof typeof expandedSections.value) {
  expandedSections.value[section] = !expandedSections.value[section];
}
</script>

<template>
  <div class="metrics-panel">
    <div class="panel-header">
      <h3>Metrics</h3>
      <div class="header-actions">
        <button
          class="btn-icon-only"
          @click="emit('show-resource-monitor')"
          title="Resource Monitor"
        >
          <Activity :size="16" />
        </button>
        <button class="btn-icon-only close-btn" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <button
        class="tab"
        :class="{ active: activeTab === 'compute' }"
        @click="activeTab = 'compute'"
      >
        Compute
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'mapping' }"
        @click="activeTab = 'mapping'"
      >
        Visual Mapping
      </button>
      <button
        v-if="customMetricsEnabled"
        class="tab"
        :class="{ active: activeTab === 'custom' }"
        data-testid="metrics-tab-custom"
        @click="activeTab = 'custom'"
      >
        Custom
      </button>
    </div>

    <!-- Custom Tab -->
    <div v-if="activeTab === 'custom' && customMetricsEnabled" class="tab-content" data-testid="custom-metrics-tab">
      <div v-if="!customMetricsStore.canEdit" class="custom-readonly-note" data-testid="custom-metrics-readonly">
        Custom metrics are defined by users with write access to this context. You have read-only access, so none are shown here.
      </div>
      <template v-else>
        <p class="custom-intro">
          Per-node / per-edge JavaScript evaluated in a sandboxed worker. Values can be numbers, text or booleans and
          appear in the Data Table, the inspector, size mapping (numbers) and label templates as <code>{metric:name}</code>.
        </p>
        <div class="custom-actions">
          <button class="compute-btn" data-testid="custom-metric-new" @click="openCustomEditor(null)">
            + New custom metric
          </button>
          <button
            class="icon-btn"
            data-testid="custom-metrics-skill-help"
            title="Not sure how? Get an AI prompt to write a custom metric"
            aria-label="Get help writing a custom metric"
            @click="customSkillOpen = true"
          >
            <Bot :size="16" />
          </button>
        </div>
        <div class="custom-actions custom-actions--secondary">
          <button
            class="mini-btn"
            :class="{ active: customImportOpen }"
            data-testid="custom-metrics-import-toggle"
            @click="customImportOpen = !customImportOpen"
          >
            Import JSON
          </button>
          <button
            class="mini-btn"
            data-testid="custom-metric-export-all"
            :disabled="customMetricsStore.definitions.length === 0"
            title="Download all custom metrics as a JSON file you can import into another context"
            @click="exportCustomMetrics"
          >
            <Download :size="12" /> Export JSON
          </button>
        </div>

        <div v-if="customImportOpen" class="custom-import" data-testid="custom-metrics-import">
          <span class="custom-intro">
            Paste the JSON from the AI prompt or a file exported from another context. Several
            metrics at once are fine; a metric with the same id or name as an existing one
            <strong>updates it</strong>, the others are added.
          </span>
          <textarea
            v-model="customImportText"
            class="custom-import-textarea"
            data-testid="custom-metrics-import-text"
            rows="4"
            placeholder='[{"name": "...", "target": "node", "value_type": "number", "code": "return ..."}]'
          />
          <div class="custom-actions">
            <input
              ref="customFileInput"
              type="file"
              accept=".json,application/json"
              class="file-input"
              data-testid="custom-metrics-import-file"
              @change="pickCustomFile"
            />
            <button class="mini-btn" @click="customFileInput?.click()">Choose file…</button>
            <button
              class="mini-btn"
              data-testid="custom-metrics-import-apply"
              :disabled="!customParsedImport?.ok"
              @click="applyCustomImport"
            >
              Add metrics
            </button>
          </div>
          <span
            v-if="customParsedImport && !customParsedImport.ok"
            class="custom-status is-error"
            data-testid="custom-metrics-import-parse-error"
          >
            {{ customParsedImport.error }}
          </span>
          <span v-if="customImportError" class="custom-status is-error">{{ customImportError }}</span>
        </div>

        <div v-if="customMetricsStore.definitions.length === 0" class="empty-hint">
          No custom metrics on this context yet.
        </div>

        <div
          v-for="def in customMetricsStore.definitions"
          :key="def.id"
          class="metric-item"
          :data-testid="`custom-metric-item-${def.id}`"
        >
          <div class="metric-name" :title="def.description || def.name">{{ def.name }}</div>
          <div class="metric-meta">
            {{ def.target }} · {{ def.value_type }}<template v-if="def.auto_run"> · <span :title="customMetricsStore.autoRunAllowed ? 'Runs automatically when the graph loads' : 'Auto-run is disabled on this server'">auto{{ customMetricsStore.autoRunAllowed ? '' : ' (off)' }}</span></template>
          </div>
          <div
            class="metric-meta custom-status"
            :class="{ 'is-error': customStatus(def.id)?.status === 'error', 'is-stale': customStatus(def.id)?.status === 'stale' }"
            :data-testid="`custom-metric-status-${def.id}`"
          >
            {{ customStatusLabel(def.id) }}
          </div>
          <div class="metric-footer">
            <label class="table-toggle" title="Add as a column in the table drawer">
              <input
                type="checkbox"
                :checked="def.show_in_table === true"
                :data-testid="`metric-table-toggle-${customMetricId(def.id)}`"
                @change="customMetricsStore.setShowInTable(def.id, ($event.target as HTMLInputElement).checked)"
              />
              <span>Table column</span>
            </label>
            <div class="metric-actions">
            <button class="mini-btn" :data-testid="`custom-metric-edit-${def.id}`" @click="openCustomEditor(def)">Edit</button>
            <button
              class="mini-btn"
              :data-testid="`custom-metric-recompute-${def.id}`"
              @click="customMetricsStore.recomputeNow([def.id])"
            >
              Recompute
            </button>
            <button class="mini-btn danger" :data-testid="`custom-metric-delete-${def.id}`" @click="deleteCustomMetric(def)">
              Delete
            </button>
            </div>
          </div>
        </div>
      </template>
    </div>

    <CustomMetricEditorModal
      v-if="customEditorOpen"
      :definition="customEditing"
      @close="customEditorOpen = false"
    />
    <CustomMetricSkillModal v-model="customSkillOpen" />

    <!-- Compute Tab -->
    <div v-if="activeTab === 'compute'" class="tab-content">
      <!-- Graph Info Section -->
      <div class="section">
        <div class="section-header" @click="toggleSection('graphInfo')">
          <span class="section-title">Graph Info</span>
          <ChevronDown v-if="expandedSections.graphInfo" :size="12" class="toggle-icon" /><ChevronRight v-else :size="12" class="toggle-icon" />
        </div>
        <div v-if="expandedSections.graphInfo" class="section-content">
          <div class="info-grid">
            <div class="info-item">
              <span class="info-label">Nodes</span>
              <span class="info-value">{{ graphInfo.nodeCount }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Edges</span>
              <span class="info-value">{{ graphInfo.edgeCount }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Components</span>
              <span class="info-value">{{ graphInfo.componentCount }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Density</span>
              <span class="info-value">{{ graphInfo.density.toFixed(4) }}</span>
            </div>
          </div>
          <div v-if="!graphInfo.isConnected" class="warning-badge">
            Disconnected Graph
          </div>
        </div>
      </div>

      <!-- Active Computations -->
      <div v-if="activeComputations.length > 0" class="section">
        <div class="section-header">
          <span class="section-title">Active Computations</span>
        </div>
        <div class="section-content">
          <div
            v-for="comp in activeComputations"
            :key="comp.id"
            class="computation-item"
          >
            <div class="comp-header">
              <span class="comp-name">{{ comp.name }}</span>
              <div class="comp-actions">
                <button
                  class="mini-btn"
                  @click="togglePause(comp.id)"
                  :title="comp.status === 'paused' ? 'Resume' : 'Pause'"
                >
                  <Play v-if="comp.status === 'paused'" :size="12" /><Pause v-else :size="12" />
                </button>
                <button
                  class="mini-btn danger"
                  @click="cancelComputation(comp.id)"
                  title="Cancel"
                >
                  <X :size="12" />
                </button>
              </div>
            </div>
            <div class="progress-bar">
              <div
                class="progress-fill"
                :style="{ width: `${comp.progress}%` }"
                :class="{ paused: comp.status === 'paused' }"
              ></div>
            </div>
            <div class="comp-info">
              <span>{{ Math.round(comp.progress) }}%</span>
              <span v-if="comp.currentIteration">
                Iter {{ comp.currentIteration }}/{{ comp.maxIterations }}
              </span>
              <span>{{ formatTime(comp.elapsedMs) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Compute New Metric -->
      <div class="section">
        <div class="section-header" @click="toggleSection('compute')">
          <span class="section-title">Compute New Metric</span>
          <ChevronDown v-if="expandedSections.compute" :size="12" class="toggle-icon" /><ChevronRight v-else :size="12" class="toggle-icon" />
        </div>
        <div v-if="expandedSections.compute" class="section-content">
          <!-- Algorithm Selector -->
          <div class="form-group">
            <label>Algorithm</label>
            <select v-model="selectedAlgorithm" class="form-select">
              <option :value="null">Select an algorithm...</option>
              <optgroup label="Node Centrality">
                <option v-for="algo in nodeAlgorithms" :key="algo.id" :value="algo.id">
                  {{ algo.name }}
                </option>
              </optgroup>
              <optgroup label="Edge Metrics">
                <option v-for="algo in edgeAlgorithms" :key="algo.id" :value="algo.id">
                  {{ algo.name }}
                </option>
              </optgroup>
            </select>
          </div>

          <!-- Algorithm Description -->
          <div v-if="selectedAlgorithmDef" class="algo-description">
            {{ selectedAlgorithmDef.description }}
            <span v-if="selectedAlgorithmDef.requiresConnectedGraph" class="algo-warning">
              (Requires connected graph)
            </span>
          </div>

          <!-- Algorithm Parameters -->
          <template v-if="selectedAlgorithmDef">
            <div
              v-for="param in selectedAlgorithmDef.paramSchema"
              :key="param.key"
              class="form-group"
            >
              <label>{{ param.label }}</label>

              <!-- Number input -->
              <template v-if="param.type === 'number'">
                <input
                  type="number"
                  v-model.number="algorithmParams[param.key]"
                  :min="param.min"
                  :max="param.max"
                  :step="param.step || 1"
                  class="form-input"
                />
              </template>

              <!-- Boolean toggle -->
              <template v-else-if="param.type === 'boolean'">
                <label class="toggle-label">
                  <input
                    type="checkbox"
                    v-model="algorithmParams[param.key]"
                  />
                  <span>{{ param.description }}</span>
                </label>
              </template>

              <!-- Select -->
              <template v-else-if="param.type === 'select' && param.options">
                <select v-model="algorithmParams[param.key]" class="form-select">
                  <option
                    v-for="opt in param.options"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </option>
                </select>
              </template>

              <!-- Edge type filter -->
              <template v-else-if="param.type === 'edge-types'">
                <select
                  v-model="edgeTypeFilter"
                  class="form-select"
                  multiple
                  size="3"
                >
                  <option v-for="type in graphStore.edgeTypes" :key="type" :value="type">
                    {{ type }}
                  </option>
                </select>
                <span class="form-hint">Empty = all edge types</span>
              </template>
            </div>
          </template>

          <!-- Compute Options -->
          <div v-if="selectedAlgorithm" class="compute-options">
            <div class="form-group">
              <label>Priority</label>
              <select v-model="computePriority" class="form-select">
                <option value="low">Low (Background)</option>
                <option value="medium">Medium</option>
                <option value="high">High (Fastest)</option>
              </select>
            </div>
          </div>

          <!-- Compute Button -->
          <button
            v-if="selectedAlgorithm"
            class="compute-btn"
            :disabled="isComputing"
            @click="computeMetric"
          >
            {{ isComputing ? 'Computing...' : 'Compute Metric' }}
          </button>
        </div>
      </div>

      <!-- Computed Metrics List -->
      <div v-if="nodeMetrics.length > 0 || edgeMetrics.length > 0" class="section">
        <div class="section-header">
          <span class="section-title">Computed Metrics</span>
        </div>
        <div class="section-content">
          <div
            v-for="metric in computedMetricsList"
            :key="metric.id"
            class="metric-item"
          >
            <div class="metric-row">
              <span class="metric-name" :title="metric.name">{{ metric.name }}</span>
              <span v-if="metric.id.startsWith('__builtin_')" class="metric-kind">built-in</span>
            </div>
            <div class="metric-meta">
              {{ metric.target }} · min {{ formatMetricValue(metric.min) }} · max {{ formatMetricValue(metric.max) }} · mean {{ formatMetricValue(metric.mean) }}
            </div>
            <div class="metric-footer">
              <label class="table-toggle" title="Add as a column in the table drawer">
                <input
                  type="checkbox"
                  :checked="metricsStore.tableMetricIds.has(metric.id)"
                  :data-testid="`metric-table-toggle-${metric.id}`"
                  @change="metricsStore.toggleMetricInTable(metric.id)"
                />
                <span>Table column</span>
              </label>
              <button v-if="!metric.id.startsWith('__builtin_')" class="mini-btn danger" @click="deleteMetric(metric.id)">
                Delete
              </button>
            </div>
          </div>
          <p v-if="customMetricsStore.definitions.length > 0" class="custom-intro">
            Custom metrics are listed in the <a href="#" @click.prevent="activeTab = 'custom'">Custom</a> tab.
          </p>
        </div>
      </div>
    </div>

    <!-- Mapping Tab -->
    <div v-if="activeTab === 'mapping'" class="tab-content">
      <!-- Node Size Mapping -->
      <div class="section">
        <div class="section-header" @click="toggleSection('nodeMapping')">
          <span class="section-title">Node Size</span>
          <ChevronDown v-if="expandedSections.nodeMapping" :size="12" class="toggle-icon" /><ChevronRight v-else :size="12" class="toggle-icon" />
        </div>
        <div v-if="expandedSections.nodeMapping" class="section-content">
          <div class="form-group">
            <label>Metric</label>
            <select
              :value="nodeSizeMapping.metricId"
              @change="metricsStore.setNodeSizeMetric(($event.target as HTMLSelectElement).value || null)"
              class="form-select"
            >
              <option :value="null">None (Fixed Size)</option>
              <option v-for="metric in numericNodeMetrics" :key="metric.id" :value="metric.id">
                {{ metric.name }}
              </option>
            </select>
          </div>

          <template v-if="nodeSizeMapping.metricId">
            <div class="form-group">
              <label>Scale</label>
              <select
                :value="nodeSizeMapping.scale"
                @change="metricsStore.updateNodeSizeMapping({ scale: ($event.target as HTMLSelectElement).value as ScaleType })"
                class="form-select"
              >
                <option v-for="opt in scaleOptions" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
            </div>

            <div class="range-inputs">
              <div class="form-group">
                <label>Min Size</label>
                <input
                  type="number"
                  :value="nodeSizeMapping.minSize"
                  @input="metricsStore.updateNodeSizeMapping({ minSize: parseFloat(($event.target as HTMLInputElement).value) })"
                  min="1"
                  max="50"
                  step="1"
                  class="form-input"
                />
              </div>
              <div class="form-group">
                <label>Max Size</label>
                <input
                  type="number"
                  :value="nodeSizeMapping.maxSize"
                  @input="metricsStore.updateNodeSizeMapping({ maxSize: parseFloat(($event.target as HTMLInputElement).value) })"
                  min="1"
                  max="100"
                  step="1"
                  class="form-input"
                />
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- Edge Weight Mapping -->
      <div class="section">
        <div class="section-header" @click="toggleSection('edgeMapping')">
          <span class="section-title">Edge Weight</span>
          <ChevronDown v-if="expandedSections.edgeMapping" :size="12" class="toggle-icon" /><ChevronRight v-else :size="12" class="toggle-icon" />
        </div>
        <div v-if="expandedSections.edgeMapping" class="section-content">
          <div class="form-group">
            <label>Metric</label>
            <select
              :value="edgeWeightMapping.metricId"
              @change="metricsStore.setEdgeWeightMetric(($event.target as HTMLSelectElement).value || null)"
              class="form-select"
            >
              <option :value="null">None (Fixed Weight)</option>
              <option v-for="metric in numericEdgeMetrics" :key="metric.id" :value="metric.id">
                {{ metric.name }}
              </option>
            </select>
          </div>

          <template v-if="edgeWeightMapping.metricId">
            <div class="form-group">
              <label>Scale</label>
              <select
                :value="edgeWeightMapping.scale"
                @change="metricsStore.updateEdgeWeightMapping({ scale: ($event.target as HTMLSelectElement).value as ScaleType })"
                class="form-select"
              >
                <option v-for="opt in scaleOptions" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
            </div>

            <div class="range-inputs">
              <div class="form-group">
                <label>Min Weight</label>
                <input
                  type="number"
                  :value="edgeWeightMapping.minWeight"
                  @input="metricsStore.updateEdgeWeightMapping({ minWeight: parseFloat(($event.target as HTMLInputElement).value) })"
                  min="0.1"
                  max="10"
                  step="0.1"
                  class="form-input"
                />
              </div>
              <div class="form-group">
                <label>Max Weight</label>
                <input
                  type="number"
                  :value="edgeWeightMapping.maxWeight"
                  @input="metricsStore.updateEdgeWeightMapping({ maxWeight: parseFloat(($event.target as HTMLInputElement).value) })"
                  min="0.1"
                  max="20"
                  step="0.1"
                  class="form-input"
                />
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- Reset button -->
      <button class="reset-btn" @click="metricsStore.resetVisualMapping">
        Reset to Defaults
      </button>
    </div>
  </div>
</template>

<style scoped>
.metrics-panel {
  width: 280px;
  background: var(--card-background);
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
  padding: 16px;
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

.btn-sm {
  padding: 4px 8px;
  font-size: 12px;
}

.close-btn {
  font-size: 16px;
  padding: 2px 8px;
}

.header-actions {
  display: flex;
  gap: 4px;
}

.icon-btn {
  padding: 4px 8px;
  background: transparent;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.icon-btn:hover {
  background: var(--bg-secondary, #f5f5f5);
}

/* Custom metrics tab */
.custom-actions {
  display: flex;
  gap: 6px;
  align-items: stretch;
  margin-bottom: 6px;
}

.custom-actions .mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.custom-actions--secondary .mini-btn {
  flex: 1;
  padding: 5px 8px;
}

.custom-actions .mini-btn.active {
  border-color: var(--primary-color, #42b883);
  color: var(--primary-color, #42b883);
}

.custom-import {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px dashed var(--border-color, #ccc);
  border-radius: 6px;
  margin-bottom: 8px;
}

.custom-import-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 6px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  font-family: 'Monaco', 'Menlo', monospace;
  font-size: 11px;
  resize: vertical;
}

.file-input {
  display: none;
}

.custom-actions .compute-btn {
  flex: 1;
}

.custom-readonly-note,
.empty-hint {
  font-size: 12px;
  color: var(--text-muted, #666);
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-secondary, #f5f5f5);
  margin-top: 8px;
}

.custom-intro {
  font-size: 11px;
  color: var(--text-muted, #666);
  margin: 0 0 8px;
}

.custom-intro code {
  font-family: 'Monaco', 'Menlo', monospace;
}

.custom-status {
  font-size: 10px;
}

.custom-status.is-error {
  color: var(--error-color, #e74c3c);
}

.custom-status.is-stale {
  color: var(--warning-color, #b7791f);
}

/* Tabs */
.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border-color, #ddd);
  padding-bottom: 8px;
}

.tab {
  flex: 1;
  /* "Visual Mapping" wrapped to two lines and made its tab taller than the
     other two; the row fits on one line at this size. */
  white-space: nowrap;
  padding: 6px 8px;
  background: transparent;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
}

.tab:hover {
  background: var(--bg-secondary, #f5f5f5);
}

.tab.active {
  background: var(--primary-color, #42b883);
  color: white;
  border-color: var(--primary-color, #42b883);
}

/* Sections */
.section {
  margin-bottom: 12px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  overflow: hidden;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  background: var(--bg-secondary, #f8f8f8);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}

.section-header:hover {
  background: var(--bg-secondary, #f0f0f0);
}

.toggle-icon {
  font-size: 10px;
  color: var(--text-muted, #666);
}

.section-content {
  padding: 10px;
}

/* Info Grid */
.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.info-item {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}

.info-label {
  color: var(--text-muted, #666);
}

.info-value {
  font-weight: 500;
  font-family: monospace;
}

.warning-badge {
  margin-top: 8px;
  padding: 4px 8px;
  background: #fff3cd;
  color: #856404;
  border-radius: 4px;
  font-size: 11px;
  text-align: center;
}

/* Computation Items */
.computation-item {
  padding: 8px;
  background: var(--bg-secondary, #f8f8f8);
  border-radius: 4px;
  margin-bottom: 8px;
}

.computation-item:last-child {
  margin-bottom: 0;
}

.comp-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.comp-name {
  font-size: 12px;
  font-weight: 500;
}

.comp-actions {
  display: flex;
  gap: 4px;
}

.mini-btn {
  padding: 2px 6px;
  background: var(--card-background, white);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 3px;
  cursor: pointer;
  font-size: 10px;
}

.mini-btn:hover {
  background: var(--bg-secondary, #f0f0f0);
}

.mini-btn.danger {
  color: var(--danger-color, #dc3545);
}

.mini-btn.danger:hover {
  background: #fee;
}

.progress-bar {
  height: 4px;
  background: var(--border-color, #ddd);
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 4px;
}

.progress-fill {
  height: 100%;
  background: var(--primary-color, #42b883);
  transition: width 0.3s;
}

.progress-fill.paused {
  background: var(--warning-color, #ffc107);
}

.comp-info {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-muted, #666);
}

/* Form Elements */
.form-group {
  margin-bottom: 10px;
}

.form-group label {
  display: block;
  font-size: 11px;
  color: var(--text-muted, #666);
  margin-bottom: 4px;
}

.form-select,
.form-input {
  width: 100%;
  padding: 6px 8px;
  font-size: 12px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  background: var(--card-background, white);
}

.form-select:focus,
.form-input:focus {
  outline: none;
  border-color: var(--primary-color, #42b883);
}

.form-hint {
  font-size: 10px;
  color: var(--text-muted, #999);
  display: block;
  margin-top: 2px;
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  cursor: pointer;
}

.toggle-label input {
  cursor: pointer;
}

.algo-description {
  font-size: 11px;
  color: var(--text-muted, #666);
  padding: 8px;
  background: var(--bg-secondary, #f8f8f8);
  border-radius: 4px;
  margin-bottom: 10px;
}

.algo-warning {
  color: var(--warning-color, #856404);
  font-weight: 500;
}

.compute-options {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color, #ddd);
}

.compute-btn {
  width: 100%;
  padding: 10px;
  background: var(--primary-color, #42b883);
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  margin-top: 12px;
}

.compute-btn:hover:not(:disabled) {
  background: var(--primary-dark, #3aa876);
}

.compute-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Metric Items */
.metric-item {
  padding: 8px;
  background: var(--bg-secondary, #f8f8f8);
  border-radius: 4px;
  margin-bottom: 8px;
}

.metric-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.metric-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-color, #333);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.metric-kind {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-muted, #999);
  flex-shrink: 0;
}

.metric-meta {
  font-size: 10px;
  color: var(--text-muted, #666);
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
}

.metric-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-top: 6px;
}

.table-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-secondary, #999);
  cursor: pointer;
  white-space: nowrap;
}

.table-toggle input {
  cursor: pointer;
  margin: 0;
}

.metric-actions {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
}

/* Range Inputs */
.range-inputs {
  display: flex;
  gap: 12px;
}

.range-inputs .form-group {
  flex: 1;
}

/* Reset Button */
.reset-btn {
  width: 100%;
  padding: 8px;
  background: transparent;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-muted, #666);
  margin-top: 12px;
}

.reset-btn:hover {
  background: var(--bg-secondary, #f5f5f5);
}

/* Tab Content */
.tab-content {
  min-height: 200px;
}
</style>
