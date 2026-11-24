<script setup lang="ts">
/** Says that an analysis runs on part of the graph, when filters or "show only" hide the rest. */
import { computed } from 'vue'
import { useGraphStore } from '@/stores/graph'

const graphStore = useGraphStore()
const shown = computed(() => graphStore.visibleNodes.length)
const total = computed(() => graphStore.nodes.length)
</script>

<template>
  <small v-if="shown < total" class="run-scope" data-testid="run-scope-note">
    Runs on the {{ shown.toLocaleString() }} visible of {{ total.toLocaleString() }} nodes: filters or “show only” hide the rest.
  </small>
</template>

<style scoped>
.run-scope {
  display: block;
  margin: 4px 0 8px;
  font-size: 12px;
  color: var(--text-muted, #666);
}
</style>
