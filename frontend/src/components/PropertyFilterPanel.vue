<script setup lang="ts">
import { ref, computed } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useMetricsStore } from '@/stores/metrics';
import type { PropertyFilter, PropertyFilterOperator } from '@/types/graph';
import { X } from 'lucide-vue-next';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const graphStore = useGraphStore();
const metricsStore = useMetricsStore();

// Active tab: 'nodes' or 'edges'
const activeTab = ref<'nodes' | 'edges'>('nodes');

// New filter form state
const newFilter = ref({
  property: '',
  operator: 'equals' as PropertyFilterOperator,
  value: '',
  values: [] as string[],
  minValue: 0,
  maxValue: 100,
});

// Operator options
const operatorOptions: { value: PropertyFilterOperator; label: string; requiresArray?: boolean; requiresRange?: boolean }[] = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Not Equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'one_of', label: 'One Of', requiresArray: true },
  { value: 'less_than', label: 'Less Than' },
  { value: 'less_than_or_equal', label: 'Less Than or Equal' },
  { value: 'greater_than', label: 'Greater Than' },
  { value: 'greater_than_or_equal', label: 'Greater Than or Equal' },
  { value: 'between', label: 'Between', requiresRange: true },
];

// Get available properties for nodes (metrics only)
const nodePropertyOptions = computed(() => {
  const options: { value: string; label: string; group: string }[] = [];

  // Add computed metrics
  metricsStore.nodeMetrics.forEach(metric => {
    options.push({ value: `metric:${metric.id}`, label: metric.name, group: 'Metrics' });
  });

  return options;
});

// Get available properties for edges (metrics only)
const edgePropertyOptions = computed(() => {
  const options: { value: string; label: string; group: string }[] = [];

  // Add computed metrics
  metricsStore.edgeMetrics.forEach(metric => {
    options.push({ value: `metric:${metric.id}`, label: metric.name, group: 'Metrics' });
  });

  return options;
});

const currentPropertyOptions = computed(() =>
  activeTab.value === 'nodes' ? nodePropertyOptions.value : edgePropertyOptions.value
);

const currentFilters = computed(() =>
  activeTab.value === 'nodes'
    ? graphStore.filters.nodePropertyFilters
    : graphStore.filters.edgePropertyFilters
);

const selectedOperator = computed(() =>
  operatorOptions.find(o => o.value === newFilter.value.operator)
);

// Values input for 'one_of' operator
const valuesInput = ref('');

function addFilter() {
  if (!newFilter.value.property) return;

  const filter: Omit<PropertyFilter, 'id'> = {
    property: newFilter.value.property,
    operator: newFilter.value.operator,
    value: selectedOperator.value?.requiresRange ? null : (parseValueIfNumeric(newFilter.value.value)),
    enabled: true,
  };

  if (selectedOperator.value?.requiresArray) {
    filter.values = valuesInput.value.split(',').map(v => parseValueIfNumeric(v.trim()));
  }

  if (selectedOperator.value?.requiresRange) {
    filter.minValue = newFilter.value.minValue;
    filter.maxValue = newFilter.value.maxValue;
  }

  if (activeTab.value === 'nodes') {
    graphStore.addNodePropertyFilter(filter);
  } else {
    graphStore.addEdgePropertyFilter(filter);
  }

  // Reset form
  newFilter.value = {
    property: '',
    operator: 'equals',
    value: '',
    values: [],
    minValue: 0,
    maxValue: 100,
  };
  valuesInput.value = '';
}

function parseValueIfNumeric(value: string): string | number {
  const num = parseFloat(value);
  return !isNaN(num) && value.trim() !== '' ? num : value;
}

function toggleFilter(filter: PropertyFilter) {
  if (activeTab.value === 'nodes') {
    graphStore.updateNodePropertyFilter(filter.id, { enabled: !filter.enabled });
  } else {
    graphStore.updateEdgePropertyFilter(filter.id, { enabled: !filter.enabled });
  }
}

function removeFilter(filterId: string) {
  if (activeTab.value === 'nodes') {
    graphStore.removeNodePropertyFilter(filterId);
  } else {
    graphStore.removeEdgePropertyFilter(filterId);
  }
}

function getPropertyLabel(property: string): string {
  const options = currentPropertyOptions.value;
  const opt = options.find(o => o.value === property);
  return opt?.label || property;
}

function getOperatorLabel(operator: PropertyFilterOperator): string {
  const opt = operatorOptions.find(o => o.value === operator);
  return opt?.label || operator;
}

function formatFilterValue(filter: PropertyFilter): string {
  if (filter.operator === 'between') {
    return `${filter.minValue} - ${filter.maxValue}`;
  }
  if (filter.operator === 'one_of' && filter.values) {
    return filter.values.join(', ');
  }
  return String(filter.value ?? '');
}

function clearAllFilters() {
  if (activeTab.value === 'nodes') {
    // Copy array before iterating to avoid mutation issues
    const filterIds = graphStore.filters.nodePropertyFilters.map(f => f.id);
    filterIds.forEach(id => {
      graphStore.removeNodePropertyFilter(id);
    });
  } else {
    // Copy array before iterating to avoid mutation issues
    const filterIds = graphStore.filters.edgePropertyFilters.map(f => f.id);
    filterIds.forEach(id => {
      graphStore.removeEdgePropertyFilter(id);
    });
  }
}
</script>

<template>
  <div class="property-filter-panel">
    <div class="panel-header">
      <h3>Property Filters</h3>
      <div class="header-actions">
        <button class="btn btn-outline btn-sm" @click="clearAllFilters">Clear All</button>
        <button class="btn-icon-only close-btn" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <button
        class="tab"
        :class="{ active: activeTab === 'nodes' }"
        @click="activeTab = 'nodes'"
      >
        Nodes
        <span v-if="graphStore.filters.nodePropertyFilters.length > 0" class="badge">
          {{ graphStore.filters.nodePropertyFilters.length }}
        </span>
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'edges' }"
        @click="activeTab = 'edges'"
      >
        Edges
        <span v-if="graphStore.filters.edgePropertyFilters.length > 0" class="badge">
          {{ graphStore.filters.edgePropertyFilters.length }}
        </span>
      </button>
    </div>

    <!-- Active Filters -->
    <div class="filter-section">
      <h4>Active Filters</h4>
      <div v-if="currentFilters.length === 0" class="empty-text">
        No filters applied
      </div>
      <div v-else class="filter-list">
        <div
          v-for="filter in currentFilters"
          :key="filter.id"
          class="filter-item"
          :class="{ disabled: !filter.enabled }"
        >
          <div class="filter-info">
            <input
              type="checkbox"
              :checked="filter.enabled"
              @change="toggleFilter(filter)"
            />
            <span class="filter-property">{{ getPropertyLabel(filter.property) }}</span>
            <span class="filter-operator">{{ getOperatorLabel(filter.operator) }}</span>
            <span class="filter-value">{{ formatFilterValue(filter) }}</span>
          </div>
          <button class="remove-btn btn-icon-only" @click="removeFilter(filter.id)" title="Remove filter"><X :size="14" /></button>
        </div>
      </div>
    </div>

    <!-- Add New Filter -->
    <div class="filter-section">
      <h4>Add Filter</h4>

      <div class="form-group">
        <label>Property</label>
        <select v-model="newFilter.property" class="form-control">
          <option value="">Select property...</option>
          <optgroup
            v-for="group in ['Properties', 'Metrics']"
            :key="group"
            :label="group"
          >
            <option
              v-for="opt in currentPropertyOptions.filter(o => o.group === group)"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
          </optgroup>
        </select>
      </div>

      <div class="form-group">
        <label>Operator</label>
        <select v-model="newFilter.operator" class="form-control">
          <option
            v-for="op in operatorOptions"
            :key="op.value"
            :value="op.value"
          >
            {{ op.label }}
          </option>
        </select>
      </div>

      <!-- Single value input -->
      <div v-if="!selectedOperator?.requiresArray && !selectedOperator?.requiresRange" class="form-group">
        <label>Value</label>
        <input
          v-model="newFilter.value"
          class="form-control"
          placeholder="Enter value..."
        />
      </div>

      <!-- Multiple values input (for one_of) -->
      <div v-if="selectedOperator?.requiresArray" class="form-group">
        <label>Values (comma-separated)</label>
        <input
          v-model="valuesInput"
          class="form-control"
          placeholder="value1, value2, value3..."
        />
      </div>

      <!-- Range inputs (for between) -->
      <div v-if="selectedOperator?.requiresRange" class="form-row">
        <div class="form-group half">
          <label>Min</label>
          <input
            v-model.number="newFilter.minValue"
            type="number"
            class="form-control"
          />
        </div>
        <div class="form-group half">
          <label>Max</label>
          <input
            v-model.number="newFilter.maxValue"
            type="number"
            class="form-control"
          />
        </div>
      </div>

      <button
        class="btn btn-primary btn-block"
        :disabled="!newFilter.property"
        @click="addFilter"
      >
        Add Filter
      </button>
    </div>
  </div>
</template>

<style scoped>
.property-filter-panel {
  width: 280px;
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

.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 8px;
}

.tab {
  flex: 1;
  padding: 8px 12px;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all 0.15s;
}

.tab:hover {
  background: var(--bg-secondary, #f5f5f5);
}

.tab.active {
  background: var(--primary-color, #42b883);
  color: white;
  border-color: var(--primary-color, #42b883);
}

.tab .badge {
  background: rgba(255, 255, 255, 0.3);
  padding: 2px 6px;
  border-radius: 10px;
  font-size: 11px;
}

.tab.active .badge {
  background: rgba(255, 255, 255, 0.3);
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

.empty-text {
  font-size: 13px;
  color: var(--text-muted);
  font-style: italic;
}

.filter-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.filter-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px;
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 6px;
  font-size: 12px;
}

.filter-item.disabled {
  opacity: 0.5;
}

.filter-info {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex: 1;
}

.filter-info input[type="checkbox"] {
  cursor: pointer;
}

.filter-property {
  font-weight: 500;
  color: var(--primary-color, #42b883);
}

.filter-operator {
  color: var(--text-muted);
}

.filter-value {
  font-family: monospace;
  background: var(--card-background);
  padding: 2px 6px;
  border-radius: 3px;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remove-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 16px;
  padding: 0 4px;
  line-height: 1;
}

.remove-btn:hover {
  color: #ff6b6b;
}

.form-group {
  margin-bottom: 12px;
}

.form-group label {
  display: block;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.form-control {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 13px;
  background: var(--card-background);
}

.form-control:focus {
  outline: none;
  border-color: var(--primary-color, #42b883);
}

.form-row {
  display: flex;
  gap: 8px;
}

.form-group.half {
  flex: 1;
}

.btn {
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
  border: 1px solid transparent;
}

.btn-outline {
  background: transparent;
  border-color: var(--border-color);
  color: var(--text-color);
}

.btn-outline:hover {
  background: var(--bg-secondary, #f0f0f0);
}

.btn-primary {
  background: var(--primary-color, #42b883);
  color: white;
  border-color: var(--primary-color, #42b883);
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-block {
  width: 100%;
}
</style>
