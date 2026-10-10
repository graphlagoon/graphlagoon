<script setup lang="ts">
/**
 * Renders a paths analysis item (F3.6, F4): the paths found between source and
 * target, one shown at a time; showing a path highlights it by selecting its
 * nodes and edges. Parameters live in the Caminhos popover (AnalysisBar).
 */
import { computed, ref, watch } from 'vue';
import { useGraphStore } from '@/stores/graph';
import type { PathsContent } from '@/composables/useCaseAnalyses';
import { formatDate } from '@/utils/format';

const props = defineProps<{ content: PathsContent; nameOf: (id: string) => string }>();
const graphStore = useGraphStore();

const index = ref(0);
const current = computed(() => props.content.paths[index.value] ?? null);

function highlight() {
  const p = current.value;
  graphStore.selectedNodeIds = new Set(p?.nodes ?? []);
  graphStore.selectedEdgeIds = new Set(p?.edges ?? []);
}

function show(i: number) {
  index.value = i;
  highlight();
}

watch(
  () => props.content,
  () => {
    index.value = 0;
    highlight();
  },
  { immediate: true },
);
</script>

<template>
  <div class="path-bar" data-testid="path-bar">
    <span>
      <b>{{ nameOf(content.source) }}</b> → <b>{{ nameOf(content.target) }}</b>
      <span class="muted"> · {{ content.params.mode }}<template v-if="content.params.directed === false"> · any direction</template></span>
    </span>
    <span v-if="!content.paths.length" data-testid="path-none">no path</span>
    <span v-else-if="current" data-testid="path-result">
      {{ current.nodes.map(nameOf).join(' → ') }} · {{ current.edges.length }} {{ current.edges.length === 1 ? 'hop' : 'hops' }}
      <template v-if="content.params.mode === 'earliest'"> · chega {{ formatDate(current.cost) }}</template>
    </span>
    <span v-if="content.paths.length > 1" class="pager">
      <button :disabled="index === 0" @click="show(index - 1)">‹</button>
      {{ index + 1 }} / {{ content.paths.length }}
      <button :disabled="index === content.paths.length - 1" @click="show(index + 1)">›</button>
    </span>
    <button class="link-btn" data-testid="path-highlight" @click="highlight">highlight again</button>
  </div>
</template>

<style scoped>
.path-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 13px;
}

.muted {
  color: var(--text-muted);
}

.path-bar button {
  border: none;
  background: none;
  cursor: pointer;
  color: inherit;
}

.link-btn {
  color: var(--color-primary) !important;
  font-size: 12px;
}
</style>
