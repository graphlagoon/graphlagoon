<script setup lang="ts">
import { ref, computed } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useQueryTemplatesStore } from '@/stores/queryTemplates';
import type { QueryTemplate, TemplateParameter } from '@/types/graph';
import { X } from 'lucide-vue-next';

const props = defineProps<{
  template: QueryTemplate | null;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const graphStore = useGraphStore();
const templatesStore = useQueryTemplatesStore();

const isEditMode = computed(() => props.template !== null);

const DEFAULT_QUERY = `MATCH (root { node_id: "$node_id" })
MATCH p = (root)-[*1..$depth]-()
UNWIND relationships(p) AS r
RETURN r`;

const DEFAULT_PARAMETERS: TemplateParameter[] = [
  { id: 'node_id', type: 'input', label: 'node_id', placeholder: 'e.g. a1738368-...', default: undefined, options: undefined, required: true },
  { id: 'depth', type: 'input', label: 'depth', placeholder: 'e.g. 3', default: '2', options: undefined, required: true },
];

const name = ref(props.template?.name ?? '');
const description = ref(props.template?.description ?? '');
const queryType = ref<'cypher' | 'sql'>(props.template?.query_type ?? 'cypher');
const query = ref(props.template?.query ?? DEFAULT_QUERY);
const parameters = ref<TemplateParameter[]>(
  props.template?.parameters.map((p) => ({ ...p })) ?? DEFAULT_PARAMETERS.map((p) => ({ ...p })),
);

// Execution options (fixed after template creation, not shown when using template)
const proceduralBfs = ref(props.template?.options?.procedural_bfs ?? true);
const ctePrefilterEnabled = ref(!!(props.template?.options?.cte_prefilter));
const ctePrefilterText = ref(props.template?.options?.cte_prefilter ?? '');
const largeResultsMode = ref(props.template?.options?.large_results_mode ?? true);

const saving = ref(false);
const errorMsg = ref<string | null>(null);

const isValid = computed(
  () =>
    name.value.trim().length > 0 &&
    query.value.trim().length > 0 &&
    parameters.value.every((p) => p.id.trim()),
);

function addParameter() {
  parameters.value.push({
    id: '',
    type: 'input',
    label: '',
    description: undefined,
    placeholder: undefined,
    default: undefined,
    options: undefined,
    required: true,
  });
}

// Raw textarea string for select options (one per line), keyed by param index
const optionsText = ref<Record<number, string>>({});

function getOptionsText(idx: number): string {
  if (optionsText.value[idx] !== undefined) return optionsText.value[idx];
  return (parameters.value[idx].options ?? []).join('\n');
}

function setOptionsText(idx: number, val: string) {
  optionsText.value[idx] = val;
  parameters.value[idx].options = val
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function onTypeChange(idx: number) {
  const p = parameters.value[idx];
  if (p.type === 'select') {
    if (!p.options) p.options = [];
    optionsText.value[idx] = p.options.join('\n');
  } else {
    p.options = undefined;
    delete optionsText.value[idx];
  }
}

function removeParameter(idx: number) {
  parameters.value.splice(idx, 1);
}

function handleTab(event: KeyboardEvent) {
  const el = event.target as HTMLTextAreaElement;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  query.value = query.value.substring(0, start) + '  ' + query.value.substring(end);
  requestAnimationFrame(() => {
    el.selectionStart = el.selectionEnd = start + 2;
  });
}

async function handleSave() {
  if (!isValid.value || !graphStore.currentContext) return;

  saving.value = true;
  errorMsg.value = null;
  try {
    const payload = {
      name: name.value.trim(),
      description: description.value.trim() || undefined,
      query_type: queryType.value,
      query: query.value.trim(),
      parameters: parameters.value.map((p) => ({
        ...p,
        id: p.id.trim(),
        label: p.id.trim(),
      })),
      options: {
        procedural_bfs: proceduralBfs.value,
        cte_prefilter: ctePrefilterEnabled.value ? ctePrefilterText.value.trim() || undefined : undefined,
        large_results_mode: largeResultsMode.value,
      },
    };

    if (isEditMode.value && props.template) {
      await templatesStore.updateTemplate(graphStore.currentContext.id, props.template.id, payload);
    } else {
      await templatesStore.createTemplate(graphStore.currentContext.id, payload);
    }
    emit('close');
  } catch (e) {
    errorMsg.value = 'Failed to save template. Please try again.';
    console.error('Failed to save template:', e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal template-editor-modal">
        <div class="modal-header">
          <h2>{{ isEditMode ? 'Edit Template' : 'New Template' }}</h2>
          <button class="modal-close" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
        </div>

        <div class="modal-body">
          <div class="field-group">
            <label class="field-label">Name <span class="required-mark">*</span></label>
            <input v-model="name" type="text" class="field-input" placeholder="e.g. BFS from node" />
          </div>

          <div class="field-group">
            <label class="field-label">Description</label>
            <input v-model="description" type="text" class="field-input" placeholder="What this template does" />
          </div>

          <div class="field-group">
            <label class="field-label">Query type <span class="required-mark">*</span></label>
            <div class="radio-group">
              <label class="radio-label">
                <input v-model="queryType" type="radio" value="cypher" /> Cypher
              </label>
              <label class="radio-label">
                <input v-model="queryType" type="radio" value="sql" /> SQL
              </label>
            </div>
          </div>

          <div class="field-group">
            <label class="field-label">
              Query <span class="required-mark">*</span>
              <span class="field-hint">Use <code>$param_id</code> to reference parameters</span>
            </label>
            <textarea
              v-model="query"
              class="query-editor"
              spellcheck="false"
              rows="8"
              @keydown.tab.prevent="handleTab"
            />
          </div>

          <!-- Execution options (fixed after creation) -->
          <div class="execution-options">
            <span class="field-label" style="margin-bottom: 4px">Execution Options</span>
            <span class="field-hint" style="display: block; margin-bottom: 8px">
              These options are fixed after creation and applied automatically when running the template.
            </span>

            <label class="checkbox-label">
              <input v-model="proceduralBfs" type="checkbox" />
              Procedural BFS
              <span class="option-hint">(temp tables instead of WITH RECURSIVE)</span>
            </label>

            <label class="checkbox-label">
              <input v-model="largeResultsMode" type="checkbox" />
              Large results mode
              <span class="option-hint">(use external links for large datasets)</span>
            </label>

            <label class="checkbox-label">
              <input v-model="ctePrefilterEnabled" type="checkbox" />
              Pre-filter edges (CTE)
            </label>

            <div v-if="ctePrefilterEnabled" class="cte-editor">
              <p class="cte-hint">
                Define <code>MY_FINAL_EDGES</code> using <code>__EDGES__</code> as source table.
              </p>
              <textarea
                v-model="ctePrefilterText"
                rows="4"
                class="cte-textarea"
                spellcheck="false"
                placeholder="MY_FINAL_EDGES AS (&#10;  SELECT * FROM __EDGES__&#10;  WHERE relationship_type = 'KNOWS'&#10;)"
              />
            </div>
          </div>

          <div class="params-section">
            <div class="params-header">
              <span class="field-label" style="margin: 0">Parameters</span>
              <button class="btn-add-param" @click="addParameter">+ Add parameter</button>
            </div>

            <div v-if="parameters.length === 0" class="no-params-hint">
              No parameters — the query will run as-is.
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
                    <input v-model="param.id" type="text" class="field-input" placeholder="node_id" />
                  </div>
                  <div class="param-field param-field--type">
                    <label class="param-field-label">Type</label>
                    <select v-model="param.type" class="field-input" @change="onTypeChange(idx)">
                      <option value="input">Text input</option>
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
                  <div class="param-field">
                    <label class="param-field-label">{{ param.type === 'select' ? 'Default option' : 'Placeholder' }}</label>
                    <input
                      v-if="param.type === 'input'"
                      v-model="param.placeholder"
                      type="text"
                      class="field-input"
                      placeholder="(optional)"
                    />
                    <select v-else v-model="param.default" class="field-input">
                      <option value="">— none —</option>
                      <option v-for="opt in (param.options ?? [])" :key="opt" :value="opt">{{ opt }}</option>
                    </select>
                  </div>
                  <div v-if="param.type === 'input'" class="param-field">
                    <label class="param-field-label">Default value</label>
                    <input v-model="param.default" type="text" class="field-input" placeholder="(optional)" />
                  </div>
                </div>

                <div class="param-row">
                  <div class="param-field" style="flex: 1 1 100%">
                    <label class="param-field-label">Description</label>
                    <input v-model="param.description" type="text" class="field-input" placeholder="(optional)" />
                  </div>
                </div>

                <label class="checkbox-label">
                  <input v-model="param.required" type="checkbox" />
                  Required
                </label>
              </div>
            </div>
          </div>

          <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>
        </div>

        <div class="modal-footer">
          <button class="btn btn-outline" @click="emit('close')" :disabled="saving">Cancel</button>
          <button class="btn btn-primary" @click="handleSave" :disabled="!isValid || saving">
            {{ saving ? 'Saving...' : (isEditMode ? 'Save Changes' : 'Create Template') }}
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

.template-editor-modal {
  background: var(--card-background, #fff);
  border-radius: 12px;
  width: 600px;
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
  font-size: 22px;
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

.radio-group {
  display: flex;
  gap: 16px;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-color, #333);
}

.query-editor {
  width: 100%;
  box-sizing: border-box;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
  line-height: 1.6;
  padding: 10px 12px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  background: var(--bg-color, #fafafa);
  color: var(--text-color, #333);
  outline: none;
  resize: vertical;
  transition: border-color 0.15s;
}

.query-editor:focus {
  border-color: var(--primary-color, #42b883);
  box-shadow: 0 0 0 2px rgba(66, 184, 131, 0.2);
}

.execution-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 8px;
  background: var(--bg-secondary, #f8f8f8);
}

.option-hint {
  font-size: 11px;
  color: var(--text-muted, #888);
}

.cte-editor {
  margin-top: 4px;
  margin-left: 22px;
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
  font-family: 'Monaco', 'Menlo', monospace;
}

.cte-textarea {
  width: 100%;
  box-sizing: border-box;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
  line-height: 1.5;
  padding: 8px 10px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  background: var(--bg-color, #fafafa);
  color: var(--text-color, #333);
  outline: none;
  resize: vertical;
}

.cte-textarea:focus {
  border-color: var(--primary-color, #42b883);
  box-shadow: 0 0 0 2px rgba(66, 184, 131, 0.2);
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
  font-size: 18px;
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

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-color, #333);
}

.error-msg {
  padding: 8px 12px;
  background: rgba(231, 76, 60, 0.1);
  border: 1px solid var(--error-color, #e74c3c);
  border-radius: 6px;
  color: var(--error-color, #e74c3c);
  font-size: 12px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
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
