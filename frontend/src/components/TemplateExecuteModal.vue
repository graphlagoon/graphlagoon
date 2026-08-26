<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import type { LocationQueryRaw } from 'vue-router';
import { useGraphStore } from '@/stores/graph';
import { useQueryConsoleStore } from '@/stores/queryConsole';
import { useQueryTemplatesStore } from '@/stores/queryTemplates';
import { useDatasourceCapabilities } from '@/composables/useDatasourceCapabilities';
import { useTemplateExecution } from '@/composables/useTemplateExecution';
import { useToast } from '@/composables/useToast';
import { substituteTemplateParams } from '@/utils/templateSubstitution';
import { SAFE_VALUE_RE, TEMPLATE_PARAM_PREFIX } from '@/utils/templateUrlParams';
import type { QueryTemplate } from '@/types/graph';
import { X } from 'lucide-vue-next';

const props = defineProps<{
  template: QueryTemplate;
  /**
   * Pre-filled parameter values merged over the template defaults (used by
   * configurable context-menu actions, which bind node/edge properties to
   * parameters). The component remounts per open (parents gate it with
   * v-if), so seeding at setup is enough.
   */
  initialValues?: Record<string, string>;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const graphStore = useGraphStore();
const consoleStore = useQueryConsoleStore();
const templatesStore = useQueryTemplatesStore();
const router = useRouter();
const toast = useToast();
const { executeTemplateAsGraph } = useTemplateExecution();
const capabilities = useDatasourceCapabilities(
  computed(() => graphStore.currentContext),
);

// How to run this query THIS time — a per-execution choice, not stored on the
// template. Default: Graph (loads the visualization, the historical behavior).
const resultMode = ref<'graph' | 'table'>('graph');

// Build initial values: caller-provided value first, then the template's
// default, otherwise empty string
const values = ref<Record<string, string>>(
  Object.fromEntries(
    props.template.parameters.map((p) => [
      p.id,
      props.initialValues?.[p.id] || p.default || '',
    ]),
  ),
);

const missingRequired = computed(() =>
  props.template.parameters.filter(
    (p) => p.required && !values.value[p.id]?.trim(),
  ),
);

const canExecute = computed(() => missingRequired.value.length === 0);

const paramIds = computed(() => props.template.parameters.map((p) => p.id));

const queryPreview = computed(() =>
  substituteTemplateParams(props.template.query, paramIds.value, values.value),
);

async function executeNow() {
  if (!canExecute.value) return;

  // Table mode runs in the Query Console (arbitrary projection allowed),
  // NOT through the graph path (which assumes the query returns edges).
  if (resultMode.value === 'table') {
    const substituted = substituteTemplateParams(
      props.template.query,
      paramIds.value,
      values.value,
    );
    const opts = props.template.options;
    // A stored CTE pre-filter is SQL over the edge table. On a native-graph
    // context it cannot be honoured, and sending it would earn a 400 — drop it.
    const cte =
      opts?.cte_prefilter && capabilities.value.supportsCtePrefilter
        ? substituteTemplateParams(opts.cte_prefilter, paramIds.value, values.value)
        : '';
    graphStore.ctePrefilter = cte; // the console reads ctePrefilter from graphStore
    consoleStore.mode = props.template.query_type;
    if (props.template.query_type === 'cypher') consoleStore.cypherQuery = substituted;
    else consoleStore.sqlQuery = substituted;
    consoleStore.open();
    emit('close');
    await consoleStore.runQuery();
    return;
  }

  // Graph-intent (default): the shared execution path, same one a
  // `?template=` link runs through.
  emit('close');
  await executeTemplateAsGraph(props.template, values.value);
}

/**
 * Why this template, with these values, cannot be turned into a link.
 *
 * The modal itself stays permissive — anything can be typed and executed here.
 * But a link goes through the fail-closed URL parser at the other end, so
 * minting one that parser would reject helps nobody.
 */
const linkBlockedReason = computed<string | null>(() => {
  if (!graphStore.currentContext?.id) return 'No context loaded';
  if (props.template.options?.allow_url_execution === false) {
    return 'The author disabled running this template from a link';
  }
  if (missingRequired.value.length > 0) return 'Fill the required parameters first';
  const unsafe = props.template.parameters.filter((p) => {
    const value = values.value[p.id] ?? '';
    return value !== '' && !SAFE_VALUE_RE.test(value);
  });
  if (unsafe.length > 0) {
    return `These values can't travel in a link: ${unsafe.map((p) => p.label).join(', ')}`;
  }
  const sameName = templatesStore.templates.filter(
    (t) => t.name === props.template.name,
  );
  if (sameName.length > 1) {
    return `Another template is also named “${props.template.name}” — a link can't tell them apart`;
  }
  return null;
});

function templateUrl(): string {
  const query: LocationQueryRaw = { template: props.template.name };
  for (const p of props.template.parameters) {
    const value = values.value[p.id] ?? '';
    if (value.trim() !== '') query[`${TEMPLATE_PARAM_PREFIX}${p.id}`] = value;
  }
  const href = router.resolve({
    name: 'graph',
    params: { contextId: graphStore.currentContext?.id ?? '' },
    query,
  }).href;
  return new URL(href, window.location.origin).toString();
}

async function copyLink() {
  if (linkBlockedReason.value) return;
  try {
    await navigator.clipboard.writeText(templateUrl());
    toast.success('Link copied');
  } catch {
    toast.error('Could not copy the link');
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

          <!-- Run as: chosen at execution time, not stored on the template -->
          <div class="field-group">
            <label class="field-label">Run as</label>
            <div class="radio-group">
              <label class="radio-label">
                <input v-model="resultMode" type="radio" value="graph" /> Graph
              </label>
              <label class="radio-label">
                <input v-model="resultMode" type="radio" value="table" /> Table
              </label>
            </div>
            <span class="field-hint">
              Graph expects the query to return edges (<code>RETURN r</code>) and loads the
              visualization. Table shows any projection as rows in the Query Console.
            </span>
          </div>

          <!-- Fixed execution options (read-only badges) -->
          <div v-if="(resultMode === 'graph' && (template.options?.procedural_bfs || template.options?.large_results_mode)) || template.options?.cte_prefilter" class="options-badges">
            <span v-if="resultMode === 'graph' && template.options?.procedural_bfs" class="option-badge">Procedural BFS</span>
            <span v-if="resultMode === 'graph' && template.options?.large_results_mode" class="option-badge">Large results</span>
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
            <pre class="query-preview-text">{{ queryPreview }}</pre>
          </div>

          <div v-if="missingRequired.length > 0" class="validation-hint">
            Required: {{ missingRequired.map((p) => p.label).join(', ') }}
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn btn-outline" @click="emit('close')">Cancel</button>
          <button
            v-if="resultMode === 'graph'"
            class="btn btn-outline"
            data-testid="template-copy-link"
            :disabled="!!linkBlockedReason"
            :title="linkBlockedReason ?? 'Copy a link that runs this template with these values'"
            @click="copyLink"
          >
            Copy link
          </button>
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
