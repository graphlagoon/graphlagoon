<script setup lang="ts">
import { ref, watch, computed, onUnmounted } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { X } from 'lucide-vue-next';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const graphStore = useGraphStore();

// Use store's color functions for consistency
function getNodeColor(type: string): string {
  return graphStore.getNodeTypeColor(type);
}

function getEdgeColor(type: string): string {
  return graphStore.getEdgeTypeColor(type);
}

// Hidden types = types that should NOT be shown
const hiddenNodeTypes = ref<Set<string>>(new Set());
const hiddenEdgeTypes = ref<Set<string>>(new Set());
const searchQuery = ref(graphStore.filters.search_query || '');

// Convert hidden types to visible types for the store
const visibleNodeTypes = computed(() => {
  if (hiddenNodeTypes.value.size === 0) return [];
  return graphStore.nodeTypes.filter(t => !hiddenNodeTypes.value.has(t));
});

const visibleEdgeTypes = computed(() => {
  if (hiddenEdgeTypes.value.size === 0) return [];
  return graphStore.edgeTypes.filter(t => !hiddenEdgeTypes.value.has(t));
});

watch(
  () => graphStore.filters,
  (filters) => {
    // If filters are active, calculate hidden types
    if (filters.node_types.length > 0) {
      hiddenNodeTypes.value = new Set(
        graphStore.nodeTypes.filter(t => !filters.node_types.includes(t))
      );
    } else {
      hiddenNodeTypes.value.clear();
    }
    if (filters.edge_types.length > 0) {
      hiddenEdgeTypes.value = new Set(
        graphStore.edgeTypes.filter(t => !filters.edge_types.includes(t))
      );
    } else {
      hiddenEdgeTypes.value.clear();
    }
    searchQuery.value = filters.search_query || '';
  }
);

function isNodeTypeVisible(type: string): boolean {
  return !hiddenNodeTypes.value.has(type);
}

function isEdgeTypeVisible(type: string): boolean {
  return !hiddenEdgeTypes.value.has(type);
}

function toggleNodeType(type: string) {
  if (hiddenNodeTypes.value.has(type)) {
    hiddenNodeTypes.value.delete(type);
  } else {
    hiddenNodeTypes.value.add(type);
  }
  // Trigger reactivity
  hiddenNodeTypes.value = new Set(hiddenNodeTypes.value);
}

function toggleEdgeType(type: string) {
  if (hiddenEdgeTypes.value.has(type)) {
    hiddenEdgeTypes.value.delete(type);
  } else {
    hiddenEdgeTypes.value.add(type);
  }
  // Trigger reactivity
  hiddenEdgeTypes.value = new Set(hiddenEdgeTypes.value);
}

function applyFilters() {
  graphStore.applyFilters({
    node_types: visibleNodeTypes.value,
    edge_types: visibleEdgeTypes.value,
    search_query: searchQuery.value || undefined,
  });
}

let _searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
function applySearchDebounced() {
  if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(applyFilters, 300);
}
onUnmounted(() => { if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer); });

function resetFilters() {
  hiddenNodeTypes.value.clear();
  hiddenEdgeTypes.value.clear();
  searchQuery.value = '';
  graphStore.resetFilters();
}
</script>

<template>
  <div class="filter-panel">
    <div class="panel-header">
      <h3>Filters</h3>
      <div class="header-actions">
        <button class="btn btn-outline btn-sm" @click="resetFilters">Reset</button>
        <button class="btn-icon-only close-btn" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <div class="filter-section">
      <h4>Search</h4>
      <input
        v-model="searchQuery"
        class="form-control"
        placeholder="Search in metadata..."
        @input="applySearchDebounced"
      />
    </div>

    <div class="filter-section">
      <h4>Node Types</h4>
      <div class="checkbox-list">
        <label
          v-for="type in graphStore.nodeTypes"
          :key="type"
          class="checkbox-item"
        >
          <input
            type="checkbox"
            :checked="isNodeTypeVisible(type)"
            @change="toggleNodeType(type); applyFilters()"
          />
          <span
            class="type-color"
            :style="{ backgroundColor: getNodeColor(type) }"
          ></span>
          {{ type }}
        </label>
      </div>
    </div>

    <div class="filter-section">
      <h4>Edge Types</h4>
      <div class="checkbox-list">
        <label
          v-for="type in graphStore.edgeTypes"
          :key="type"
          class="checkbox-item"
        >
          <input
            type="checkbox"
            :checked="isEdgeTypeVisible(type)"
            @change="toggleEdgeType(type); applyFilters()"
          />
          <span
            class="type-color"
            :style="{ backgroundColor: getEdgeColor(type) }"
          ></span>
          {{ type }}
        </label>
      </div>
    </div>
  </div>
</template>


<style scoped>
.filter-panel {
  width: 250px;
  background: var(--card-background);
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
  padding: 16px;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.panel-header h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 4px;
}

.btn-sm {
  padding: 4px 8px;
  font-size: 12px;
}

.close-btn {
  font-size: 16px;
  padding: 2px 8px;
}

.filter-section {
  margin-bottom: 20px;
}

.filter-section h4 {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 8px;
  color: var(--text-muted);
}

.checkbox-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.checkbox-item {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 14px;
}

.checkbox-item input {
  cursor: pointer;
}

.type-color {
  width: 12px;
  height: 12px;
  border-radius: 2px;
}
</style>
