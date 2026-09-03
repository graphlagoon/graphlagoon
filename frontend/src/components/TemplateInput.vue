<template>
  <div class="template-input-wrapper">
    <input
      ref="inputRef"
      :value="modelValue"
      type="text"
      :placeholder="placeholder"
      class="template-input"
      :data-testid="dataTestid"
      @input="handleInput"
      @keydown="handleKeydown"
      @blur="handleBlur"
    />
    <div v-if="suggestions.length > 0" class="suggestions-dropdown">
      <div
        v-for="(suggestion, idx) in suggestions"
        :key="idx"
        :class="['suggestion-item', { active: selectedSuggestionIndex === idx }]"
        @mousedown.prevent="insertSuggestion(suggestion)"
      >
        <code>{{ suggestion.placeholder }}</code>
        <span class="suggestion-desc">{{ suggestion.description }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useMetricsStore } from '@/stores/metrics';
import { getAvailablePlaceholders, getAvailableModifiers } from '@/utils/labelFormatter';

/**
 * A template-language text input with `{`-triggered autocomplete over the
 * current context's real columns, session metrics, and the modifier registry.
 * Extracted from TextFormatPanel so the panel's four template fields and the
 * rule editor modal share one implementation.
 */

const props = defineProps<{
  modelValue: string;
  /** Which placeholder set to offer: node or edge columns/built-ins. */
  target: 'node' | 'edge';
  placeholder?: string;
  dataTestid?: string;
}>();

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>();

const graphStore = useGraphStore();
const metricsStore = useMetricsStore();

const inputRef = ref<HTMLInputElement | null>(null);
const suggestions = ref<{ placeholder: string; description: string }[]>([]);
const selectedSuggestionIndex = ref(0);

const properties = computed(() => {
  const cols =
    props.target === 'node'
      ? graphStore.currentContext?.node_properties
      : graphStore.currentContext?.edge_properties;
  return cols?.map((p) => p.name) || [];
});

/**
 * Last index of an unescaped `ch` in `s` — backslash-escaped braces (e.g.
 * inside a regex arg like match:/a\{2\}/) don't toggle the autocomplete.
 */
function lastUnescapedIndex(s: string, ch: string): number {
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ch && (i === 0 || s[i - 1] !== '\\')) return i;
  }
  return -1;
}

function handleInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const value = input.value;
  emit('update:modelValue', value);

  const cursorPos = input.selectionStart || 0;

  // Find if we're inside a placeholder
  const beforeCursor = value.slice(0, cursorPos);
  const lastOpenBrace = lastUnescapedIndex(beforeCursor, '{');
  const lastCloseBrace = lastUnescapedIndex(beforeCursor, '}');

  if (lastOpenBrace > lastCloseBrace) {
    // We're inside a placeholder, show suggestions
    const partial = beforeCursor.slice(lastOpenBrace + 1);
    const metricNames = (
      props.target === 'node' ? metricsStore.nodeMetrics : metricsStore.edgeMetrics
    ).map((m) => m.name);
    const allSuggestions = [
      ...getAvailablePlaceholders(props.target, properties.value, metricNames),
      ...getAvailableModifiers().map((m) => ({
        placeholder: `|${m.modifier}`,
        description: m.description,
      })),
    ];

    // Filter based on partial input
    suggestions.value = allSuggestions
      .filter((s) => s.placeholder.toLowerCase().includes(partial.toLowerCase()))
      .slice(0, 8);

    selectedSuggestionIndex.value = 0;
  } else {
    suggestions.value = [];
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (suggestions.value.length === 0) return;

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      selectedSuggestionIndex.value = Math.min(
        selectedSuggestionIndex.value + 1,
        suggestions.value.length - 1,
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
        insertSuggestion(suggestions.value[selectedSuggestionIndex.value]);
      }
      break;
    case 'Escape':
      // Stop the global escape-closes-modal handler: this press only
      // dismisses the dropdown.
      event.stopPropagation();
      suggestions.value = [];
      break;
  }
}

function insertSuggestion(suggestion: { placeholder: string; description: string }) {
  const input = inputRef.value;
  if (!input) return;

  const value = input.value;
  const cursorPos = input.selectionStart || 0;

  // Find the start of current placeholder
  const beforeCursor = value.slice(0, cursorPos);
  const lastOpenBrace = lastUnescapedIndex(beforeCursor, '{');

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

  emit('update:modelValue', newValue);
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
  }, 200);
}
</script>

<style scoped>
/* Styles lifted verbatim from TextFormatPanel so the extraction is invisible. */
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
  box-sizing: border-box;
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
</style>
