<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useGraphStore } from '@/stores/graph';
import type { TextFormatRule, TextFormatScope, TextFormatSurface } from '@/types/graph';
import { validateTemplate } from '@/utils/labelFormatter';
import TemplateInput from './TemplateInput.vue';
import TemplatePreviewInline from './TemplatePreviewInline.vue';
import { X } from 'lucide-vue-next';

/**
 * Centered editor for one text-format rule — the house pattern (custom
 * metrics, cluster programs, context-menu actions all list in a panel and
 * edit in a modal). Escape/focus handling comes from the global
 * `.modal-overlay` handlers in App.vue; nothing keyboard-specific lives here.
 */

const props = defineProps<{
  /** Rule to edit, or null to create a new one */
  rule: TextFormatRule | null;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const graphStore = useGraphStore();
const isEditMode = computed(() => props.rule !== null);

/**
 * A new rule defaults to winning over the existing ones for its target —
 * "I created a rule and nothing changed" is the classic priority-system
 * trap. Existing rules keep their relative order; 100 stays the ceiling.
 */
function newestWinsPriority(forTarget: 'node' | 'edge'): number {
  const priorities = graphStore.textFormatRules
    .filter((r) => r.target === forTarget)
    .map((r) => r.priority);
  if (priorities.length === 0) return 10;
  return Math.min(100, Math.max(...priorities) + 10);
}

const name = ref(props.rule?.name ?? '');
const target = ref<'node' | 'edge'>(props.rule?.target ?? 'node');
const surface = ref<TextFormatSurface>(props.rule?.surface ?? 'label');
const types = ref<string[]>([...(props.rule?.types ?? [])]);
const template = ref(props.rule?.template ?? '');
const priority = ref(props.rule?.priority ?? newestWinsPriority('node'));
const scope = ref<TextFormatScope>(props.rule?.scope ?? 'exploration');

const formError = ref<string | null>(null);

const availableTypes = computed(() =>
  target.value === 'node' ? graphStore.nodeTypes : graphStore.edgeTypes,
);

// Node types make no sense on an edge rule and vice versa; a new rule's
// suggested priority follows the target's own rule pool.
watch(target, (t) => {
  types.value = [];
  if (!isEditMode.value) priority.value = newestWinsPriority(t);
});

function toggleType(t: string) {
  const idx = types.value.indexOf(t);
  if (idx === -1) types.value.push(t);
  else types.value.splice(idx, 1);
}

const isFormValid = computed(
  () => name.value.trim() !== '' && template.value.trim() !== '',
);

function save() {
  if (!isFormValid.value) return;

  // Errors block saving; warnings (e.g. unknown modifier) are shown by the
  // inline preview but don't prevent it
  const validation = validateTemplate(template.value);
  if (!validation.valid) {
    formError.value = 'Template error: ' + validation.errors.join(', ');
    return;
  }
  formError.value = null;

  const fields = {
    name: name.value,
    target: target.value,
    surface: surface.value,
    types: [...types.value],
    template: template.value,
    priority: priority.value,
    scope: scope.value,
  };

  if (props.rule) {
    graphStore.updateTextFormatRule(props.rule.id, fields);
  } else {
    graphStore.addTextFormatRule({ ...fields, enabled: true });
  }
  emit('close');
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal rule-editor-modal" data-testid="rule-editor-modal">
        <div class="modal-header">
          <h2>{{ isEditMode ? 'Edit Rule' : 'New Rule' }}</h2>
          <button class="modal-close" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
        </div>

        <div class="modal-body">
          <div class="form-field">
            <label>Name</label>
            <input v-model="name" type="text" placeholder="Rule name" data-testid="rule-name" />
          </div>

          <div class="form-row">
            <div class="form-field">
              <label>Target</label>
              <select v-model="target" data-testid="rule-target">
                <option value="node">Node</option>
                <option value="edge">Edge</option>
              </select>
            </div>

            <div class="form-field">
              <label>Applies to</label>
              <select
                v-model="surface"
                data-testid="rule-surface"
                title="Where this rule's template is used"
              >
                <option value="label">Labels</option>
                <option value="tooltip">Tooltips</option>
                <option value="both">Labels + tooltips</option>
              </select>
            </div>

            <div class="form-field priority-field">
              <label>Priority</label>
              <input
                v-model.number="priority"
                type="number"
                min="0"
                max="100"
                data-testid="rule-priority"
                title="Higher wins; new rules start above the existing ones"
              />
            </div>
          </div>

          <div class="form-field">
            <label>Types <span class="field-hint">(none checked = all types)</span></label>
            <div v-if="availableTypes.length > 0" class="types-list" data-testid="rule-types">
              <label v-for="t in availableTypes" :key="t" class="type-checkbox">
                <input
                  type="checkbox"
                  :checked="types.includes(t)"
                  @change="toggleType(t)"
                />
                <span>{{ t }}</span>
              </label>
            </div>
            <span v-else class="field-hint">No {{ target }} types loaded yet.</span>
          </div>

          <div class="form-field">
            <label>Template</label>
            <TemplateInput
              v-model="template"
              :target="target"
              multiline
              placeholder="{prop:name}"
              data-testid="rule-template"
            />
            <TemplatePreviewInline
              :template="template"
              :target="target"
              :types="types"
              :chrome="surface !== 'label' ? 'tooltip' : 'plain'"
            />
          </div>

          <div v-if="formError" class="form-error" data-testid="form-error">{{ formError }}</div>
        </div>

        <div class="modal-footer">
          <button class="btn-secondary" @click="emit('close')">Cancel</button>
          <button
            class="btn-primary"
            data-testid="rule-save"
            :disabled="!isFormValid"
            @click="save"
          >
            Save
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

.rule-editor-modal {
  background: var(--card-background, #fff);
  border-radius: 12px;
  width: 520px;
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
  padding: 18px 22px 14px;
  border-bottom: 1px solid var(--border-color, #ddd);
  flex-shrink: 0;
}

.modal-header h2 {
  font-size: 17px;
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
  padding: 18px 22px;
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
  padding: 14px 22px;
  border-top: 1px solid var(--border-color, #ddd);
}

.form-row {
  display: flex;
  gap: 12px;
}

.form-row .form-field {
  flex: 1;
}

.form-row .priority-field {
  flex: 0 0 90px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-field > label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #888);
}

.form-field input[type='text'],
.form-field input[type='number'],
.form-field select {
  padding: 7px 9px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  background: var(--input-background, var(--card-background, #fff));
  color: var(--text-color, #333);
  font-size: 13px;
}

.field-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted, #999);
}

.types-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  max-height: 130px;
  overflow-y: auto;
  padding: 6px 2px;
  border: 1px solid var(--border-color, #eee);
  border-radius: 6px;
}

.type-checkbox {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  cursor: pointer;
  padding: 1px 6px;
}

.form-error {
  font-size: 12px;
  color: #e05252;
  padding: 6px 8px;
  background: rgba(224, 82, 82, 0.08);
  border-radius: 6px;
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

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
