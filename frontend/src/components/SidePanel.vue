<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useItemMetrics } from '@/composables/useItemMetrics';
import { formatMetricValue } from '@/utils/metricFormat';
import { tryParseJson } from '@/utils/jsonDetection';
import { X } from 'lucide-vue-next';
import JsonValueViewer from './JsonValueViewer.vue';
import PropertyVisibilityHint from './PropertyVisibilityHint.vue';
import EmptyValuesHint from './EmptyValuesHint.vue';
import { hideEmpty, isEmptyValue, isEmptyPropertyValue } from '@/utils/emptyValue';

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


const hasSelection = computed(() => {
  return graphStore.selectedNode || graphStore.selectedEdge;
});

// Get column names from context structure
const nodeColumns = computed(() => {
  const struct = graphStore.currentContext?.node_structure;
  return {
    id: struct?.node_id_col || 'node_id',
    type: struct?.node_type_col || 'node_type',
  };
});

const edgeColumns = computed(() => {
  const struct = graphStore.currentContext?.edge_structure;
  return {
    id: struct?.edge_id_col || 'edge_id',
    type: struct?.relationship_type_col || 'relationship_type',
    src: struct?.src_col || 'src',
    dst: struct?.dst_col || 'dst',
  };
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

// Get properties from selected item, pruned by the property allowlist
// (Aesthetics → Property Visibility). The unfiltered count feeds the hint.
const totalPropertyCount = computed(() =>
  selectedItem.value?.data.properties
    ? Object.keys(selectedItem.value.data.properties).length
    : 0,
);

const allowedProperties = computed(() => {
  if (!selectedItem.value?.data.properties) return [];
  const kind = selectedItem.value.type;
  const itemProps = selectedItem.value.data.properties;
  return Object.entries(itemProps)
    .filter(([key]) => graphStore.isPropertyVisible(kind, key))
    .map(([key, value]) => {
      const jsonResult = tryParseJson(value);
      return {
        key,
        value: formatPropertyValue(value),
        rawValue: value,
        isJson: jsonResult.isJson,
        parsedJson: jsonResult.isJson ? jsonResult.parsed : null,
      };
    });
});

// Format property value for display
function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      // Handle array of tuples (like metadata from Spark)
      if (value.length > 0 && Array.isArray(value[0]) && value[0].length === 2) {
        return value.map(([k, v]) => `${k}: ${v}`).join(', ');
      }
      return JSON.stringify(value);
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toString();
    return value.toFixed(4);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

// Computed + custom metrics for the selected item (shared lookup). Deliberately
// the raw list: the section gate and the hint both need the pre-filter count.
const selectedItemMetrics = useItemMetrics(selectedItem);

// "Hide empty values" (Style → Details Display), with a per-surface peek. The
// reveal is local on purpose — flipping the saved setting would dirty the
// exploration just to look at one node. A new selection is a new question.
const revealEmpty = ref(false);
watch(selectedItem, () => { revealEmpty.value = false; });

const hideEmptyEnabled = computed(
  () => graphStore.aesthetics.hideEmptyValues && !revealEmpty.value,
);

const propertySplit = computed(() =>
  hideEmpty(allowedProperties.value, (p) => isEmptyPropertyValue(p.rawValue), hideEmptyEnabled.value),
);
const selectedItemProperties = computed(() => propertySplit.value.kept);

const metricSplit = computed(() =>
  hideEmpty(selectedItemMetrics.value, (m) => isEmptyValue(m.value), hideEmptyEnabled.value),
);

</script>

<template>
  <div v-if="hasSelection" :class="['side-panel', `side-panel--${props.variant}`]">
    <template v-if="selectedItem">
      <div class="panel-header">
        <h3>
          {{ selectedItem.type === 'node' ? 'Node Details' : 'Edge Details' }}
        </h3>
        <div class="panel-header-actions">
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

      <div class="detail-section">
        <template v-if="selectedItem.type === 'node'">
          <div class="detail-row">
            <span class="label">
              ID
              <span class="col-name">({{ nodeColumns.id }})</span>
            </span>
            <span class="value mono" :title="String(selectedItem.data.node_id)">{{ selectedItem.data.node_id }}</span>
          </div>
          <div class="detail-row">
            <span class="label">
              Type
              <span class="col-name">({{ nodeColumns.type }})</span>
            </span>
            <span class="value badge badge-primary" :title="selectedItem.data.node_type">{{ selectedItem.data.node_type }}</span>
          </div>
        </template>

        <template v-else>
          <div class="detail-row">
            <span class="label">
              ID
              <span class="col-name">({{ edgeColumns.id }})</span>
            </span>
            <span class="value mono" :title="String(selectedItem.data.edge_id)">{{ selectedItem.data.edge_id }}</span>
          </div>
          <div class="detail-row">
            <span class="label">
              Type
              <span class="col-name">({{ edgeColumns.type }})</span>
            </span>
            <span class="value badge badge-secondary" :title="selectedItem.data.relationship_type">{{ selectedItem.data.relationship_type }}</span>
          </div>
          <div class="detail-row">
            <span class="label">
              Source
              <span class="col-name">({{ edgeColumns.src }})</span>
            </span>
            <span class="value mono" :title="String(selectedItem.data.src)">{{ selectedItem.data.src }}</span>
          </div>
          <div class="detail-row">
            <span class="label">
              Target
              <span class="col-name">({{ edgeColumns.dst }})</span>
            </span>
            <span class="value mono" :title="String(selectedItem.data.dst)">{{ selectedItem.data.dst }}</span>
          </div>
        </template>
      </div>

      <!-- Properties section: keyed on the unfiltered count so the hint (and
           the way back to "show all") survives even a fully pruned list -->
      <div v-if="totalPropertyCount > 0" class="detail-section">
        <h4>Properties</h4>
        <PropertyVisibilityHint
          :kind="selectedItem.type"
          :visible="allowedProperties.length"
          :total="totalPropertyCount"
        />
        <EmptyValuesHint
          :hidden="propertySplit.hiddenCount"
          :revealed="revealEmpty"
          @toggle="revealEmpty = !revealEmpty"
        />
        <template v-for="prop in selectedItemProperties" :key="prop.key">
          <!-- JSON value: full-width viewer below key -->
          <div v-if="prop.isJson" class="prop-json-block">
            <span class="prop-json-label" :title="prop.key">{{ prop.key }}</span>
            <JsonValueViewer :value="prop.parsedJson" />
          </div>
          <!-- Plain value: key-value row -->
          <div v-else class="detail-row">
            <span class="label prop-label" :title="prop.key">{{ prop.key }}</span>
            <span class="value prop-value-text" :title="String(prop.rawValue)">{{ prop.value }}</span>
          </div>
        </template>
      </div>

      <div v-if="selectedItemMetrics.length > 0" class="detail-section">
        <h4>Computed Metrics</h4>
        <EmptyValuesHint
          :hidden="metricSplit.hiddenCount"
          :revealed="revealEmpty"
          @toggle="revealEmpty = !revealEmpty"
        />
        <div
          v-for="metric in metricSplit.kept"
          :key="metric.name"
          class="detail-row"
        >
          <span class="label" :title="metric.name">{{ metric.name }}</span>
          <span class="value metric-value" :title="String(metric.value)">
            {{ formatMetricValue(metric.value) }}
          </span>
        </div>
      </div>

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

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.panel-header h3 {
  font-size: 16px;
  font-weight: 600;
}

.panel-header-actions {
  display: flex;
  gap: 4px;
  align-items: center;
}

.btn-sm {
  padding: 4px 8px;
  font-size: 14px;
}

.detail-section {
  margin-bottom: 20px;
}

.detail-section h4 {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 12px;
  color: var(--text-muted);
}

.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 14px;
}

.detail-row .label {
  color: var(--text-muted);
  min-width: 60px;
  flex-shrink: 0;
  max-width: 40%;
}

.col-name {
  font-size: 10px;
  color: var(--text-muted, #888);
  font-family: monospace;
}

.detail-row .value {
  text-align: right;
  word-break: break-word;
  overflow-wrap: break-word;
  min-width: 0;
  flex: 1;
}

.mono {
  font-family: monospace;
  font-size: 12px;
}

/* `border-bottom` on a `flex: 1` value stretched the dotted line across the
   whole row, so a metric read like an empty form field. `text-decoration`
   hugs the text instead. */
.metric-value {
  font-family: monospace;
  cursor: help;
  text-decoration: underline dotted var(--text-muted, #888);
  text-underline-offset: 3px;
}

.prop-label {
  font-family: monospace;
  font-size: 11px;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prop-value-text {
  font-family: monospace;
  font-size: 11px;
  word-break: break-word;
  overflow-wrap: break-word;
  white-space: normal;
  cursor: help;
}

.prop-json-block {
  margin-bottom: 12px;
  overflow-x: auto;
  max-width: 100%;
}

.prop-json-label {
  display: block;
  font-family: monospace;
  font-size: 11px;
  color: var(--text-muted, #666);
  margin-bottom: 4px;
}

.empty-text {
  color: var(--text-muted);
  font-size: 14px;
  font-style: italic;
}

</style>
