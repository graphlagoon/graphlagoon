<template>
  <div v-if="hasContent" class="template-preview" data-testid="template-preview">
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
      <div v-if="fallbackActive" class="preview-fallback-badge" data-testid="preview-fallback-badge">
        {{ emptyFallback!.badge }}
      </div>
      <div v-if="samples.length === 0" class="preview-empty" data-testid="preview-empty">
        no sample items loaded
      </div>
      <template v-if="chrome === 'tooltip'">
        <div
          v-for="(preview, i) in previews"
          :key="'p' + i"
          class="preview-tooltip-chrome"
          data-testid="preview-tooltip-chrome"
        >
          <span class="preview-tooltip-body" data-testid="preview-sample">{{ preview }}</span>
          <span class="preview-tooltip-type">{{ chipFor(samples[i]) }}</span>
        </div>
      </template>
      <template v-else>
        <div
          v-for="(preview, i) in previews"
          :key="'p' + i"
          class="preview-sample"
          data-testid="preview-sample"
        >
          {{ preview }}
        </div>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useMetricsStore } from '@/stores/metrics';
import { formatLabel, validateTemplate } from '@/utils/labelFormatter';
import { EDGE_TYPE_CHIP } from '@/utils/tooltipContent';
import type { Node, Edge } from '@/types/graph';

const props = defineProps<{
  template: string;
  target: 'node' | 'edge';
  /** Restrict samples to these node/edge types (empty or absent = any) */
  types?: string[];
  /**
   * 'tooltip' renders each sample inside a mini hover-tooltip box (body left,
   * type chip right), mirroring what the canvas actually draws.
   */
  chrome?: 'plain' | 'tooltip';
  /**
   * What an EMPTY template inherits — e.g. a blank tooltip field shows the
   * label template's output with a "= label" badge, instead of nothing.
   */
  emptyFallback?: { template: string; badge: string };
}>();

const graphStore = useGraphStore();
const metricsStore = useMetricsStore();

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

const fallbackActive = computed(
  () => debouncedTemplate.value.trim() === '' && !!props.emptyFallback,
);

/** What actually gets validated and rendered: the template, or its inheritance. */
const effectiveTemplate = computed(() =>
  fallbackActive.value ? props.emptyFallback!.template : debouncedTemplate.value,
);

const hasContent = computed(() => effectiveTemplate.value.trim() !== '');

const validation = computed(() => validateTemplate(effectiveTemplate.value));

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
  if (!hasContent.value || !validation.value.valid) return [];
  // Touch the version so a metric recompute refreshes the preview.
  void metricsStore.metricsVersion;
  return samples.value.map((item) =>
    formatLabel(effectiveTemplate.value, props.target, item, { metrics: metricsStore.metricResolver }),
  );
});

function chipFor(item: Node | Edge | undefined): string {
  if (!item) return '';
  return props.target === 'node' ? (item as Node).node_type : EDGE_TYPE_CHIP;
}
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

/* Mini replica of GraphCanvas3D's .tooltip / .tooltip-type */
.preview-tooltip-chrome {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
  background: var(--card-background, white);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  padding: 4px 8px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}

.preview-tooltip-body {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-color, #333);
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.preview-tooltip-type {
  font-size: 10px;
  padding: 1px 5px;
  background: var(--bg-secondary, #f0f0f0);
  border-radius: 4px;
  color: var(--text-muted, #666);
  flex-shrink: 0;
}

.preview-fallback-badge {
  align-self: flex-start;
  font-size: 10px;
  font-style: italic;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-secondary, rgba(128, 128, 128, 0.12));
  color: var(--text-secondary, #888);
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
