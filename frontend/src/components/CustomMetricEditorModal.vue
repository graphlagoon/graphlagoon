<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';
import { useCustomMetricsStore } from '@/stores/customMetrics';
import type {
  CustomMetricDefinition,
  CustomMetricTestResult,
  MetricTarget,
  MetricValueType,
} from '@/types/customMetrics';
import {
  CUSTOM_METRIC_MAX_CODE_LENGTH,
  CUSTOM_METRIC_MAX_DESCRIPTION_LENGTH,
  CUSTOM_METRIC_MAX_NAME_LENGTH,
} from '@/types/customMetrics';
import { customMetricCompletions, DEFAULT_CODE } from '@/utils/customMetricCompletions';
import { formatMetricValue } from '@/utils/metricFormat';
import {
  parseImportedCustomMetrics,
  customMetricCompatibilityWarnings,
  hasCustomMetricCompatibilityWarnings,
} from '@/utils/customMetricImport';
import { buildSourceSchema, downloadJson, readFileAsText, safeFilename } from '@/utils/portableExport';
import { PORTABLE_EXPORT_VERSION, type PortableCustomMetrics, type PortableSourceSchema } from '@/types/portable';
import { useGraphStore } from '@/stores/graph';
import { useMetricsStore } from '@/stores/metrics';
import { isCustomMetricId } from '@/types/customMetrics';
import JavaScriptEditor from './JavaScriptEditor.vue';
import CustomMetricSkillModal from './CustomMetricSkillModal.vue';
import { X, Bot, Download } from 'lucide-vue-next';

const props = defineProps<{
  /** Definition to edit, or null to create a new one */
  definition: CustomMetricDefinition | null;
}>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', definition: CustomMetricDefinition): void }>();

const store = useCustomMetricsStore();
const graphStore = useGraphStore();
const metricsStore = useMetricsStore();
const isEditMode = computed(() => props.definition !== null);
const canEdit = computed(() => store.canEdit);

const name = ref(props.definition?.name ?? '');
const target = ref<MetricTarget>(props.definition?.target ?? 'node');
const valueType = ref<MetricValueType>(props.definition?.value_type ?? 'number');
const description = ref(props.definition?.description ?? '');
const autoRun = ref(props.definition?.auto_run === true);
const showInTable = ref(props.definition?.show_in_table === true);
const autoRunAllowed = computed(() => store.autoRunAllowed);
const code = ref(props.definition?.code ?? DEFAULT_CODE.node);
let codeWasDefault = props.definition === null;

const completions = computed(() => customMetricCompletions(target.value));
const skillOpen = ref(false);

// ─── Import JSON (Ask-AI return leg) / Export JSON ───
const showImport = ref(false);
const importText = ref('');
const importError = ref<string | null>(null);
const importNote = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

function sourceSchema(): PortableSourceSchema {
  return buildSourceSchema({
    context: graphStore.currentContext,
    loadedNodeTypes: graphStore.nodeTypes,
    loadedEdgeTypes: graphStore.edgeTypes,
  });
}

/** Parsed view of the Import box; null while it holds nothing. */
const parsedImport = computed(() => {
  const text = importText.value.trim();
  return text ? parseImportedCustomMetrics(text) : null;
});
const importedSource = computed(() => (parsedImport.value?.ok ? parsedImport.value.source : undefined));

/** Property keys present on the loaded nodes/edges — a context may declare
 * none (nodeless / minimal config) while the graph carries plenty. */
function observedPropertyKeys(items: { properties?: Record<string, unknown> }[]): string[] {
  const keys = new Set<string>();
  for (const it of items) if (it.properties) for (const k of Object.keys(it.properties)) keys.add(k);
  return [...keys];
}

/** Properties / metric refs the pasted code uses that this graph lacks. */
const importWarnings = computed(() => {
  if (!parsedImport.value?.ok) return null;
  const schema = sourceSchema();
  const metricRefs = [...metricsStore.nodeMetrics, ...metricsStore.edgeMetrics]
    .filter((m) => !isCustomMetricId(m.id))
    .flatMap((m) => [m.name, m.id, m.algorithmId === '__builtin' ? 'degree' : m.algorithmId]);
  const w = customMetricCompatibilityWarnings(parsedImport.value.definitions, {
    nodeProperties: [...schema.node_properties, ...observedPropertyKeys(graphStore.nodes)],
    edgeProperties: [...schema.edge_properties, ...observedPropertyKeys(graphStore.edges)],
    metricRefs,
    // The definition being edited may keep its own name.
    existingNames: store.definitions.filter((d) => d.id !== props.definition?.id).map((d) => d.name),
  });
  return hasCustomMetricCompatibilityWarnings(w) ? w : null;
});

/** Open the JSON box; in edit mode it starts with the current metric so it can be tweaked and re-applied. */
function toggleImport() {
  showImport.value = !showImport.value;
  if (showImport.value && !importText.value.trim() && isEditMode.value) {
    importText.value = JSON.stringify(draft(), null, 2);
  }
  if (showImport.value) {
    void nextTick(() => importSection.value?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }
}
const importSection = ref<HTMLElement | null>(null);

async function pickFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importError.value = null;
  try {
    importText.value = await readFileAsText(file);
  } catch {
    importError.value = 'Could not read the file';
  } finally {
    input.value = '';
  }
}

/** Fill the form from the pasted JSON (first metric when several were pasted). */
function applyImport() {
  importError.value = null;
  importNote.value = null;
  const result = parseImportedCustomMetrics(importText.value);
  if (!result.ok) {
    importError.value = result.error;
    return;
  }
  const [first, ...rest] = result.definitions;
  name.value = first.name;
  target.value = first.target;
  valueType.value = first.value_type;
  description.value = first.description ?? '';
  autoRun.value = first.auto_run === true;
  showInTable.value = first.show_in_table === true;
  code.value = first.code;
  codeWasDefault = false;
  testResult.value = null;
  if (rest.length > 0) {
    importNote.value = `Loaded the first of ${result.definitions.length} metrics — use "Import JSON" in the Custom tab to add several at once.`;
  } else {
    showImport.value = false;
    importText.value = '';
  }
}

/** Download the metric in the form as a portable JSON file. */
function exportDefinition() {
  const payload: PortableCustomMetrics = {
    graphlagoon_export: 'custom-metrics',
    export_version: PORTABLE_EXPORT_VERSION,
    source: sourceSchema(),
    metrics: [draft()],
  };
  downloadJson(safeFilename(`metric-${name.value.trim() || 'custom'}`), payload);
}

/** Switching target on a fresh definition swaps the starter code. */
function onTargetChange(next: MetricTarget) {
  if (codeWasDefault && (code.value === DEFAULT_CODE.node || code.value === DEFAULT_CODE.edge)) {
    code.value = DEFAULT_CODE[next];
  } else {
    codeWasDefault = false;
  }
  target.value = next;
  testResult.value = null;
}

const nameError = computed(() => {
  const n = name.value.trim();
  if (!n) return 'Name is required';
  if (n.length > CUSTOM_METRIC_MAX_NAME_LENGTH) return `Name must be at most ${CUSTOM_METRIC_MAX_NAME_LENGTH} characters`;
  if (!store.isNameAvailable(n, props.definition?.id)) return 'Another custom metric already uses this name';
  return null;
});
const codeError = computed(() => {
  if (!code.value.trim()) return 'Code is required';
  if (code.value.length > CUSTOM_METRIC_MAX_CODE_LENGTH) return `Code must be at most ${CUSTOM_METRIC_MAX_CODE_LENGTH} characters`;
  return null;
});
const descriptionError = computed(() =>
  description.value.length > CUSTOM_METRIC_MAX_DESCRIPTION_LENGTH
    ? `Description must be at most ${CUSTOM_METRIC_MAX_DESCRIPTION_LENGTH} characters`
    : null,
);
const isValid = computed(() => !nameError.value && !codeError.value && !descriptionError.value);

function draft(): CustomMetricDefinition {
  const d: CustomMetricDefinition = {
    id: props.definition?.id ?? crypto.randomUUID(),
    name: name.value.trim(),
    target: target.value,
    value_type: valueType.value,
    code: code.value,
  };
  const desc = description.value.trim();
  if (desc) d.description = desc;
  if (autoRun.value) d.auto_run = true;
  if (showInTable.value) d.show_in_table = true;
  return d;
}

// ─── Test run ───
const testing = ref(false);
const testResult = ref<CustomMetricTestResult | null>(null);
const MAX_SAMPLE_ROWS = 10;

const visibleSamples = computed(() => (testResult.value?.samples ?? []).slice(0, MAX_SAMPLE_ROWS));
/** Items whose raw return type disagrees with the declared value type. */
const typeMismatches = computed(() => {
  if (!testResult.value) return 0;
  return testResult.value.samples.filter(
    (s) => s.rawType !== 'null' && s.rawType !== 'undefined' && s.rawType !== valueType.value,
  ).length;
});

async function runTest() {
  if (codeError.value || testing.value) return;
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await store.testDefinition(draft());
    void nextTick(() => testSection.value?.scrollIntoView({ block: 'end', behavior: 'smooth' }));
  } finally {
    testing.value = false;
  }
}
const testSection = ref<HTMLElement | null>(null);

function save() {
  if (!isValid.value || !canEdit.value) return;
  const d = draft();
  if (isEditMode.value) store.updateDefinition(d);
  else store.addDefinition(d);
  emit('saved', d);
  emit('close');
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal metric-editor-modal" data-testid="custom-metric-editor-modal">
        <div class="modal-header">
          <h2>{{ isEditMode ? 'Edit Custom Metric' : 'New Custom Metric' }}</h2>
          <button class="modal-close" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
        </div>

        <div class="modal-body">
          <div v-if="!canEdit" class="readonly-note" data-testid="custom-metric-readonly">
            You have read-only access to this context. Custom metrics can only be edited by users with write access.
          </div>

          <!-- Import JSON (Ask-AI return leg) -->
          <div v-if="showImport && canEdit" ref="importSection" class="import-section">
            <div class="field-label">{{ isEditMode ? 'Edit as JSON' : 'Import JSON' }}</div>
            <span v-if="isEditMode" class="field-hint">
              This is the metric as JSON. Edit it — or replace it with what the AI prompt answered /
              a file from another context — and apply: the fields below are updated, the metric keeps
              its id, and <strong>Save</strong> writes it back.
            </span>
            <span v-else class="field-hint">
              Paste the JSON the AI prompt (robot button) answered with, or a file exported
              from another context. The fields below are filled from it — review, test, save.
            </span>
            <textarea
              v-model="importText"
              class="import-textarea"
              data-testid="custom-metric-import-text"
              rows="5"
              placeholder='{"name": "...", "target": "node", "value_type": "number", "code": "return ..."}'
            />
            <div class="import-actions">
              <input
                ref="fileInput"
                type="file"
                accept=".json,application/json"
                class="file-input"
                data-testid="custom-metric-import-file"
                @change="pickFile"
              />
              <button type="button" class="btn-secondary" @click="fileInput?.click()">Choose file…</button>
              <button
                type="button"
                class="btn-primary"
                data-testid="custom-metric-import-apply"
                :disabled="!parsedImport?.ok"
                @click="applyImport"
              >
                {{ isEditMode ? 'Apply JSON' : 'Fill the form' }}
              </button>
            </div>
            <span
              v-if="parsedImport && !parsedImport.ok"
              class="field-error"
              data-testid="custom-metric-import-parse-error"
            >
              {{ parsedImport.error }}
            </span>
            <div v-if="importWarnings" class="warning-block" data-testid="custom-metric-import-warnings">
              <p>This code names things this graph does not have:</p>
              <ul>
                <li v-if="importWarnings.missingProperties.length">
                  properties: {{ importWarnings.missingProperties.join(', ') }}
                </li>
                <li v-if="importWarnings.missingMetricRefs.length">
                  metrics: {{ importWarnings.missingMetricRefs.join(', ') }}
                </li>
                <li v-if="importWarnings.nameCollisions.length">
                  names already taken: {{ importWarnings.nameCollisions.join(', ') }}
                </li>
              </ul>
              <button
                type="button"
                class="btn-secondary"
                data-testid="custom-metric-import-adapt"
                @click="skillOpen = true"
              >
                <Bot :size="14" /> Ask an AI to adapt it
              </button>
            </div>
            <span v-if="importError" class="field-error">{{ importError }}</span>
            <span v-if="importNote" class="field-hint" data-testid="custom-metric-import-note">{{ importNote }}</span>
          </div>

          <div class="field-group">
            <label class="field-label">Name <span class="required-mark">*</span></label>
            <input
              v-model="name"
              type="text"
              class="field-input"
              :class="{ invalid: name && nameError }"
              :disabled="!canEdit"
              placeholder="e.g., Email domain"
              data-testid="custom-metric-name"
            />
            <span v-if="name && nameError" class="field-error" data-testid="custom-metric-name-error">{{ nameError }}</span>
          </div>

          <div class="field-row">
            <div class="field-group">
              <label class="field-label">Applies to</label>
              <label class="radio-label">
                <input
                  type="radio"
                  value="node"
                  :checked="target === 'node'"
                  :disabled="!canEdit"
                  data-testid="custom-metric-target-node"
                  @change="onTargetChange('node')"
                />
                Nodes
              </label>
              <label class="radio-label">
                <input
                  type="radio"
                  value="edge"
                  :checked="target === 'edge'"
                  :disabled="!canEdit"
                  data-testid="custom-metric-target-edge"
                  @change="onTargetChange('edge')"
                />
                Edges
              </label>
            </div>

            <div class="field-group">
              <label class="field-label">Value type</label>
              <select v-model="valueType" class="field-input" :disabled="!canEdit" data-testid="custom-metric-value-type">
                <option value="number">Number (can drive size / width)</option>
                <option value="string">Text</option>
                <option value="boolean">Boolean</option>
              </select>
            </div>
          </div>

          <div class="field-group">
            <label class="field-label">Description</label>
            <input
              v-model="description"
              type="text"
              class="field-input"
              :disabled="!canEdit"
              placeholder="Optional description"
              data-testid="custom-metric-description"
            />
            <span v-if="descriptionError" class="field-error">{{ descriptionError }}</span>
          </div>

          <div class="field-group">
            <label class="checkbox-label" :class="{ muted: !autoRunAllowed }">
              <input
                v-model="autoRun"
                type="checkbox"
                :disabled="!canEdit || !autoRunAllowed"
                data-testid="custom-metric-auto-run"
              />
              Run automatically when the graph loads
            </label>
            <label class="checkbox-label">
              <input v-model="showInTable" type="checkbox" :disabled="!canEdit" data-testid="custom-metric-show-in-table" />
              Show as a Data Table column
            </label>
            <span v-if="autoRunAllowed" class="field-hint">
              Auto-run metrics evaluate in the browser of <strong>every writer</strong> who opens this
              context, and again whenever the loaded graph changes. Off = only on <em>Recompute</em>.
            </span>
            <span v-else class="field-hint" data-testid="custom-metric-auto-run-disabled">
              Automatic runs are disabled on this server (<code>GRAPH_LAGOON_CUSTOM_METRICS_AUTO_RUN_ENABLED=false</code>);
              every custom metric runs only on <em>Recompute</em>.
            </span>
          </div>

          <div class="field-group">
            <label class="field-label">
              JavaScript <span class="required-mark">*</span>
              <span class="field-hint">body of <code>function(item, ctx)</code> — evaluated per {{ target }} in a sandboxed worker</span>
              <button
                type="button"
                class="skill-btn"
                data-testid="custom-metric-skill-help"
                title="Not sure how? Get an AI prompt to write this metric"
                aria-label="Get help writing a custom metric"
                @click="skillOpen = true"
              >
                <Bot :size="14" />
              </button>
            </label>
            <div data-testid="custom-metric-code">
              <JavaScriptEditor
                v-model="code"
                :completions="completions"
                :disabled="!canEdit"
                :has-error="!!codeError && code.length > 0"
                placeholder="return ctx.degree;"
              />
            </div>
            <span class="field-hint">
              No network, storage or DOM access; 10 s limit per metric. Return <code>null</code> when there is no value.
              Other metrics are reachable through <code>ctx.metrics</code> / <code>ctx.metric('pagerank')</code>.
            </span>
            <span v-if="codeError && code.length > 0" class="field-error">{{ codeError }}</span>
          </div>

          <div ref="testSection" class="test-section">
            <div class="test-header">
              <button
                class="btn-secondary"
                :disabled="!!codeError || testing"
                data-testid="custom-metric-test"
                @click="runTest"
              >
                {{ testing ? 'Testing…' : 'Test on current graph' }}
              </button>
              <span v-if="testResult && !testResult.error" class="field-hint">
                {{ testResult.samples.length }} sampled · {{ testResult.elapsedMs.toFixed(0) }} ms
              </span>
            </div>

            <div v-if="testResult" class="test-results" data-testid="custom-metric-test-results">
              <div v-if="testResult.error" class="test-error" data-testid="custom-metric-test-error">{{ testResult.error }}</div>
              <template v-else>
                <div v-if="testResult.errorCount > 0" class="test-warning" data-testid="custom-metric-test-item-errors">
                  {{ testResult.errorCount }} of {{ testResult.samples.length }} items threw
                  <span v-if="testResult.firstItemError"> — first: <code>{{ testResult.firstItemError }}</code></span>
                </div>
                <div v-if="typeMismatches > 0" class="test-warning" data-testid="custom-metric-test-type-hint">
                  {{ typeMismatches }} item(s) returned a value that is not a {{ valueType }} — they become
                  <code>null</code>. Change the value type or convert in code.
                </div>
                <div v-if="testResult.samples.length === 0" class="field-hint">No items to sample (empty graph?).</div>
                <table v-else class="sample-table">
                  <thead>
                    <tr><th>id</th><th>value</th><th>returned</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="s in visibleSamples" :key="s.id" data-testid="custom-metric-test-row">
                      <td class="mono">{{ s.id }}</td>
                      <td class="mono">{{ formatMetricValue(s.value, 'long') }}</td>
                      <td class="muted">{{ s.rawType }}</td>
                    </tr>
                  </tbody>
                </table>
              </template>
            </div>
          </div>
        </div>

        <CustomMetricSkillModal
          v-model="skillOpen"
          :imported-json="importWarnings ? importText : undefined"
          :imported-source="importWarnings ? importedSource : undefined"
        />

        <div class="modal-footer">
          <div v-if="canEdit" class="import-toolbar">
            <button
              type="button"
              class="btn-secondary"
              :class="{ active: showImport }"
              data-testid="custom-metric-import-toggle"
              @click="toggleImport"
            >
              {{ isEditMode ? 'Edit as JSON' : 'Import JSON' }}
            </button>
            <button
              type="button"
              class="btn-secondary"
              data-testid="custom-metric-export"
              :disabled="!isValid"
              title="Download this metric as a JSON file you can import into another context"
              @click="exportDefinition"
            >
              <Download :size="14" /> Export JSON
            </button>
          </div>
          <span class="footer-spacer" />
          <button class="btn-secondary" @click="emit('close')">Cancel</button>
          <button
            v-if="canEdit"
            class="btn-primary"
            :disabled="!isValid"
            data-testid="custom-metric-save"
            @click="save"
          >
            {{ isEditMode ? 'Save' : 'Create' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.metric-editor-modal {
  background: var(--card-background, #fff);
  border-radius: 12px;
  width: 680px;
  max-width: 95vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--border-color, #ddd);
  flex-shrink: 0;
}

.modal-header h2 {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
}

.modal-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted, #666);
  line-height: 1;
  padding: 0 4px;
}

.modal-body {
  padding: 20px 24px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 24px;
  border-top: 1px solid var(--border-color, #ddd);
}

.readonly-note {
  font-size: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-secondary, #f5f5f5);
  color: var(--text-muted, #666);
}

.field-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1;
}

.field-row {
  display: flex;
  gap: 16px;
}

.field-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-color, #333);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.field-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted, #888);
}

.field-hint code,
.test-warning code,
.test-error code {
  background: var(--bg-secondary, #f0f0f0);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: 'Monaco', 'Menlo', monospace;
}

.field-error {
  font-size: 11px;
  color: var(--error-color, #e74c3c);
}

.required-mark {
  color: var(--error-color, #e74c3c);
}

.field-input {
  padding: 7px 10px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  font-size: 13px;
  background: var(--bg-color, #fafafa);
  color: var(--text-color, #333);
  outline: none;
  width: 100%;
  box-sizing: border-box;
}

.field-input:focus {
  border-color: var(--primary-color, #42b883);
  box-shadow: 0 0 0 2px rgba(66, 184, 131, 0.2);
}

.field-input.invalid {
  border-color: var(--error-color, #e74c3c);
}

.import-toolbar {
  display: flex;
  gap: 8px;
}

.footer-spacer {
  flex: 1;
}

.btn-secondary.active {
  border-color: var(--primary-color, #42b883);
  color: var(--primary-color, #42b883);
}

.import-toolbar .btn-secondary,
.import-actions .btn-secondary,
.warning-block .btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.import-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px dashed var(--border-color, #ccc);
  border-radius: 8px;
}

.import-textarea {
  padding: 6px 8px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  font-family: 'Monaco', 'Menlo', monospace;
  font-size: 12px;
  background: var(--bg-color, #fafafa);
  color: var(--text-color, #333);
  resize: vertical;
}

.import-actions {
  display: flex;
  gap: 8px;
}

.file-input {
  display: none;
}

.warning-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid #b45309;
  border-radius: 6px;
  color: #b45309;
  font-size: 12px;
}

.warning-block p,
.warning-block ul {
  margin: 0;
}

.warning-block ul {
  padding-left: 18px;
}

.skill-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted, #666);
  cursor: pointer;
}

.skill-btn:hover {
  background: var(--bg-secondary, #f5f5f5);
  color: var(--primary-color, #42b883);
}

.radio-label,
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.checkbox-label.muted {
  color: var(--text-muted, #888);
}

.test-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.test-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.test-results {
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.test-error {
  color: var(--error-color, #e74c3c);
  font-family: 'Monaco', 'Menlo', monospace;
  white-space: pre-wrap;
}

.test-warning {
  color: var(--warning-color, #b7791f);
}

.sample-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.sample-table th,
.sample-table td {
  text-align: left;
  padding: 3px 6px;
  border-bottom: 1px solid var(--border-color, #eee);
}

.mono {
  font-family: 'Monaco', 'Menlo', monospace;
}

.muted {
  color: var(--text-muted, #888);
}

.btn-primary,
.btn-secondary {
  padding: 7px 14px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  border: 1px solid var(--border-color, #ddd);
  background: var(--bg-color, #fafafa);
  color: var(--text-color, #333);
}

.btn-primary {
  background: var(--primary-color, #42b883);
  border-color: var(--primary-color, #42b883);
  color: white;
}

.btn-primary:disabled,
.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
