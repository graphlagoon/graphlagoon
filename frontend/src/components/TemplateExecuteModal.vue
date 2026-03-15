<script setup lang="ts">
import { ref, computed } from 'vue';
import { useGraphStore } from '@/stores/graph';
import type { QueryTemplate } from '@/types/graph';
import { X } from 'lucide-vue-next';

const props = defineProps<{
  template: QueryTemplate;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const graphStore = useGraphStore();

// Build initial values: use default if provided, otherwise empty string
const values = ref<Record<string, string>>(
  Object.fromEntries(
    props.template.parameters.map((p) => [p.id, p.default ?? '']),
  ),
);

const missingRequired = computed(() =>
  props.template.parameters.filter(
    (p) => p.required && !values.value[p.id]?.trim(),
  ),
);

const canExecute = computed(() => missingRequired.value.length === 0);

function substituteParameters(queryTemplate: string, vals: Record<string, string>): string {
  let result = queryTemplate;
  for (const [paramId, value] of Object.entries(vals)) {
    result = result.split(`$${paramId}`).join(value);
  }
  return result;
}

async function executeNow() {
  if (!canExecute.value) return;
  const substituted = substituteParameters(props.template.query, values.value);
  graphStore.setGraphQuery(substituted);
  emit('close');

  // Apply template execution options (substitute parameters in cte_prefilter too)
  const opts = props.template.options;
  graphStore.vlpRenderingMode = opts?.procedural_bfs ? 'procedural' : 'cte';
  graphStore.ctePrefilter = opts?.cte_prefilter
    ? substituteParameters(opts.cte_prefilter, values.value)
    : '';
  graphStore.useExternalLinks = opts?.large_results_mode ?? true;

  if (props.template.query_type === 'cypher') {
    const sql = await graphStore.transpileCypher(substituted);
    if (sql) {
      await graphStore.executeGraphQuery(sql, { preserveGraphQuery: true });
    }
  } else {
    await graphStore.executeGraphQuery(substituted, { preserveGraphQuery: true });
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal execute-modal">
        <div class="modal-header">
          <div class="modal-title-block">
            <h2>{{ template.name }}</h2>
            <span class="badge" :class="template.query_type">{{ template.query_type.toUpperCase() }}</span>
          </div>
          <button class="modal-close" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
        </div>

        <div class="modal-body">
          <p v-if="template.description" class="template-desc">{{ template.description }}</p>

          <!-- Fixed execution options (read-only badges) -->
          <div v-if="template.options?.procedural_bfs || template.options?.large_results_mode || template.options?.cte_prefilter" class="options-badges">
            <span v-if="template.options?.procedural_bfs" class="option-badge">Procedural BFS</span>
            <span v-if="template.options?.large_results_mode" class="option-badge">Large results</span>
            <span v-if="template.options?.cte_prefilter" class="option-badge">CTE pre-filter</span>
          </div>

          <!-- Parameter inputs -->
          <div v-if="template.parameters.length > 0" class="params-section">
            <div v-for="param in template.parameters" :key="param.id" class="param-group">
              <label :for="`param-${param.id}`" class="param-label">
                {{ param.label }}
                <span v-if="param.required" class="required-mark">*</span>
              </label>
              <p v-if="param.description" class="param-desc">{{ param.description }}</p>
              <select
                v-if="param.type === 'select'"
                :id="`param-${param.id}`"
                v-model="values[param.id]"
                class="param-input"
                :class="{ 'missing': param.required && !values[param.id] }"
              >
                <option value="">— choose —</option>
                <option v-for="opt in (param.options ?? [])" :key="opt" :value="opt">{{ opt }}</option>
              </select>
              <input
                v-else
                :id="`param-${param.id}`"
                v-model="values[param.id]"
                type="text"
                class="param-input"
                :placeholder="param.placeholder || `Enter ${param.label.toLowerCase()}...`"
                :class="{ 'missing': param.required && !values[param.id]?.trim() }"
              />
            </div>
          </div>

          <div v-else class="no-params">
            <p>This template has no parameters. It will be loaded as-is.</p>
          </div>

          <!-- Query preview -->
          <div class="query-preview">
            <div class="preview-label">Query Preview</div>
            <pre class="query-preview-text">{{ substituteParameters(template.query, values) }}</pre>
          </div>

          <div v-if="missingRequired.length > 0" class="validation-hint">
            Required: {{ missingRequired.map((p) => p.label).join(', ') }}
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn btn-outline" @click="emit('close')">Cancel</button>
          <button
            class="btn btn-primary"
            @click="executeNow"
            :disabled="!canExecute"
          >
            Execute
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

.execute-modal {
  background: var(--card-background, #fff);
  border-radius: 12px;
  width: 520px;
  max-width: 95vw;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--border-color, #ddd);
}

.modal-title-block {
  display: flex;
  align-items: center;
  gap: 10px;
}

.modal-header h2 {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
}

.badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 4px;
}

.badge.cypher {
  background: #e8f5e9;
  color: #2e7d32;
}

.badge.sql {
  background: #e3f2fd;
  color: #1565c0;
}

.modal-close {
  background: none;
  border: none;
  font-size: 22px;
  cursor: pointer;
  color: var(--text-muted, #666);
  line-height: 1;
  padding: 0 4px;
  flex-shrink: 0;
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
  gap: 16px;
}

.options-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.option-badge {
  font-size: 10px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--bg-secondary, #f0f0f0);
  color: var(--text-muted, #666);
  border: 1px solid var(--border-color, #ddd);
}

.template-desc {
  font-size: 13px;
  color: var(--text-muted, #666);
  margin: 0;
  line-height: 1.5;
}

.params-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.param-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.param-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-color, #333);
}

.required-mark {
  color: var(--error-color, #e74c3c);
  margin-left: 2px;
}

.param-desc {
  font-size: 11px;
  color: var(--text-muted, #888);
  margin: 0;
}

.param-input {
  padding: 8px 12px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  font-size: 13px;
  background: var(--bg-color, #fafafa);
  color: var(--text-color, #333);
  outline: none;
  transition: border-color 0.15s;
}

.param-input:focus {
  border-color: var(--primary-color, #42b883);
  box-shadow: 0 0 0 2px rgba(66, 184, 131, 0.2);
}

.param-input.missing {
  border-color: var(--error-color, #e74c3c);
}

.no-params {
  font-size: 13px;
  color: var(--text-muted, #666);
}

.no-params p {
  margin: 0;
}

.query-preview {
  background: var(--bg-secondary, #f5f5f5);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.preview-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-muted, #888);
}

.query-preview-text {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 11px;
  line-height: 1.5;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-color, #333);
}

.validation-hint {
  font-size: 12px;
  color: var(--error-color, #e74c3c);
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 24px 20px;
  border-top: 1px solid var(--border-color, #ddd);
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
