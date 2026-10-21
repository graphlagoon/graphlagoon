<script setup lang="ts">
/**
 * "Your data" (BYOD-2) in the canvas's bottom bar, beside Table and Console: shown on a graph
 * the person can write and with `exploration.edit_graph` (hide, never disable). Opens the
 * dialog that adds the user's layer to the exploration.
 */
import { computed, ref } from 'vue';
import { FilePlus2 } from 'lucide-vue-next';
import { useGraphStore } from '@/stores/graph';
import { usePermissions } from '@/composables/usePermissions';
import YourDataModal from '@/components/YourDataModal.vue';

const graphStore = useGraphStore();
const { can } = usePermissions();
const open = ref(false);
const visible = computed(() => graphStore.canEditOverlay && can('exploration.edit_graph'));
</script>

<template>
  <button
    v-if="visible"
    class="toolbar-btn"
    :class="{ active: open }"
    title="Your data: enrich nodes from a file, add nodes and edges, draw by hand"
    data-testid="toolbar-your-data"
    @click="open = true"
  >
    <FilePlus2 :size="14" />
    <span class="btn-label">Your data</span>
  </button>
  <YourDataModal v-if="open" @close="open = false" />
</template>

<style scoped>
/* The bar's button look (GraphVisualizationView's styles are scoped to the view). */
.toolbar-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--card-background, white);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}
.toolbar-btn:hover {
  background: var(--bg-secondary, #f0f0f0);
}
.toolbar-btn.active {
  background: var(--primary-color, #42b883);
  color: white;
  border-color: var(--primary-color, #42b883);
}
.btn-label {
  font-size: 12px;
}
</style>
