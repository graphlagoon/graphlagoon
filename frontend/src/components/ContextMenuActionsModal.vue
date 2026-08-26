<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay" @click.self="close">
      <div class="modal-container" data-testid="context-menu-actions-modal">
        <div class="modal-header">
          <h2>Context Menu Actions</h2>
          <div class="header-actions">
            <button
              class="btn-icon-only"
              data-testid="menu-action-skill-help"
              title="Ask an AI to write context-menu actions"
              aria-label="Ask an AI to write context-menu actions"
              @click="showSkill = true"
            >
              <Bot :size="16" />
            </button>
            <button class="btn-icon-only" @click="close" title="Close" aria-label="Close">
              <X :size="16" />
            </button>
          </div>
        </div>

        <div class="modal-content">
          <p v-if="!canEdit" class="readonly-note">
            You have read-only access to this context — actions are shown but cannot be edited.
          </p>

          <!-- Action list -->
          <div class="section">
            <div class="section-title">
              Configured actions ({{ store.actionConfigs.length }})
            </div>
            <p v-if="store.actionConfigs.length === 0" class="empty-note">
              No actions yet. Actions appear in the right-click menu of nodes and edges.
            </p>
            <div
              v-for="config in store.actionConfigs"
              :key="config.id"
              class="action-row"
              :data-testid="`menu-action-row-${config.id}`"
            >
              <label class="enable-toggle" :title="config.enabled ? 'Enabled' : 'Disabled'">
                <input
                  type="checkbox"
                  :checked="config.enabled"
                  :disabled="!canEdit"
                  @change="store.setEnabled(config.id, ($event.target as HTMLInputElement).checked)"
                />
              </label>
              <span class="action-icon">{{ config.icon || kindIconFallback(config.kind) }}</span>
              <span class="action-label" :title="actionSummary(config)">{{ config.label }}</span>
              <span class="kind-badge">{{ config.kind }}</span>
              <span class="target-badge">{{ config.match.target }}</span>
              <div class="row-buttons" v-if="canEdit">
                <button class="btn-small" @click="startEdit(config)">Edit</button>
                <button class="btn-small" @click="duplicate(config)">Duplicate</button>
                <button class="btn-small danger" @click="remove(config)">Delete</button>
              </div>
            </div>
            <div class="list-actions" v-if="canEdit">
              <button class="btn-primary" data-testid="menu-action-add" @click="startCreate">
                + New action
              </button>
              <button class="btn-secondary" @click="showImport = !showImport">
                Import JSON
              </button>
            </div>
          </div>

          <!-- Import JSON (Ask-AI return leg) -->
          <div v-if="showImport && canEdit" class="section import-section">
            <div class="section-title">Import JSON</div>
            <p class="hint">
              Paste the JSON array produced by the AI prompt (robot button above).
            </p>
            <textarea
              v-model="importText"
              class="import-textarea"
              data-testid="menu-action-import-text"
              rows="6"
              placeholder='[{"kind": "open-url", "label": "...", ...}]'
            />
            <p v-if="importError" class="field-error">{{ importError }}</p>
            <button class="btn-primary" data-testid="menu-action-import-apply" @click="applyImport">
              Add imported actions
            </button>
          </div>

          <!-- Editor form -->
          <div v-if="editing && canEdit" class="section form-section" data-testid="menu-action-form">
            <div class="section-title">{{ isNew ? 'New action' : 'Edit action' }}</div>

            <div class="form-grid">
              <label>Label</label>
              <input v-model="editing.label" type="text" placeholder="Search on PubMed" data-testid="menu-action-label" />

              <label>Icon (emoji)</label>
              <input v-model="editing.icon" type="text" maxlength="4" placeholder="🔎" class="icon-input" />

              <label>Kind</label>
              <select v-model="editing.kind" data-testid="menu-action-kind">
                <option value="open-url">Open URL</option>
                <option value="copy-text">Copy text</option>
                <option value="run-query-template">Run query template</option>
              </select>

              <label>Applies to</label>
              <select v-model="editing.match.target">
                <option value="node">Nodes</option>
                <option value="edge">Edges</option>
                <option value="both">Nodes and edges</option>
              </select>
            </div>

            <!-- Type filters -->
            <div v-if="editing.match.target !== 'edge'" class="type-filter">
              <div class="subsection-title">Node types (none checked = all)</div>
              <div class="type-checkboxes">
                <label v-for="t in nodeTypes" :key="t" class="type-checkbox">
                  <input type="checkbox" :value="t" v-model="editingNodeTypes" /> {{ t }}
                </label>
                <span v-if="nodeTypes.length === 0" class="hint">no node types loaded</span>
              </div>
            </div>
            <div v-if="editing.match.target !== 'node'" class="type-filter">
              <div class="subsection-title">Relationship types (none checked = all)</div>
              <div class="type-checkboxes">
                <label v-for="t in edgeTypes" :key="t" class="type-checkbox">
                  <input type="checkbox" :value="t" v-model="editingEdgeTypes" /> {{ t }}
                </label>
                <span v-if="edgeTypes.length === 0" class="hint">no edge types loaded</span>
              </div>
            </div>

            <!-- Property conditions -->
            <div class="conditions">
              <div class="subsection-title">
                Property conditions (all must hold)
                <button class="btn-small" @click="addCondition">+ condition</button>
              </div>
              <div v-for="(condition, i) in editingConditions" :key="i" class="condition-row">
                <input
                  v-model="condition.property"
                  type="text"
                  list="menu-action-properties"
                  placeholder="property"
                  class="condition-property"
                />
                <select v-model="condition.operator">
                  <option value="exists">exists</option>
                  <option value="not-empty">not empty</option>
                  <option value="equals">equals</option>
                  <option value="not-equals">not equals</option>
                  <option value="contains">contains</option>
                </select>
                <input
                  v-if="['equals', 'not-equals', 'contains'].includes(condition.operator)"
                  v-model="condition.value"
                  type="text"
                  placeholder="value"
                  class="condition-value"
                />
                <button class="btn-small danger" @click="editingConditions.splice(i, 1)">✕</button>
              </div>
              <datalist id="menu-action-properties">
                <option v-for="p in availableProperties" :key="p" :value="p" />
              </datalist>
            </div>

            <!-- Kind-specific fields -->
            <div v-if="editing.kind === 'open-url'" class="kind-fields">
              <label>URL template</label>
              <input
                v-model="editingUrlTemplate"
                type="text"
                data-testid="menu-action-url-template"
                placeholder="https://example.com/search?q={prop:name}"
              />
              <p class="hint">
                Must start with http:// or https://. Values are URL-encoded automatically.
                Available: {{ placeholderHint }}
              </p>
              <p v-if="urlTemplateError" class="field-error">{{ urlTemplateError }}</p>
              <div class="radio-row">
                <label><input type="radio" value="new-tab" v-model="editingOpenIn" /> New tab</label>
                <label><input type="radio" value="same-tab" v-model="editingOpenIn" /> Current tab</label>
              </div>
            </div>

            <div v-else-if="editing.kind === 'copy-text'" class="kind-fields">
              <label>Text template</label>
              <input
                v-model="editingTextTemplate"
                type="text"
                data-testid="menu-action-text-template"
                placeholder="{prop:name} <{prop:email}>"
              />
              <p class="hint">Available: {{ placeholderHint }}</p>
              <p v-if="textTemplateError" class="field-error">{{ textTemplateError }}</p>
            </div>

            <div v-else class="kind-fields">
              <label>Query template</label>
              <select v-model="editingTemplateId" data-testid="menu-action-template-select">
                <option value="" disabled>— select a template —</option>
                <option v-for="t in templatesStore.templates" :key="t.id" :value="t.id">
                  {{ t.name }}{{ t.visibility === 'private' ? ' (private)' : '' }}
                </option>
              </select>
              <p v-if="selectedTemplate?.visibility === 'private'" class="hint warning">
                This template is private: the action will be invisible to everyone
                who cannot see the template. Prefer a shared template.
              </p>
              <div v-if="selectedTemplate" class="bindings">
                <div class="subsection-title">Parameter bindings</div>
                <div
                  v-for="parameter in selectedTemplate.parameters"
                  :key="parameter.id"
                  class="binding-row"
                >
                  <span class="binding-param">
                    {{ parameter.id }}<span v-if="parameter.required" class="required">*</span>
                  </span>
                  <input
                    v-model="editingBindings[parameter.id]"
                    type="text"
                    :placeholder="`{prop:...} — empty: ${parameter.required ? 'asks at run time' : 'uses default'}`"
                  />
                </div>
                <p v-if="selectedTemplate.parameters.length === 0" class="hint">
                  This template has no parameters.
                </p>
              </div>
            </div>

            <div class="form-buttons">
              <button
                class="btn-primary"
                data-testid="menu-action-save"
                :disabled="!formValid"
                @click="save"
              >
                {{ isNew ? 'Add action' : 'Save changes' }}
              </button>
              <button class="btn-secondary" @click="editing = null">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <ContextMenuActionSkillModal v-model="showSkill" />
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { X, Bot } from 'lucide-vue-next';
import { useGraphStore } from '@/stores/graph';
import { useQueryTemplatesStore } from '@/stores/queryTemplates';
import { useContextMenuActionsStore } from '@/stores/contextMenuActions';
import { useToast } from '@/composables/useToast';
import { validateTemplate } from '@/utils/labelFormatter';
import { validateUrlTemplate } from '@/utils/safeUrl';
import { parseImportedActionConfigs } from '@/utils/contextMenuActionImport';
import ContextMenuActionSkillModal from './ContextMenuActionSkillModal.vue';
import type {
  ContextMenuActionConfig,
  PropertyCondition,
  MenuActionTarget,
} from '@/types/contextMenuActions';

defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>();

const graphStore = useGraphStore();
const templatesStore = useQueryTemplatesStore();
const store = useContextMenuActionsStore();
const { success } = useToast();

const canEdit = computed(() => graphStore.currentContext?.has_write_access === true);
const nodeTypes = computed(() => graphStore.currentContext?.node_types ?? []);
const edgeTypes = computed(() => graphStore.currentContext?.relationship_types ?? []);

const availableProperties = computed(() => {
  const names = new Set<string>();
  for (const p of graphStore.currentContext?.node_properties ?? []) names.add(p.name);
  for (const p of graphStore.currentContext?.edge_properties ?? []) names.add(p.name);
  return [...names];
});

const placeholderHint = computed(() => {
  const props = availableProperties.value.slice(0, 6).map((p) => `{prop:${p}}`);
  return ['{node_id}', ...props].join(' ') + (availableProperties.value.length > 6 ? ' …' : '');
});

// ---------------------------------------------------------------------------
// Editing state — a mutable draft separate from the store until Save.
// ---------------------------------------------------------------------------

interface Draft {
  id: string;
  label: string;
  icon: string;
  enabled: boolean;
  kind: ContextMenuActionConfig['kind'];
  match: { target: MenuActionTarget };
}

const editing = ref<Draft | null>(null);
const isNew = ref(false);
const editingNodeTypes = ref<string[]>([]);
const editingEdgeTypes = ref<string[]>([]);
const editingConditions = ref<PropertyCondition[]>([]);
const editingUrlTemplate = ref('');
const editingOpenIn = ref<'new-tab' | 'same-tab'>('new-tab');
const editingTextTemplate = ref('');
const editingTemplateId = ref('');
const editingBindings = ref<Record<string, string>>({});

const selectedTemplate = computed(() =>
  templatesStore.templates.find((t) => t.id === editingTemplateId.value),
);

// Keep the bindings map aligned with the selected template's parameters.
watch(selectedTemplate, (template) => {
  if (!template) return;
  const next: Record<string, string> = {};
  for (const parameter of template.parameters) {
    next[parameter.id] = editingBindings.value[parameter.id] ?? '';
  }
  editingBindings.value = next;
});

const urlTemplateError = computed(() => {
  if (editing.value?.kind !== 'open-url' || !editingUrlTemplate.value) return null;
  const prefixError = validateUrlTemplate(editingUrlTemplate.value);
  if (prefixError) return prefixError;
  const validation = validateTemplate(editingUrlTemplate.value);
  return validation.valid ? null : validation.errors[0];
});

const textTemplateError = computed(() => {
  if (editing.value?.kind !== 'copy-text' || !editingTextTemplate.value) return null;
  const validation = validateTemplate(editingTextTemplate.value);
  return validation.valid ? null : validation.errors[0];
});

const formValid = computed(() => {
  const draft = editing.value;
  if (!draft || draft.label.trim() === '') return false;
  if (draft.kind === 'open-url') {
    return editingUrlTemplate.value.trim() !== '' && !urlTemplateError.value;
  }
  if (draft.kind === 'copy-text') {
    return editingTextTemplate.value.trim() !== '' && !textTemplateError.value;
  }
  return editingTemplateId.value !== '';
});

function kindIconFallback(kind: ContextMenuActionConfig['kind']): string {
  return kind === 'open-url' ? '🔗' : kind === 'copy-text' ? '📋' : '▶';
}

function actionSummary(config: ContextMenuActionConfig): string {
  if (config.kind === 'open-url') return config.urlTemplate;
  if (config.kind === 'copy-text') return config.textTemplate;
  return config.templateName || config.templateId;
}

function startCreate() {
  isNew.value = true;
  editing.value = {
    id: crypto.randomUUID(),
    label: '',
    icon: '',
    enabled: true,
    kind: 'open-url',
    match: { target: 'node' },
  };
  editingNodeTypes.value = [];
  editingEdgeTypes.value = [];
  editingConditions.value = [];
  editingUrlTemplate.value = '';
  editingOpenIn.value = 'new-tab';
  editingTextTemplate.value = '';
  editingTemplateId.value = '';
  editingBindings.value = {};
}

function startEdit(config: ContextMenuActionConfig) {
  isNew.value = false;
  editing.value = {
    id: config.id,
    label: config.label,
    icon: config.icon ?? '',
    enabled: config.enabled,
    kind: config.kind,
    match: { target: config.match.target },
  };
  editingNodeTypes.value = [...(config.match.nodeTypes ?? [])];
  editingEdgeTypes.value = [...(config.match.relationshipTypes ?? [])];
  editingConditions.value = (config.match.propertyConditions ?? []).map((c) => ({ ...c }));
  editingUrlTemplate.value = config.kind === 'open-url' ? config.urlTemplate : '';
  editingOpenIn.value = config.kind === 'open-url' ? config.openIn : 'new-tab';
  editingTextTemplate.value = config.kind === 'copy-text' ? config.textTemplate : '';
  editingTemplateId.value = config.kind === 'run-query-template' ? config.templateId : '';
  editingBindings.value =
    config.kind === 'run-query-template' ? { ...config.paramBindings } : {};
}

function addCondition() {
  editingConditions.value.push({ property: '', operator: 'not-empty' });
}

function buildConfig(): ContextMenuActionConfig | null {
  const draft = editing.value;
  if (!draft) return null;
  const base = {
    id: draft.id,
    label: draft.label.trim(),
    icon: draft.icon.trim() || undefined,
    enabled: draft.enabled,
    match: {
      target: draft.match.target,
      nodeTypes: editingNodeTypes.value.length > 0 ? [...editingNodeTypes.value] : undefined,
      relationshipTypes:
        editingEdgeTypes.value.length > 0 ? [...editingEdgeTypes.value] : undefined,
      propertyConditions:
        editingConditions.value.filter((c) => c.property.trim() !== '').length > 0
          ? editingConditions.value
              .filter((c) => c.property.trim() !== '')
              .map((c) => ({ ...c, property: c.property.trim() }))
          : undefined,
    },
  };
  if (draft.kind === 'open-url') {
    return {
      ...base,
      kind: 'open-url',
      urlTemplate: editingUrlTemplate.value.trim(),
      openIn: editingOpenIn.value,
    };
  }
  if (draft.kind === 'copy-text') {
    return { ...base, kind: 'copy-text', textTemplate: editingTextTemplate.value };
  }
  return {
    ...base,
    kind: 'run-query-template',
    templateId: editingTemplateId.value,
    templateName: selectedTemplate.value?.name,
    paramBindings: Object.fromEntries(
      Object.entries(editingBindings.value).filter(([, v]) => v.trim() !== ''),
    ),
  };
}

function save() {
  const config = buildConfig();
  if (!config) return;
  if (isNew.value) store.addConfig(config);
  else store.updateConfig(config);
  editing.value = null;
  success(isNew.value ? 'Action added' : 'Action updated');
}

function duplicate(config: ContextMenuActionConfig) {
  store.addConfig({
    ...JSON.parse(JSON.stringify(config)),
    id: crypto.randomUUID(),
    label: `${config.label} (copy)`,
  });
}

function remove(config: ContextMenuActionConfig) {
  store.removeConfig(config.id);
  if (editing.value?.id === config.id) editing.value = null;
}

// ---------------------------------------------------------------------------
// Import JSON (Ask-AI return leg)
// ---------------------------------------------------------------------------

const showImport = ref(false);
const importText = ref('');
const importError = ref<string | null>(null);

function applyImport() {
  importError.value = null;
  const result = parseImportedActionConfigs(importText.value);
  if (!result.ok) {
    importError.value = result.error;
    return;
  }
  for (const config of result.configs) {
    store.addConfig(config);
  }
  importText.value = '';
  showImport.value = false;
  success(`Imported ${result.configs.length} action${result.configs.length > 1 ? 's' : ''}`);
}

const showSkill = ref(false);

function close() {
  editing.value = null;
  emit('update:modelValue', false);
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.modal-container {
  background: var(--vt-c-bg, #ffffff);
  border-radius: 12px;
  width: 90%;
  max-width: 760px;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid var(--vt-c-divider, #e0e0e0);
}

.modal-header h2 {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--vt-c-text-1, #222);
}

.header-actions {
  display: flex;
  gap: 6px;
}

.btn-icon-only {
  background: none;
  border: none;
  color: var(--vt-c-text-2, #888);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  border-radius: 4px;
}

.btn-icon-only:hover {
  background: var(--vt-c-bg-soft, #f0f0f0);
  color: var(--vt-c-text-1, #222);
}

.modal-content {
  padding: 16px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.readonly-note {
  margin: 0;
  padding: 8px 12px;
  background: var(--vt-c-bg-soft, #f6f6f6);
  border-radius: 6px;
  font-size: 0.85rem;
  color: var(--vt-c-text-2, #555);
}

.section-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--vt-c-text-1, #222);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.subsection-title {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--vt-c-text-2, #555);
  margin: 10px 0 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.empty-note,
.hint {
  font-size: 0.8rem;
  color: var(--vt-c-text-2, #777);
  margin: 4px 0;
}

.hint.warning {
  color: #b45309;
}

.action-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--vt-c-divider, #e5e5e5);
  border-radius: 6px;
  margin-bottom: 6px;
  font-size: 0.85rem;
}

.action-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--vt-c-text-1, #222);
}

.kind-badge,
.target-badge {
  font-size: 0.7rem;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--vt-c-bg-soft, #f0f0f0);
  color: var(--vt-c-text-2, #666);
  white-space: nowrap;
}

.row-buttons {
  display: flex;
  gap: 4px;
}

.btn-small {
  font-size: 0.72rem;
  padding: 3px 8px;
  border: 1px solid var(--vt-c-divider, #ddd);
  background: var(--vt-c-bg, #fff);
  color: var(--vt-c-text-1, #333);
  border-radius: 4px;
  cursor: pointer;
}

.btn-small.danger {
  color: #c0392b;
}

.list-actions,
.form-buttons {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.btn-primary {
  background: var(--color-primary, #42b883);
  color: #fff;
  border: none;
  padding: 7px 14px;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: var(--vt-c-bg-soft, #f0f0f0);
  color: var(--vt-c-text-1, #333);
  border: 1px solid var(--vt-c-divider, #ddd);
  padding: 7px 14px;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
}

.form-section {
  border: 1px solid var(--vt-c-divider, #e0e0e0);
  border-radius: 8px;
  padding: 14px;
}

.form-grid {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 8px 10px;
  align-items: center;
  font-size: 0.85rem;
}

.form-grid label {
  color: var(--vt-c-text-2, #555);
}

.form-grid input,
.form-grid select,
.kind-fields input,
.kind-fields select,
.condition-row input,
.condition-row select,
.binding-row input,
.import-textarea {
  padding: 6px 8px;
  border: 1px solid var(--vt-c-divider, #ddd);
  border-radius: 4px;
  font-size: 0.85rem;
  background: var(--vt-c-bg, #fff);
  color: var(--vt-c-text-1, #222);
  width: 100%;
  box-sizing: border-box;
}

.icon-input {
  max-width: 80px;
}

.type-filter {
  margin-top: 8px;
}

.type-checkboxes {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 0.82rem;
}

.type-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--vt-c-text-1, #333);
}

.condition-row {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
  align-items: center;
}

.condition-property {
  flex: 1;
}

.condition-value {
  flex: 1;
}

.kind-fields {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.85rem;
}

.kind-fields > label {
  color: var(--vt-c-text-2, #555);
}

.radio-row {
  display: flex;
  gap: 18px;
}

.radio-row label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.binding-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.binding-param {
  min-width: 110px;
  font-family: monospace;
  font-size: 0.8rem;
}

.required {
  color: #c0392b;
}

.field-error {
  color: #c0392b;
  font-size: 0.78rem;
  margin: 2px 0;
}

.import-section {
  border: 1px dashed var(--vt-c-divider, #ccc);
  border-radius: 8px;
  padding: 12px;
}

.import-textarea {
  font-family: monospace;
  resize: vertical;
}
</style>
