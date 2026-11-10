<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import { useGraphStore } from '@/stores/graph'
import { useMetricsStore } from '@/stores/metrics'
import type {
  ClusterProgram,
  ClusterProgramParameter,
  ClusterProgramNodeBinding,
  ClusterProgramScope,
} from '@/types/cluster'
import JavaScriptEditor from './JavaScriptEditor.vue'
import ClusterProgramSkillModal from './ClusterProgramSkillModal.vue'
import { parseImportedClusterPrograms, portableClusterProgram } from '@/utils/clusterProgramImport'
import { buildSourceSchema, downloadJson, readFileAsText, safeFilename } from '@/utils/portableExport'
import { PORTABLE_EXPORT_VERSION, type PortableClusterPrograms } from '@/types/portable'
import { X, Bot, Download } from 'lucide-vue-next'

const props = defineProps<{
  /** Program to edit, or null to create a new one */
  program: ClusterProgram | null
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const clusterStore = useClusterStore()
const graphStore = useGraphStore()
const metricsStore = useMetricsStore()
const nodeMetricNames = computed(() => metricsStore.nodeMetrics.map(m => m.name))

const isEditMode = computed(() => props.program !== null)

// Scope selector only makes sense when the user can write to the context;
// otherwise the program can only live inside the exploration.
const canChooseScope = computed(
  () => graphStore.currentContext?.has_write_access === true
)
const scope = ref<ClusterProgramScope>(
  props.program?.scope ?? (graphStore.currentContext?.has_write_access ? 'context' : 'exploration')
)

const DEFAULT_CODE = `// Write JavaScript code that returns an array of clusters
// Available context: { nodes, edges, selectedNodeIds, selectedEdgeIds, params }
// params holds the values of the parameters declared below (params.<id>)

// Example: Group nodes by type
const clustersByType = new Map();

nodes.forEach(node => {
  if (!clustersByType.has(node.node_type)) {
    clustersByType.set(node.node_type, []);
  }
  clustersByType.get(node.node_type).push(node.node_id);
});

const clusters = [];
clustersByType.forEach((nodeIds, nodeType) => {
  clusters.push({
    cluster_name: \`\${nodeType} Cluster\`,
    cluster_class: 'by-type',
    figure: 'circle',
    state: 'closed',
    node_ids: nodeIds
  });
});

return clusters;
`

const name = ref(props.program?.program_name ?? '')
const description = ref(props.program?.description ?? '')
const showInContextMenu = ref(props.program?.show_in_context_menu ?? false)
const code = ref(props.program?.code ?? DEFAULT_CODE)
const parameters = ref<ClusterProgramParameter[]>(
  (props.program?.parameters ?? []).map(p => ({ ...p, options: p.options ? [...p.options] : undefined }))
)

const PARAM_ID_REGEX = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const paramIdsValid = computed(() => {
  const ids = parameters.value.map(p => p.id.trim())
  return (
    ids.every(id => PARAM_ID_REGEX.test(id)) &&
    new Set(ids).size === ids.length
  )
})

const selectsValid = computed(() =>
  parameters.value.every(p => p.type !== 'select' || (p.options ?? []).length > 0)
)

// 'prop:'/'metric:' bindings need a name/ref after the prefix
const bindingsValid = computed(() =>
  parameters.value.every(p => {
    const b = p.node_binding
    if (!b) return true
    if (b.startsWith('prop:')) return b.length > 'prop:'.length
    if (b.startsWith('metric:')) return b.length > 'metric:'.length
    return true
  })
)

const isValid = computed(
  () =>
    name.value.trim().length > 0 &&
    code.value.trim().length > 0 &&
    paramIdsValid.value &&
    selectsValid.value &&
    bindingsValid.value
)

// ─── Node binding helpers (binding stored as 'node_id' | 'node_type' | 'prop:<name>' | 'metric:<ref>') ───

type BindingKind = '' | 'node_id' | 'node_type' | 'prop' | 'metric'

function getBindingKind(param: ClusterProgramParameter): BindingKind {
  if (!param.node_binding) return ''
  if (param.node_binding.startsWith('prop:')) return 'prop'
  if (param.node_binding.startsWith('metric:')) return 'metric'
  return param.node_binding as BindingKind
}

function getBindingProp(param: ClusterProgramParameter): string {
  return param.node_binding?.startsWith('prop:')
    ? param.node_binding.slice('prop:'.length)
    : ''
}

function getBindingMetric(param: ClusterProgramParameter): string {
  return param.node_binding?.startsWith('metric:')
    ? param.node_binding.slice('metric:'.length)
    : ''
}

function setBindingKind(param: ClusterProgramParameter, kind: BindingKind) {
  if (kind === '') {
    delete param.node_binding
  } else if (kind === 'prop') {
    param.node_binding = 'prop:'
  } else if (kind === 'metric') {
    param.node_binding = 'metric:'
  } else {
    param.node_binding = kind
  }
}

function setBindingProp(param: ClusterProgramParameter, propName: string) {
  param.node_binding = `prop:${propName.trim()}` as ClusterProgramNodeBinding
}

function setBindingMetric(param: ClusterProgramParameter, ref: string) {
  param.node_binding = `metric:${ref.trim()}` as ClusterProgramNodeBinding
}

function addParameter() {
  parameters.value.push({
    id: '',
    type: 'text',
    label: undefined,
    description: undefined,
    placeholder: undefined,
    default: undefined,
    options: undefined,
    required: true,
  })
}

function removeParameter(idx: number) {
  parameters.value.splice(idx, 1)
  // Indexes shifted — drop the cache and let it rebuild from param.options
  optionsText.value = {}
}

// Raw textarea string for select options (one per line), keyed by param index
const optionsText = ref<Record<number, string>>({})

function getOptionsText(idx: number): string {
  if (optionsText.value[idx] !== undefined) return optionsText.value[idx]
  return (parameters.value[idx].options ?? []).join('\n')
}

function setOptionsText(idx: number, val: string) {
  optionsText.value[idx] = val
  parameters.value[idx].options = val
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
}

function onTypeChange(idx: number) {
  const p = parameters.value[idx]
  // Reset default to a type-appropriate value; clear select artifacts
  p.default = p.type === 'boolean' ? false : undefined
  if (p.type === 'select') {
    if (!p.options) p.options = []
    optionsText.value[idx] = p.options.join('\n')
  } else {
    p.options = undefined
    delete optionsText.value[idx]
  }
}

// ─── Import JSON (Ask-AI return leg) / Export JSON ───
const showImport = ref(false)
const importText = ref('')
const importError = ref<string | null>(null)
const importNote = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const importSection = ref<HTMLElement | null>(null)
const skillOpen = ref(false)

/** Parsed view of the Import box; null while it holds nothing. */
const parsedImport = computed(() => {
  const text = importText.value.trim()
  return text ? parseImportedClusterPrograms(text) : null
})

/** The form as a portable program (what Export writes and "Edit as JSON" starts from). */
function draft() {
  return portableClusterProgram({
    program_name: name.value.trim(),
    description: description.value.trim() || undefined,
    code: code.value,
    parameters: parameters.value.map(p => ({ ...p, id: p.id.trim() })),
    show_in_context_menu: showInContextMenu.value,
  })
}

/** The program as the AI prompt sees it when editing an existing one. */
const promptProgram = computed(() => (isEditMode.value ? draft() : null))

/** Open the JSON box; in edit mode it starts with the current program so it can be tweaked and re-applied. */
function toggleImport() {
  showImport.value = !showImport.value
  if (showImport.value && !importText.value.trim() && isEditMode.value) {
    importText.value = JSON.stringify(draft(), null, 2)
  }
  if (showImport.value) {
    void nextTick(() => importSection.value?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }))
  }
}

async function pickFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importError.value = null
  try {
    importText.value = await readFileAsText(file)
  } catch {
    importError.value = 'Could not read the file'
  } finally {
    input.value = ''
  }
}

/** Fill the form from the pasted JSON (first program when several were pasted). */
function applyImport() {
  importError.value = null
  importNote.value = null
  const result = parseImportedClusterPrograms(importText.value)
  if (!result.ok) {
    importError.value = result.error
    return
  }
  const [first, ...rest] = result.programs
  name.value = first.program_name
  description.value = first.description ?? ''
  code.value = first.code
  showInContextMenu.value = first.show_in_context_menu === true
  parameters.value = (first.parameters ?? []).map(p => ({ ...p, options: p.options ? [...p.options] : undefined }))
  optionsText.value = {}
  if (rest.length > 0) {
    importNote.value = `Loaded the first of ${result.programs.length} programs — use "Import…" in Manage programs to add several at once.`
  } else {
    showImport.value = false
    importText.value = ''
  }
}

/** Download the program in the form as a portable JSON file. */
function exportProgram() {
  const payload: PortableClusterPrograms = {
    graphlagoon_export: 'cluster-programs',
    export_version: PORTABLE_EXPORT_VERSION,
    source: buildSourceSchema({
      context: graphStore.currentContext,
      loadedNodeTypes: graphStore.nodeTypes,
      loadedEdgeTypes: graphStore.edgeTypes,
    }),
    programs: [draft()],
  }
  downloadJson(safeFilename(`cluster-program-${name.value.trim() || 'program'}`), payload)
}

function handleSave() {
  if (!isValid.value) return

  const payload = {
    program_name: name.value.trim(),
    description: description.value.trim() || undefined,
    code: code.value,
    parameters: parameters.value.length > 0
      ? parameters.value.map(p => ({ ...p, id: p.id.trim() }))
      : undefined,
    show_in_context_menu: showInContextMenu.value || undefined,
    scope: canChooseScope.value ? scope.value : ('exploration' as ClusterProgramScope),
  }

  if (isEditMode.value && props.program) {
    clusterStore.updateProgram(props.program.program_id, payload)
  } else {
    clusterStore.createProgram(payload)
  }
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal program-editor-modal" data-testid="cluster-program-editor-modal">
        <div class="modal-header">
          <h2>{{ isEditMode ? 'Edit Program' : 'New Program' }}</h2>
          <button class="modal-close" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
        </div>

        <div class="modal-body">
          <!-- Import JSON (Ask-AI return leg) -->
          <div v-if="showImport" ref="importSection" class="import-section">
            <div class="field-label">{{ isEditMode ? 'Edit as JSON' : 'Import JSON' }}</div>
            <span class="field-hint">
              Paste the JSON the AI prompt (robot button) answered with, or a file exported
              from another context. Name, code and parameters are filled from it — review, save.
            </span>
            <textarea
              v-model="importText"
              class="field-input import-textarea"
              data-testid="cluster-program-import-text"
              rows="6"
              placeholder='{"program_name": "...", "code": "return [...]", "parameters": [{"id": "threshold", "type": "number", "default": 3}]}'
            />
            <div class="import-actions">
              <input
                ref="fileInput"
                type="file"
                accept=".json,application/json"
                class="file-input"
                data-testid="cluster-program-import-file"
                @change="pickFile"
              />
              <button type="button" class="btn btn-outline" @click="fileInput?.click()">Choose file…</button>
              <button
                type="button"
                class="btn btn-primary"
                data-testid="cluster-program-import-apply"
                :disabled="!parsedImport?.ok"
                @click="applyImport"
              >
                {{ isEditMode ? 'Apply JSON' : 'Fill the form' }}
              </button>
            </div>
            <span
              v-if="parsedImport && !parsedImport.ok"
              class="field-error"
              data-testid="cluster-program-import-parse-error"
            >{{ parsedImport.error }}</span>
            <span v-if="importError" class="field-error">{{ importError }}</span>
            <span v-if="importNote" class="field-hint" data-testid="cluster-program-import-note">{{ importNote }}</span>
          </div>

          <div class="field-group">
            <label class="field-label">Name <span class="required-mark">*</span></label>
            <input
              v-model="name"
              type="text"
              class="field-input"
              placeholder="e.g., Group by Node Type"
              data-testid="program-name-input"
            />
          </div>

          <div class="field-group">
            <label class="field-label">Description</label>
            <input v-model="description" type="text" class="field-input" placeholder="Optional description" />
          </div>

          <div class="field-group">
            <label class="checkbox-label">
              <input
                v-model="showInContextMenu"
                type="checkbox"
                data-testid="show-in-context-menu"
              />
              Show in node right-click menu
            </label>
            <span class="field-hint">
              Runs this program as a community algorithm on the clicked node.
              Parameters with a node binding take their value from that node.
            </span>
          </div>

          <div v-if="canChooseScope" class="field-group" data-testid="program-scope-group">
            <label class="field-label">Save to</label>
            <label class="radio-label">
              <input
                v-model="scope"
                type="radio"
                value="context"
                data-testid="program-scope-context"
              />
              Context (shared by all explorations)
            </label>
            <label class="radio-label">
              <input
                v-model="scope"
                type="radio"
                value="exploration"
                data-testid="program-scope-exploration"
              />
              This exploration only
            </label>
            <span class="field-hint">
              Context programs are saved immediately; exploration programs are
              saved with the exploration.
            </span>
          </div>

          <div class="field-group">
            <label class="field-label">
              JavaScript Code <span class="required-mark">*</span>
              <span class="field-hint">Reference parameters as <code>params.&lt;id&gt;</code></span>
            </label>
            <JavaScriptEditor
              v-model="code"
              placeholder="return [{ cluster_name: '...', node_ids: [...] }]"
            />
            <span class="field-hint">
              Must return an array of cluster objects with: cluster_name, node_ids, cluster_class
              (optional), figure (optional), state (optional), color (optional)
            </span>
          </div>

          <div class="params-section">
            <div class="params-header">
              <span class="field-label" style="margin: 0">Parameters</span>
              <button class="btn-add-param" data-testid="add-parameter" @click="addParameter">+ Add parameter</button>
            </div>

            <div v-if="parameters.length === 0" class="no-params-hint">
              No parameters — the program will run as-is.
            </div>

            <div v-for="(param, idx) in parameters" :key="idx" class="param-card">
              <div class="param-card-header">
                <span class="param-index">Parameter {{ idx + 1 }}</span>
                <button class="btn-icon-only btn-remove-param" @click="removeParameter(idx)" title="Remove"><X :size="14" /></button>
              </div>

              <div class="param-fields">
                <div class="param-row">
                  <div class="param-field">
                    <label class="param-field-label">ID <span class="required-mark">*</span></label>
                    <input
                      v-model="param.id"
                      type="text"
                      class="field-input"
                      :class="{ invalid: param.id.trim() !== '' && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(param.id.trim()) }"
                      placeholder="threshold"
                    />
                  </div>
                  <div class="param-field param-field--type">
                    <label class="param-field-label">Type</label>
                    <select v-model="param.type" class="field-input" @change="onTypeChange(idx)">
                      <option value="text">Text</option>
                      <option value="number">Number</option>
                      <option value="boolean">Boolean</option>
                      <option value="select">Dropdown</option>
                    </select>
                  </div>
                </div>

                <!-- Options (only for select type) -->
                <div v-if="param.type === 'select'" class="param-row">
                  <div class="param-field" style="flex: 1 1 100%">
                    <label class="param-field-label">Options <span class="required-mark">*</span> <span class="field-hint-sm">one per line</span></label>
                    <textarea
                      class="field-input options-textarea"
                      rows="3"
                      :value="getOptionsText(idx)"
                      @input="setOptionsText(idx, ($event.target as HTMLTextAreaElement).value)"
                      placeholder="option_a&#10;option_b&#10;option_c"
                    />
                  </div>
                </div>

                <div class="param-row">
                  <div v-if="param.type === 'text' || param.type === 'number'" class="param-field">
                    <label class="param-field-label">Placeholder</label>
                    <input v-model="param.placeholder" type="text" class="field-input" placeholder="(optional)" />
                  </div>
                  <div class="param-field">
                    <label class="param-field-label">Default value</label>
                    <input
                      v-if="param.type === 'number'"
                      v-model.number="param.default"
                      type="number"
                      class="field-input"
                      placeholder="(optional)"
                    />
                    <label v-else-if="param.type === 'boolean'" class="checkbox-label default-checkbox">
                      <input
                        type="checkbox"
                        :checked="Boolean(param.default)"
                        @change="param.default = ($event.target as HTMLInputElement).checked"
                      />
                      Enabled by default
                    </label>
                    <select v-else-if="param.type === 'select'" v-model="param.default" class="field-input">
                      <option value="">— none —</option>
                      <option v-for="opt in (param.options ?? [])" :key="opt" :value="opt">{{ opt }}</option>
                    </select>
                    <input v-else v-model="param.default" type="text" class="field-input" placeholder="(optional)" />
                  </div>
                </div>

                <div class="param-row">
                  <div class="param-field" style="flex: 1 1 100%">
                    <label class="param-field-label">Description</label>
                    <input v-model="param.description" type="text" class="field-input" placeholder="(optional)" />
                  </div>
                </div>

                <div class="param-row">
                  <div class="param-field">
                    <label class="param-field-label">
                      Node binding
                      <span class="field-hint-sm">value from the right-clicked node</span>
                    </label>
                    <select
                      class="field-input"
                      :value="getBindingKind(param)"
                      @change="setBindingKind(param, ($event.target as HTMLSelectElement).value as any)"
                    >
                      <option value="">None</option>
                      <option value="node_id">Node ID</option>
                      <option value="node_type">Node type</option>
                      <option value="prop">Property…</option>
                      <option value="metric">Metric… (session-computed)</option>
                    </select>
                  </div>
                  <div v-if="getBindingKind(param) === 'prop'" class="param-field">
                    <label class="param-field-label">Property name <span class="required-mark">*</span></label>
                    <input
                      type="text"
                      class="field-input"
                      :class="{ invalid: getBindingProp(param) === '' }"
                      :value="getBindingProp(param)"
                      @input="setBindingProp(param, ($event.target as HTMLInputElement).value)"
                      placeholder="e.g. id_simples"
                    />
                  </div>
                  <div v-if="getBindingKind(param) === 'metric'" class="param-field">
                    <label class="param-field-label">Metric name <span class="required-mark">*</span></label>
                    <input
                      type="text"
                      class="field-input"
                      :class="{ invalid: getBindingMetric(param) === '' }"
                      :value="getBindingMetric(param)"
                      list="cluster-binding-metrics"
                      @input="setBindingMetric(param, ($event.target as HTMLInputElement).value)"
                      placeholder="e.g. PageRank"
                    />
                    <datalist id="cluster-binding-metrics">
                      <option v-for="m in nodeMetricNames" :key="m" :value="m" />
                    </datalist>
                  </div>
                </div>

                <label v-if="param.type !== 'boolean'" class="checkbox-label">
                  <input v-model="param.required" type="checkbox" />
                  Required
                </label>
              </div>
            </div>
          </div>
        </div>

        <ClusterProgramSkillModal v-model="skillOpen" :program="promptProgram" />

        <div class="modal-footer">
          <div class="import-toolbar">
            <button
              type="button"
              class="btn btn-outline"
              :class="{ active: showImport }"
              data-testid="cluster-program-import-toggle"
              @click="toggleImport"
            >
              {{ isEditMode ? 'Edit as JSON' : 'Import JSON' }}
            </button>
            <button
              type="button"
              class="btn btn-outline"
              data-testid="cluster-program-export"
              :disabled="!isValid"
              title="Download this program as a JSON file you can import into another context"
              @click="exportProgram"
            >
              <Download :size="14" /> Export JSON
            </button>
            <button
              type="button"
              class="btn btn-outline btn-icon"
              data-testid="cluster-program-editor-ask-ai"
              :title="isEditMode ? 'Ask an AI to change this program' : 'Ask an AI to write this program'"
              :aria-label="isEditMode ? 'Ask an AI to change this program' : 'Ask an AI to write this program'"
              @click="skillOpen = true"
            >
              <Bot :size="14" />
            </button>
          </div>
          <span class="footer-spacer" />
          <button class="btn btn-outline" @click="emit('close')">Cancel</button>
          <button
            class="btn btn-primary"
            data-testid="save-program"
            :disabled="!isValid"
            @click="handleSave"
          >
            {{ isEditMode ? 'Save Changes' : 'Create Program' }}
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

.program-editor-modal {
  background: var(--card-background, #fff);
  border-radius: 12px;
  width: 640px;
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

.modal-close:hover {
  color: var(--text-color, #333);
}

.modal-body {
  padding: 20px 24px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-color, #333);
  display: flex;
  align-items: center;
  gap: 6px;
}

.field-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted, #888);
}

.field-hint code {
  background: var(--bg-secondary, #f0f0f0);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: 'Monaco', 'Menlo', monospace;
  color: var(--primary-color, #42b883);
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
  transition: border-color 0.15s;
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

.params-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.params-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.btn-add-param {
  background: none;
  border: 1px solid var(--primary-color, #42b883);
  color: var(--primary-color, #42b883);
  border-radius: 5px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-add-param:hover {
  background: var(--primary-color, #42b883);
  color: white;
}

.no-params-hint {
  font-size: 12px;
  color: var(--text-muted, #888);
}

.param-card {
  border: 1px solid var(--border-color, #ddd);
  border-radius: 8px;
  padding: 12px;
  background: var(--bg-secondary, #f8f8f8);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.param-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.param-index {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted, #999);
  text-transform: uppercase;
}

.btn-remove-param {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted, #999);
  line-height: 1;
  padding: 0 2px;
}

.btn-remove-param:hover {
  color: var(--error-color, #e74c3c);
}

.param-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.param-row {
  display: flex;
  gap: 10px;
}

.param-field {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.param-field--type {
  flex: 0 0 130px;
}

.param-field-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted, #888);
  text-transform: uppercase;
  display: flex;
  align-items: center;
  gap: 4px;
}

.field-hint-sm {
  font-size: 10px;
  font-weight: 400;
  color: var(--text-muted, #aaa);
  text-transform: none;
}

.options-textarea {
  font-family: 'Monaco', 'Menlo', monospace;
  font-size: 12px;
  resize: vertical;
}

.checkbox-label,
.radio-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-color, #333);
}

.radio-label + .radio-label {
  margin-top: 4px;
}

.default-checkbox {
  padding: 7px 0;
}

.import-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px dashed var(--border-color, #ddd);
  border-radius: 8px;
}

.import-textarea {
  font-family: 'Fira Code', 'Consolas', monospace;
  font-size: 12px;
  resize: vertical;
}

.import-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.file-input {
  display: none;
}

.field-error {
  font-size: 12px;
  color: var(--error-color, #e74c3c);
}

.import-toolbar {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.import-toolbar .btn.active {
  border-color: var(--primary-color, #42b883);
  color: var(--primary-color, #42b883);
}

.footer-spacer {
  flex: 1;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 16px 24px 20px;
  border-top: 1px solid var(--border-color, #ddd);
  flex-shrink: 0;
}

.btn {
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--border-color, #ddd);
  padding: 8px 16px;
  transition: all 0.15s;
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
