<script setup lang="ts">
import type {
  ClusterProgramParameter,
  ClusterProgramParamValues,
} from '@/types/cluster'

const props = defineProps<{
  parameters: ClusterProgramParameter[]
  modelValue: ClusterProgramParamValues
  /** Tighter styling for the Communities tab inline section */
  compact?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: ClusterProgramParamValues): void
}>()

function setValue(id: string, value: string | number | boolean) {
  emit('update:modelValue', { ...props.modelValue, [id]: value })
}

function onNumberInput(id: string, raw: string) {
  // Keep empty as '' so required-validation can flag it; otherwise store the number
  setValue(id, raw === '' ? '' : Number(raw))
}

function isMissing(param: ClusterProgramParameter): boolean {
  if (param.type === 'boolean' || !param.required) return false
  const value = props.modelValue[param.id]
  return value === undefined || (typeof value === 'string' && value.trim() === '')
}

function labelFor(param: ClusterProgramParameter): string {
  return param.label || param.id
}
</script>

<template>
  <div class="param-inputs" :class="{ compact }">
    <div v-for="param in parameters" :key="param.id" class="param-group">
      <label v-if="param.type !== 'boolean'" :for="`cp-param-${param.id}`" class="param-label">
        {{ labelFor(param) }}
        <span v-if="param.required" class="required-mark">*</span>
      </label>

      <label v-if="param.type === 'boolean'" class="param-checkbox">
        <input
          :id="`cp-param-${param.id}`"
          type="checkbox"
          :checked="Boolean(modelValue[param.id])"
          @change="setValue(param.id, ($event.target as HTMLInputElement).checked)"
        />
        {{ labelFor(param) }}
      </label>

      <select
        v-else-if="param.type === 'select'"
        :id="`cp-param-${param.id}`"
        class="param-input"
        :class="{ missing: isMissing(param) }"
        :value="String(modelValue[param.id] ?? '')"
        @change="setValue(param.id, ($event.target as HTMLSelectElement).value)"
      >
        <option value="">— choose —</option>
        <option v-for="opt in (param.options ?? [])" :key="opt" :value="opt">{{ opt }}</option>
      </select>

      <input
        v-else-if="param.type === 'number'"
        :id="`cp-param-${param.id}`"
        type="number"
        class="param-input"
        :class="{ missing: isMissing(param) }"
        :placeholder="param.placeholder"
        :value="modelValue[param.id] ?? ''"
        @input="onNumberInput(param.id, ($event.target as HTMLInputElement).value)"
      />

      <input
        v-else
        :id="`cp-param-${param.id}`"
        type="text"
        class="param-input"
        :class="{ missing: isMissing(param) }"
        :placeholder="param.placeholder || `Enter ${labelFor(param)}...`"
        :value="String(modelValue[param.id] ?? '')"
        @input="setValue(param.id, ($event.target as HTMLInputElement).value)"
      />

      <small v-if="param.description" class="param-desc">{{ param.description }}</small>
    </div>
  </div>
</template>

<style scoped>
.param-inputs {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.param-inputs.compact {
  gap: 6px;
}

.param-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.param-inputs.compact .param-group {
  gap: 2px;
}

.param-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-color, #333);
}

.param-inputs.compact .param-label {
  font-size: 12px;
  color: #555;
}

.required-mark {
  color: var(--error-color, #e74c3c);
  margin-left: 2px;
}

.param-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-color, #333);
}

.param-inputs.compact .param-checkbox {
  font-size: 12px;
}

.param-checkbox input[type='checkbox'] {
  cursor: pointer;
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
  width: 100%;
  box-sizing: border-box;
}

.param-inputs.compact .param-input {
  padding: 5px 6px;
  font-size: 12px;
  border-radius: 4px;
  background: var(--card-background, white);
}

.param-input:focus {
  border-color: var(--primary-color, #42b883);
}

.param-input.missing {
  border-color: var(--error-color, #e74c3c);
}

.param-desc {
  font-size: 11px;
  color: var(--text-muted, #888);
}

.param-inputs.compact .param-desc {
  font-size: 10px;
}
</style>
