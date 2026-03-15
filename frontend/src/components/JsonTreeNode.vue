<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  label: string | null;
  value: unknown;
  depth?: number;
  maxAutoExpand?: number;
}>(), {
  depth: 0,
  maxAutoExpand: 2,
});

const isExpandable = computed(() =>
  typeof props.value === 'object' && props.value !== null
);

const isArray = computed(() => Array.isArray(props.value));

const entries = computed(() => {
  if (!isExpandable.value) return [];
  if (Array.isArray(props.value)) {
    return props.value.map((v, i) => ({ key: String(i), value: v }));
  }
  return Object.entries(props.value as Record<string, unknown>).map(([k, v]) => ({
    key: k,
    value: v,
  }));
});

const typeHint = computed(() => {
  if (Array.isArray(props.value)) return `Array(${props.value.length})`;
  if (typeof props.value === 'object' && props.value !== null) {
    return `Object{${Object.keys(props.value).length}}`;
  }
  return '';
});

const valueTypeClass = computed(() => {
  if (props.value === null) return 'type-null';
  switch (typeof props.value) {
    case 'string': return 'type-string';
    case 'number': return 'type-number';
    case 'boolean': return 'type-boolean';
    default: return '';
  }
});

const displayValue = computed(() => {
  if (props.value === null) return 'null';
  if (props.value === undefined) return 'undefined';
  if (typeof props.value === 'string') return `"${props.value}"`;
  return String(props.value);
});

const autoOpen = computed(() => props.depth < props.maxAutoExpand);
</script>

<template>
  <!-- Leaf node (primitive) -->
  <div v-if="!isExpandable" class="tree-leaf">
    <span v-if="label !== null" class="tree-key">{{ label }}: </span>
    <span :class="['tree-value', valueTypeClass]">{{ displayValue }}</span>
  </div>

  <!-- Expandable node (object/array) -->
  <details v-else :open="autoOpen" class="tree-node">
    <summary class="tree-summary">
      <span v-if="label !== null" class="tree-key">{{ label }}: </span>
      <span class="tree-type-hint">{{ typeHint }}</span>
    </summary>
    <div class="tree-children">
      <JsonTreeNode
        v-for="entry in entries"
        :key="entry.key"
        :label="isArray ? `[${entry.key}]` : entry.key"
        :value="entry.value"
        :depth="depth + 1"
        :maxAutoExpand="maxAutoExpand"
      />
    </div>
  </details>
</template>

<style scoped>
.tree-leaf {
  padding: 1px 0;
  font-size: 12px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  line-height: 1.6;
}

.tree-node {
  font-size: 12px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  line-height: 1.6;
}

.tree-summary {
  cursor: pointer;
  padding: 1px 0;
  list-style: inside;
  user-select: none;
}

.tree-summary:hover {
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 3px;
}

.tree-children {
  padding-left: 16px;
  border-left: 1px solid var(--border-color, #e0e0e0);
  margin-left: 6px;
}

.tree-key {
  color: var(--text-muted, #666);
}

.tree-value.type-string { color: #22863a; }
.tree-value.type-number { color: #005cc5; }
.tree-value.type-boolean { color: #d73a49; }
.tree-value.type-null { color: var(--text-muted, #999); font-style: italic; }

.tree-type-hint {
  color: var(--text-muted, #888);
  font-size: 11px;
}
</style>
