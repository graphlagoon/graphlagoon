<script setup lang="ts">
import { computed } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { Briefcase, Crosshair, X } from 'lucide-vue-next';
import { useCurrentCaseStore } from '@/stores/currentCase';
import { useAddToCase } from '@/composables/useAddToCase';
import { useToast } from '@/composables/useToast';
import SelectionDetails from './SelectionDetails.vue';

// Props for different display modes
const props = withDefaults(defineProps<{
  variant?: 'sidebar' | 'floating';
}>(), {
  variant: 'sidebar',
});

const emit = defineEmits<{
  showDetails: [];
}>();

const graphStore = useGraphStore();
const currentCase = useCurrentCaseStore();
const addToCase = useAddToCase();
const toast = useToast();

/** Nodes the add takes: the selection (plus the one shown). Said on the button, so N is never a surprise. */
const selectedCount = computed(() => {
  const ids = new Set(graphStore.selectedNodeIds);
  if (graphStore.selectedNode) ids.add(graphStore.selectedNode.node_id);
  return ids.size;
});
const canAddToCase = computed(() => !graphStore.investigationMode && selectedItem.value?.type === 'node');
async function addSelectionToCase() {
  if (!currentCase.hasCase) {
    currentCase.requestPick();
    toast.info('Pick the case in the top bar, then add the selection again.');
    return;
  }
  const ids = new Set(graphStore.selectedNodeIds);
  if (graphStore.selectedNode) ids.add(graphStore.selectedNode.node_id);
  await addToCase.addSelection(ids, graphStore.selectedEdgeIds);
}

const hasSelection = computed(() => {
  return graphStore.selectedNode || graphStore.selectedEdge;
});

const selectedItem = computed(() => {
  if (graphStore.selectedNode) {
    return {
      type: 'node' as const,
      data: graphStore.selectedNode,
    };
  }
  if (graphStore.selectedEdge) {
    return {
      type: 'edge' as const,
      data: graphStore.selectedEdge,
    };
  }
  return null;
});

// The exploration's default focus: the node it opens on, saved with it. A
// case has its own (per graph item), so the toggle belongs to the explorer.
const canSetFocus = computed(() => !graphStore.investigationMode && selectedItem.value?.type === 'node');
const isDefaultFocus = computed(
  () => selectedItem.value?.type === 'node' && graphStore.focusNodeId === selectedItem.value.data.node_id,
);
function toggleDefaultFocus() {
  if (selectedItem.value?.type !== 'node') return;
  graphStore.focusNodeId = isDefaultFocus.value ? null : selectedItem.value.data.node_id;
}
</script>

<template>
  <div v-if="hasSelection" :class="['side-panel', `side-panel--${props.variant}`]">
    <template v-if="selectedItem">
      <div class="panel-header">
        <h3>
          {{ selectedItem.type === 'node' ? 'Node Details' : 'Edge Details' }}
          <span v-if="selectedCount > 1" class="selected-count" data-testid="side-panel-selected-count">· {{ selectedCount }} selected</span>
        </h3>
        <div class="panel-header-actions">
          <button
            v-if="canSetFocus"
            class="btn btn-outline btn-sm"
            :class="{ on: isDefaultFocus }"
            :aria-pressed="isDefaultFocus"
            :title="isDefaultFocus ? 'The exploration opens on this node; click to stop' : 'Open the exploration selected and centred on this node (saved with it)'"
            data-testid="side-panel-default-focus"
            @click="toggleDefaultFocus"
          >
            <Crosshair :size="13" /> {{ isDefaultFocus ? 'Default focus ✓' : 'Default focus' }}
          </button>
          <button
            v-if="canAddToCase"
            class="btn btn-outline btn-sm"
            :title="currentCase.hasCase ? `Add the selected nodes to ${currentCase.title || 'the current case'}` : 'Pick a current case in the top bar first'"
            data-testid="side-panel-add-to-case"
            @click="addSelectionToCase"
          >
            <Briefcase :size="13" /> {{ selectedCount > 1 ? `Add ${selectedCount} to case` : 'Add to case' }}
          </button>
          <button
            class="btn btn-outline btn-sm"
            @click="emit('showDetails')"
            title="View all details in modal"
          >
           Open details
          </button>
          <button class="btn-icon-only" aria-label="Clear selection" @click="graphStore.clearSelection"><X :size="16" /></button>
        </div>
      </div>

      <SelectionDetails :item="selectedItem" />
    </template>
  </div>
</template>

<style scoped>
.side-panel {
  width: 300px;
  padding: 16px;
  background: var(--card-background);
  overflow-y: auto;
}

/* Sidebar variant (default) - used in normal view */
.side-panel--sidebar {
  border-left: 1px solid var(--border-color);
}

/* Floating variant - used in fullscreen mode */
.side-panel--floating {
  position: absolute;
  top: 16px;
  right: 16px;
  max-height: calc(100% - 100px);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  z-index: 30;
  display: flex;
  flex-direction: column;
}

.side-panel--floating .panel-content {
  overflow-y: auto;
  flex: 1;
}

/* The title on its own line, the actions under it: side by side in 267 px the title wrapped. */
.panel-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}

.panel-header h3 {
  flex: 1 0 100%;
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
}

.selected-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
}

.panel-header-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
  align-items: center;
}

.btn.on {
  border-color: var(--primary-color, #42b883);
  color: var(--primary-color, #42b883);
  font-weight: 600;
}

.btn-sm {
  padding: 4px 8px;
  font-size: 14px;
}
</style>
