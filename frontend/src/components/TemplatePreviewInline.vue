<template>
  <div v-if="template.trim() !== ''" class="template-preview" data-testid="template-preview">
    <div
      v-for="(error, i) in validation.errors"
      :key="'e' + i"
      class="preview-error"
      data-testid="preview-error"
    >
      {{ error }}
    </div>
    <div
      v-for="(warning, i) in validation.warnings"
      :key="'w' + i"
      class="preview-warning"
      data-testid="preview-warning"
    >
      {{ warning }}
    </div>
    <template v-if="validation.valid">
      <div v-if="samples.length === 0" class="preview-empty" data-testid="preview-empty">
        no sample items loaded
      </div>
      <div
        v-for="(preview, i) in previews"
        :key="'p' + i"
        class="preview-sample"
        data-testid="preview-sample"
      >
        {{ preview }}
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { formatLabel, validateTemplate } from '@/utils/labelFormatter';
import type { Node, Edge } from '@/types/graph';

const props = defineProps<{
  template: string;
  target: 'node' | 'edge';
  /** Restrict samples to these node/edge types (empty or absent = any) */
  types?: string[];
}>();

const graphStore = useGraphStore();

// Debounced copy of the template — validation/formatting run at most every
// 400ms while typing (same cadence the panel uses for store updates)
const debouncedTemplate = ref(props.template);
let timer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => props.template,
  (val) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      debouncedTemplate.value = val;
    }, 400);
  },
);
onUnmounted(() => {
  if (timer) clearTimeout(timer);
});

const validation = computed(() => validateTemplate(debouncedTemplate.value));

const samples = computed<(Node | Edge)[]>(() => {
  const wanted = props.types ?? [];
  if (props.target === 'node') {
    const nodes = wanted.length > 0
      ? graphStore.nodes.filter((n) => wanted.includes(n.node_type))
      : graphStore.nodes;
    return nodes.slice(0, 3);
  }
  const edges = wanted.length > 0
    ? graphStore.edges.filter((e) => wanted.includes(e.relationship_type))
    : graphStore.edges;
  return edges.slice(0, 3);
});

const previews = computed(() => {
  if (debouncedTemplate.value.trim() === '' || !validation.value.valid) return [];
  return samples.value.map((item) => formatLabel(debouncedTemplate.value, props.target, item));
});
</script>

<style scoped>
.template-preview {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.preview-sample {
  font-family: monospace;
  font-size: 11px;
  color: var(--text-secondary, #888);
  background: var(--background-color, rgba(128, 128, 128, 0.08));
  border-radius: 3px;
  padding: 2px 6px;
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.preview-empty {
  font-size: 11px;
  font-style: italic;
  color: var(--text-secondary, #888);
  padding: 2px 6px;
}

.preview-error {
  font-size: 11px;
  color: #e05252;
  padding: 2px 6px;
}

.preview-warning {
  font-size: 11px;
  color: #d9a13d;
  padding: 2px 6px;
}
</style>
