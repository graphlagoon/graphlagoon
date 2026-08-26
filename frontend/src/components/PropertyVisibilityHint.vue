<script setup lang="ts">
import { computed } from 'vue';
import { useGraphStore } from '@/stores/graph';

// Rendered by every surface that filters properties through the allowlist, so
// a pruned table or details view is never mistaken for missing data. The
// surface passes its own counts — it is the only one that knows its key union,
// and an allowlist can name stale keys, so `allowed.length` would lie.
const props = defineProps<{
  kind: 'node' | 'edge';
  visible: number;
  total: number;
}>();

const graphStore = useGraphStore();

const active = computed(() => {
  const allowed = props.kind === 'node'
    ? graphStore.propertyVisibility.nodeProperties
    : graphStore.propertyVisibility.edgeProperties;
  return allowed !== null && props.visible < props.total;
});

function showAll() {
  graphStore.setPropertyVisibility(props.kind, null);
}
</script>

<template>
  <span v-if="active" class="property-visibility-hint" data-testid="property-visibility-hint">
    Showing {{ visible }} of {{ total }} properties ·
    <button type="button" class="show-all-btn" @click="showAll">Show all</button>
  </span>
</template>

<style scoped>
.property-visibility-hint {
  font-size: 11px;
  color: var(--text-muted, #888);
  white-space: nowrap;
}

.show-all-btn {
  background: none;
  border: none;
  padding: 0;
  font-size: 11px;
  color: var(--primary-color, #42b883);
  cursor: pointer;
  text-decoration: underline;
}
</style>
