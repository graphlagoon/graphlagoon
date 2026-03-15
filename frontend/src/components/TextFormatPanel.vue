<template>
  <div class="text-format-panel">
    <div class="panel-header">
      <h3>Labels</h3>
      <div class="header-actions">
        <button class="btn-icon-only" @click="showHelp = true" title="Help"><HelpCircle :size="16" /></button>
        <button class="btn-icon-only close-btn" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <!-- Default Templates -->
    <div class="section">
      <div class="section-title">Default Templates</div>

      <div class="default-template">
        <label>Node Label</label>
        <div class="template-input-wrapper">
          <input
            v-model="nodeDefaultTemplate"
            type="text"
            placeholder="{node_id}"
            class="template-input"
            @focus="activeInput = 'nodeDefault'"
            @input="handleTemplateInput($event, 'nodeDefault')"
            @keydown="handleKeydown($event, 'nodeDefault')"
            @blur="handleBlur"
            ref="nodeDefaultInput"
          />
          <div v-if="activeInput === 'nodeDefault' && suggestions.length > 0" class="suggestions-dropdown">
            <div
              v-for="(suggestion, idx) in suggestions"
              :key="idx"
              :class="['suggestion-item', { active: selectedSuggestionIndex === idx }]"
              @mousedown.prevent="insertSuggestion(suggestion, 'nodeDefault')"
            >
              <code>{{ suggestion.placeholder }}</code>
              <span class="suggestion-desc">{{ suggestion.description }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="default-template">
        <label>Edge Label</label>
        <div class="template-input-wrapper">
          <input
            v-model="edgeDefaultTemplate"
            type="text"
            placeholder="{relationship_type}"
            class="template-input"
            @focus="activeInput = 'edgeDefault'"
            @input="handleTemplateInput($event, 'edgeDefault')"
            @keydown="handleKeydown($event, 'edgeDefault')"
            @blur="handleBlur"
            ref="edgeDefaultInput"
          />
          <div v-if="activeInput === 'edgeDefault' && suggestions.length > 0" class="suggestions-dropdown">
            <div
              v-for="(suggestion, idx) in suggestions"
              :key="idx"
              :class="['suggestion-item', { active: selectedSuggestionIndex === idx }]"
              @mousedown.prevent="insertSuggestion(suggestion, 'edgeDefault')"
            >
              <code>{{ suggestion.placeholder }}</code>
              <span class="suggestion-desc">{{ suggestion.description }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Custom Rules -->
    <div class="section">
      <div class="section-title">
        Custom Rules
        <button class="add-rule-btn" @click="startAddRule" title="Add Rule">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>

      <!-- Rule List -->
      <div v-if="graphStore.textFormatRules.length > 0" class="rules-list">
        <div
          v-for="rule in sortedRules"
          :key="rule.id"
          :class="['rule-item', { disabled: !rule.enabled }]"
        >
          <div class="rule-header">
            <input
              type="checkbox"
              :checked="rule.enabled"
              @change="graphStore.setTextFormatRuleEnabled(rule.id, !rule.enabled)"
              class="rule-checkbox"
            />
            <span class="rule-name">{{ rule.name }}</span>
            <span class="rule-priority" :title="'Priority: ' + rule.priority">{{ rule.priority }}</span>
            <span class="rule-target">{{ rule.target }}</span>
            <button class="rule-action" @click="editRule(rule)" title="Edit">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
              </svg>
            </button>
            <button class="rule-action delete" @click="deleteRule(rule.id)" title="Delete">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
          <div class="rule-template">
            <code>{{ rule.template }}</code>
          </div>
          <div v-if="rule.types.length > 0" class="rule-types">
            <span v-for="t in rule.types" :key="t" class="type-tag">{{ t }}</span>
          </div>
        </div>
      </div>

      <div v-else class="no-rules">
        No custom rules defined. Click + to add one.
      </div>
    </div>

    <!-- Add/Edit Rule Form -->
    <div v-if="isEditing" class="rule-form">
      <div class="form-header">
        <h4>{{ editingRule ? 'Edit Rule' : 'New Rule' }}</h4>
        <button class="close-btn" @click="cancelEdit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div class="form-field">
        <label>Name</label>
        <input v-model="formData.name" type="text" placeholder="Rule name" />
      </div>

      <div class="form-field">
        <label>Target</label>
        <select v-model="formData.target">
          <option value="node">Node</option>
          <option value="edge">Edge</option>
        </select>
      </div>

      <div class="form-field">
        <label>Types (empty = all)</label>
        <select v-model="formData.types" multiple>
          <option v-for="t in availableTypes" :key="t" :value="t">{{ t }}</option>
        </select>
      </div>

      <div class="form-field">
        <label>Template</label>
        <div class="template-input-wrapper">
          <input
            v-model="formData.template"
            type="text"
            placeholder="{prop:name}"
            class="template-input"
            @focus="activeInput = 'form'"
            @input="handleTemplateInput($event, 'form')"
            @keydown="handleKeydown($event, 'form')"
            @blur="handleBlur"
            ref="formTemplateInput"
          />
          <div v-if="activeInput === 'form' && suggestions.length > 0" class="suggestions-dropdown">
            <div
              v-for="(suggestion, idx) in suggestions"
              :key="idx"
              :class="['suggestion-item', { active: selectedSuggestionIndex === idx }]"
              @mousedown.prevent="insertSuggestion(suggestion, 'form')"
            >
              <code>{{ suggestion.placeholder }}</code>
              <span class="suggestion-desc">{{ suggestion.description }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="form-field">
        <label>Priority</label>
        <input v-model.number="formData.priority" type="number" min="0" max="100" />
      </div>

      <div class="form-actions">
        <button class="btn secondary" @click="cancelEdit">Cancel</button>
        <button class="btn primary" @click="saveRule" :disabled="!isFormValid">Save</button>
      </div>
    </div>

    <!-- Help Modal -->
    <TextFormatHelpModal v-model="showHelp" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue';
import { useGraphStore } from '@/stores/graph';
import type { TextFormatRule, TextFormatScope } from '@/types/graph';
import { getAvailablePlaceholders, getAvailableModifiers, validateTemplate } from '@/utils/labelFormatter';
import TextFormatHelpModal from './TextFormatHelpModal.vue';
import { X, HelpCircle } from 'lucide-vue-next';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const graphStore = useGraphStore();

// Help modal
const showHelp = ref(false);

// Default templates (synced with store)
const nodeDefaultTemplate = ref(graphStore.textFormatDefaults.nodeTemplate);
const edgeDefaultTemplate = ref(graphStore.textFormatDefaults.edgeTemplate);

// Watch and update store (debounced — template changes trigger full graph redraw)
let _templateDebounce: ReturnType<typeof setTimeout> | null = null;
function debouncedStoreUpdate(update: () => void) {
  if (_templateDebounce) clearTimeout(_templateDebounce);
  _templateDebounce = setTimeout(update, 400);
}
onUnmounted(() => { if (_templateDebounce) clearTimeout(_templateDebounce); });

watch(nodeDefaultTemplate, (val) => {
  debouncedStoreUpdate(() => graphStore.updateTextFormatDefaults({ nodeTemplate: val }));
});

watch(edgeDefaultTemplate, (val) => {
  debouncedStoreUpdate(() => graphStore.updateTextFormatDefaults({ edgeTemplate: val }));
});

// Sync from store
watch(() => graphStore.textFormatDefaults, (val) => {
  nodeDefaultTemplate.value = val.nodeTemplate;
  edgeDefaultTemplate.value = val.edgeTemplate;
}, { deep: true });

// Rules sorted by priority
const sortedRules = computed(() => {
  return [...graphStore.textFormatRules].sort((a, b) => b.priority - a.priority);
});

// Editing state
const isEditing = ref(false);
const editingRule = ref<TextFormatRule | null>(null);

interface FormData {
  name: string;
  target: 'node' | 'edge';
  types: string[];
  template: string;
  priority: number;
  scope: TextFormatScope;
}

const formData = ref<FormData>({
  name: '',
  target: 'node',
  types: [],
  template: '',
  priority: 10,
  scope: 'exploration',
});

const isFormValid = computed(() => {
  return formData.value.name.trim() !== '' && formData.value.template.trim() !== '';
});

// Available types based on target
const availableTypes = computed(() => {
  return formData.value.target === 'node' ? graphStore.nodeTypes : graphStore.edgeTypes;
});

// Autocomplete state
const activeInput = ref<string | null>(null);
const suggestions = ref<{ placeholder: string; description: string }[]>([]);
const selectedSuggestionIndex = ref(0);

const nodeDefaultInput = ref<HTMLInputElement | null>(null);
const edgeDefaultInput = ref<HTMLInputElement | null>(null);
const formTemplateInput = ref<HTMLInputElement | null>(null);

// Get properties from current context
const nodeProperties = computed(() => {
  return graphStore.currentContext?.node_properties.map(p => p.name) || [];
});

const edgeProperties = computed(() => {
  return graphStore.currentContext?.edge_properties.map(p => p.name) || [];
});

function getInputRef(inputId: string): HTMLInputElement | null {
  switch (inputId) {
    case 'nodeDefault': return nodeDefaultInput.value;
    case 'edgeDefault': return edgeDefaultInput.value;
    case 'form': return formTemplateInput.value;
    default: return null;
  }
}

function getTargetForInput(inputId: string): 'node' | 'edge' {
  if (inputId === 'edgeDefault') return 'edge';
  if (inputId === 'form') return formData.value.target;
  return 'node';
}

function handleTemplateInput(event: Event, inputId: string) {
  const input = event.target as HTMLInputElement;
  const value = input.value;
  const cursorPos = input.selectionStart || 0;

  // Find if we're inside a placeholder
  const beforeCursor = value.slice(0, cursorPos);
  const lastOpenBrace = beforeCursor.lastIndexOf('{');
  const lastCloseBrace = beforeCursor.lastIndexOf('}');

  if (lastOpenBrace > lastCloseBrace) {
    // We're inside a placeholder, show suggestions
    const partial = beforeCursor.slice(lastOpenBrace + 1);
    const target = getTargetForInput(inputId);
    const props = target === 'node' ? nodeProperties.value : edgeProperties.value;
    const allSuggestions = [
      ...getAvailablePlaceholders(target, props),
      ...getAvailableModifiers().map(m => ({
        placeholder: `|${m.modifier}`,
        description: m.description,
      })),
    ];

    // Filter based on partial input
    suggestions.value = allSuggestions.filter(s =>
      s.placeholder.toLowerCase().includes(partial.toLowerCase())
    ).slice(0, 8);

    selectedSuggestionIndex.value = 0;
  } else {
    suggestions.value = [];
  }
}

function handleKeydown(event: KeyboardEvent, inputId: string) {
  if (suggestions.value.length === 0) return;

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      selectedSuggestionIndex.value = Math.min(
        selectedSuggestionIndex.value + 1,
        suggestions.value.length - 1
      );
      break;
    case 'ArrowUp':
      event.preventDefault();
      selectedSuggestionIndex.value = Math.max(selectedSuggestionIndex.value - 1, 0);
      break;
    case 'Enter':
    case 'Tab':
      if (suggestions.value.length > 0) {
        event.preventDefault();
        insertSuggestion(suggestions.value[selectedSuggestionIndex.value], inputId);
      }
      break;
    case 'Escape':
      suggestions.value = [];
      break;
  }
}

function insertSuggestion(suggestion: { placeholder: string; description: string }, inputId: string) {
  const input = getInputRef(inputId);
  if (!input) return;

  const value = input.value;
  const cursorPos = input.selectionStart || 0;

  // Find the start of current placeholder
  const beforeCursor = value.slice(0, cursorPos);
  const lastOpenBrace = beforeCursor.lastIndexOf('{');

  let newValue: string;
  let newCursorPos: number;

  if (suggestion.placeholder.startsWith('|')) {
    // Modifier - insert at cursor
    newValue = value.slice(0, cursorPos) + suggestion.placeholder + value.slice(cursorPos);
    newCursorPos = cursorPos + suggestion.placeholder.length;
  } else {
    // Full placeholder - replace from last brace
    newValue = value.slice(0, lastOpenBrace) + suggestion.placeholder + value.slice(cursorPos);
    newCursorPos = lastOpenBrace + suggestion.placeholder.length;
  }

  // Update the appropriate model
  switch (inputId) {
    case 'nodeDefault':
      nodeDefaultTemplate.value = newValue;
      break;
    case 'edgeDefault':
      edgeDefaultTemplate.value = newValue;
      break;
    case 'form':
      formData.value.template = newValue;
      break;
  }

  suggestions.value = [];

  // Restore cursor position
  nextTick(() => {
    input.focus();
    input.setSelectionRange(newCursorPos, newCursorPos);
  });
}

function handleBlur() {
  // Delay to allow click on suggestions
  setTimeout(() => {
    suggestions.value = [];
    activeInput.value = null;
  }, 200);
}

// Rule management
function startAddRule() {
  isEditing.value = true;
  editingRule.value = null;
  formData.value = {
    name: '',
    target: 'node',
    types: [],
    template: '',
    priority: 10,
    scope: 'exploration',
  };
}

function editRule(rule: TextFormatRule) {
  isEditing.value = true;
  editingRule.value = rule;
  formData.value = {
    name: rule.name,
    target: rule.target,
    types: [...rule.types],
    template: rule.template,
    priority: rule.priority,
    scope: rule.scope,
  };
}

function cancelEdit() {
  isEditing.value = false;
  editingRule.value = null;
}

function saveRule() {
  if (!isFormValid.value) return;

  const validation = validateTemplate(formData.value.template);
  if (!validation.valid) {
    alert('Template error: ' + validation.errors.join(', '));
    return;
  }

  if (editingRule.value) {
    // Update existing
    graphStore.updateTextFormatRule(editingRule.value.id, {
      name: formData.value.name,
      target: formData.value.target,
      types: formData.value.types,
      template: formData.value.template,
      priority: formData.value.priority,
      scope: formData.value.scope,
    });
  } else {
    // Create new
    graphStore.addTextFormatRule({
      name: formData.value.name,
      target: formData.value.target,
      types: formData.value.types,
      template: formData.value.template,
      priority: formData.value.priority,
      enabled: true,
      scope: formData.value.scope,
    });
  }

  cancelEdit();
}

function deleteRule(ruleId: string) {
  if (confirm('Delete this rule?')) {
    graphStore.removeTextFormatRule(ruleId);
  }
}
</script>

<style scoped>
.text-format-panel {
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

.section {
  margin-bottom: 20px;
}

.section-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--vt-c-text-2, #888);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}

.add-rule-btn {
  background: var(--color-primary, #42b883);
  border: none;
  color: white;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.add-rule-btn:hover {
  opacity: 0.9;
  transform: scale(1.05);
}

.default-template {
  margin-bottom: 12px;
}

.default-template label {
  display: block;
  font-size: 0.8rem;
  color: var(--vt-c-text-2, #888);
  margin-bottom: 4px;
}

.template-input-wrapper {
  position: relative;
}

.template-input {
  width: 100%;
  padding: 8px 10px;
  background: var(--vt-c-bg-soft, #2a2a2a);
  border: 1px solid var(--vt-c-divider, #333);
  border-radius: 6px;
  color: var(--vt-c-text-1, #fff);
  font-family: 'Fira Code', 'Consolas', monospace;
  font-size: 0.85rem;
}

.template-input:focus {
  outline: none;
  border-color: var(--color-primary, #42b883);
}

.suggestions-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: var(--vt-c-bg, #1a1a1a);
  border: 1px solid var(--vt-c-divider, #333);
  border-radius: 6px;
  margin-top: 4px;
  max-height: 200px;
  overflow-y: auto;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.suggestion-item {
  padding: 8px 10px;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.suggestion-item:hover,
.suggestion-item.active {
  background: var(--vt-c-bg-soft, #2a2a2a);
}

.suggestion-item code {
  color: var(--color-primary, #42b883);
  font-size: 0.8rem;
}

.suggestion-desc {
  color: var(--vt-c-text-3, #666);
  font-size: 0.75rem;
  text-align: right;
}

.rules-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rule-item {
  background: var(--vt-c-bg-soft, #2a2a2a);
  border-radius: 6px;
  padding: 10px;
}

.rule-item.disabled {
  opacity: 0.5;
}

.rule-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rule-checkbox {
  margin: 0;
}

.rule-name {
  flex: 1;
  font-weight: 500;
  color: var(--vt-c-text-1, #fff);
}

.rule-priority {
  font-size: 0.7rem;
  padding: 2px 6px;
  background: var(--color-primary, #42b883);
  border-radius: 4px;
  color: white;
  font-weight: 600;
  min-width: 20px;
  text-align: center;
}

.rule-target {
  font-size: 0.7rem;
  padding: 2px 6px;
  background: var(--vt-c-bg-mute, #333);
  border-radius: 4px;
  color: var(--vt-c-text-2, #888);
  text-transform: uppercase;
}

.rule-action {
  background: none;
  border: none;
  color: var(--vt-c-text-3, #666);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  border-radius: 4px;
  transition: all 0.2s;
}

.rule-action:hover {
  background: var(--vt-c-bg-mute, #333);
  color: var(--vt-c-text-1, #fff);
}

.rule-action.delete:hover {
  color: #e74c3c;
}

.rule-template {
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--vt-c-bg-mute, #333);
  border-radius: 4px;
}

.rule-template code {
  font-size: 0.8rem;
  color: var(--color-primary, #42b883);
  word-break: break-all;
}

.rule-types {
  display: flex;
  gap: 4px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.type-tag {
  font-size: 0.7rem;
  padding: 2px 6px;
  background: var(--color-primary, #42b883);
  color: white;
  border-radius: 4px;
}

.no-rules {
  text-align: center;
  color: var(--vt-c-text-3, #666);
  font-size: 0.85rem;
  padding: 20px;
}

/* Rule Form */
.rule-form {
  background: var(--vt-c-bg-soft, #2a2a2a);
  border-radius: 8px;
  padding: 16px;
  margin-top: 16px;
}

.form-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.form-header h4 {
  margin: 0;
  font-size: 1rem;
  color: var(--vt-c-text-1, #fff);
}

.close-btn {
  background: none;
  border: none;
  color: var(--vt-c-text-2, #888);
  cursor: pointer;
  padding: 4px;
  display: flex;
  border-radius: 4px;
}

.close-btn:hover {
  color: var(--vt-c-text-1, #fff);
}

.form-field {
  margin-bottom: 12px;
}

.form-field label {
  display: block;
  font-size: 0.8rem;
  color: var(--vt-c-text-2, #888);
  margin-bottom: 4px;
}

.form-field input,
.form-field select {
  width: 100%;
  padding: 8px 10px;
  background: var(--vt-c-bg-mute, #333);
  border: 1px solid var(--vt-c-divider, #444);
  border-radius: 6px;
  color: var(--vt-c-text-1, #fff);
  font-size: 0.85rem;
}

.form-field input:focus,
.form-field select:focus {
  outline: none;
  border-color: var(--color-primary, #42b883);
}

.form-field select[multiple] {
  min-height: 80px;
}

.form-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}

.btn {
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.2s;
}

.btn.primary {
  background: var(--color-primary, #42b883);
  border: none;
  color: white;
}

.btn.primary:hover:not(:disabled) {
  opacity: 0.9;
}

.btn.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn.secondary {
  background: var(--vt-c-bg-mute, #333);
  border: 1px solid var(--vt-c-divider, #444);
  color: var(--vt-c-text-1, #fff);
}

.btn.secondary:hover {
  border-color: var(--vt-c-text-3, #666);
}
</style>
