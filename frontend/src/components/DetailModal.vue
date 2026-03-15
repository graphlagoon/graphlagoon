<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Node, Edge } from '@/types/graph';
import { useGraphStore } from '@/stores/graph';
import { useMetricsStore } from '@/stores/metrics';
import { X } from 'lucide-vue-next';
import { tryParseJson } from '@/utils/jsonDetection';
import JsonValueViewer from './JsonValueViewer.vue';

const props = defineProps<{
  item: { type: 'node'; data: Node } | { type: 'edge'; data: Edge } | null;
}>();

const emit = defineEmits<{
  close: [];
}>();

const graphStore = useGraphStore();
const metricsStore = useMetricsStore();

const copiedKey = ref<string | null>(null);

const isVisible = computed(() => props.item !== null);

// Column names from context
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

// Basic fields (ID, type, src/dst)
const basicFields = computed(() => {
  if (!props.item) return [];
  if (props.item.type === 'node') {
    const n = props.item.data;
    return [
      { label: 'ID', colName: nodeColumns.value.id, value: n.node_id },
      { label: 'Type', colName: nodeColumns.value.type, value: n.node_type },
    ];
  } else {
    const e = props.item.data;
    return [
      { label: 'ID', colName: edgeColumns.value.id, value: e.edge_id },
      { label: 'Type', colName: edgeColumns.value.type, value: e.relationship_type },
      { label: 'Source', colName: edgeColumns.value.src, value: e.src },
      { label: 'Target', colName: edgeColumns.value.dst, value: e.dst },
    ];
  }
});

// Properties as structured entries
const properties = computed(() => {
  if (!props.item?.data.properties) return [];
  return Object.entries(props.item.data.properties).map(([key, value]) => {
    const jsonResult = tryParseJson(value);
    return {
      key,
      value,
      displayValue: formatValue(value),
      isJsonValue: jsonResult.isJson,
      parsedJson: jsonResult.isJson ? jsonResult.parsed : null,
    };
  });
});

// Computed metrics
const metrics = computed(() => {
  if (!props.item) return [];
  const id = props.item.type === 'node'
    ? props.item.data.node_id
    : props.item.data.edge_id;
  const targetMetrics = props.item.type === 'node'
    ? metricsStore.nodeMetrics
    : metricsStore.edgeMetrics;
  const result: { name: string; value: number }[] = [];
  for (const metric of targetMetrics) {
    const v = metric.values.get(id);
    if (v !== undefined) result.push({ name: metric.name, value: v });
  }
  return result;
});

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toString();
    return value.toFixed(6);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function formatMetricValue(value: number): string {
  if (Math.abs(value) < 0.0001) return value.toExponential(4);
  if (Math.abs(value) >= 1000) return value.toFixed(2);
  if (Math.abs(value) >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

function copyValue(key: string, value: unknown) {
  const text = typeof value === 'object' && value !== null
    ? JSON.stringify(value, null, 2)
    : String(value);
  navigator.clipboard.writeText(text);
  copiedKey.value = key;
  setTimeout(() => {
    if (copiedKey.value === key) copiedKey.value = null;
  }, 1500);
}

function copyAll() {
  if (!props.item) return;
  const data: Record<string, unknown> = {};

  // Basic fields
  for (const f of basicFields.value) {
    data[f.label] = f.value;
  }

  // Properties
  if (props.item.data.properties) {
    data['properties'] = props.item.data.properties;
  }

  // Metrics
  if (metrics.value.length > 0) {
    const m: Record<string, number> = {};
    for (const metric of metrics.value) {
      m[metric.name] = metric.value;
    }
    data['metrics'] = m;
  }

  navigator.clipboard.writeText(JSON.stringify(data, null, 2));
  copiedKey.value = '__all__';
  setTimeout(() => {
    if (copiedKey.value === '__all__') copiedKey.value = null;
  }, 1500);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="isVisible" class="modal-overlay" @click.self="emit('close')">
      <div class="modal-content">
        <div class="modal-header">
          <h3>
            {{ item?.type === 'node' ? 'Node' : 'Edge' }} Details
          </h3>
          <button class="close-btn btn-icon-only" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
        </div>

        <div class="modal-body">
          <!-- Basic fields -->
          <div class="section">
            <div class="section-header">
              <h4>Basic Info</h4>
            </div>
            <table class="props-table">
              <tbody>
                <tr v-for="field in basicFields" :key="field.label">
                  <td class="prop-key">
                    {{ field.label }}
                    <span class="col-hint">{{ field.colName }}</span>
                  </td>
                  <td class="prop-val mono">{{ field.value }}</td>
                  <td class="prop-action">
                    <button
                      class="copy-btn"
                      @click="copyValue(field.label, field.value)"
                      :title="'Copy ' + field.label"
                    >
                      {{ copiedKey === field.label ? '&#10003;' : 'Copy' }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Properties -->
          <div v-if="properties.length > 0" class="section">
            <div class="section-header">
              <h4>Properties ({{ properties.length }})</h4>
            </div>
            <table class="props-table">
              <tbody>
                <tr v-for="prop in properties" :key="prop.key" :class="{ 'complex-row': prop.isJsonValue }">
                  <td class="prop-key">{{ prop.key }}</td>
                  <td class="prop-val mono">
                    <JsonValueViewer v-if="prop.isJsonValue" :value="prop.parsedJson" />
                    <span v-else>{{ prop.displayValue }}</span>
                  </td>
                  <td class="prop-action">
                    <button
                      class="copy-btn"
                      @click="copyValue('prop_' + prop.key, prop.value)"
                      :title="'Copy ' + prop.key"
                    >
                      {{ copiedKey === 'prop_' + prop.key ? '&#10003;' : 'Copy' }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Metrics -->
          <div v-if="metrics.length > 0" class="section">
            <div class="section-header">
              <h4>Computed Metrics</h4>
            </div>
            <table class="props-table">
              <tbody>
                <tr v-for="m in metrics" :key="m.name">
                  <td class="prop-key">{{ m.name }}</td>
                  <td class="prop-val mono">{{ formatMetricValue(m.value) }}</td>
                  <td class="prop-action">
                    <button
                      class="copy-btn"
                      @click="copyValue('metric_' + m.name, m.value)"
                      :title="'Copy ' + m.name"
                    >
                      {{ copiedKey === 'metric_' + m.name ? '&#10003;' : 'Copy' }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="modal-footer">
          <button class="copy-all-btn" @click="copyAll">
            {{ copiedKey === '__all__' ? 'Copied!' : 'Copy All (JSON)' }}
          </button>
          <button class="dismiss-btn" @click="emit('close')">
            Close
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.modal-content {
  background: var(--card-background, white);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
  max-width: 700px;
  width: 90%;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color, #eee);
}

.modal-header h3 {
  margin: 0;
  font-size: 18px;
  color: var(--text-primary, #333);
}

.close-btn {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--text-muted, #666);
  padding: 0;
  line-height: 1;
}

.close-btn:hover {
  color: var(--text-primary, #333);
}

.modal-body {
  padding: 16px 20px;
  overflow-y: auto;
  flex: 1;
}

.section {
  margin-bottom: 20px;
}

.section:last-child {
  margin-bottom: 0;
}

.section-header {
  margin-bottom: 8px;
}

.section-header h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-muted, #666);
  letter-spacing: 0.5px;
}

.props-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.props-table tr {
  border-bottom: 1px solid var(--border-color, #eee);
}

.props-table tr:last-child {
  border-bottom: none;
}

.prop-key {
  padding: 8px 12px 8px 0;
  color: var(--text-muted, #666);
  font-weight: 500;
  white-space: nowrap;
  vertical-align: top;
  min-width: 100px;
  max-width: 180px;
  word-break: break-word;
  white-space: normal;
}

.col-hint {
  display: block;
  font-size: 10px;
  font-family: monospace;
  color: var(--text-muted, #999);
  font-weight: 400;
}

.prop-val {
  padding: 8px 12px 8px 0;
  color: var(--text-primary, #333);
  word-break: break-word;
  vertical-align: top;
}

.mono {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
}

.json-block {
  margin: 0;
  padding: 8px 12px;
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}

.prop-action {
  padding: 8px 0;
  vertical-align: top;
  text-align: right;
  white-space: nowrap;
}

.copy-btn {
  padding: 2px 8px;
  font-size: 11px;
  background: var(--card-background, white);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-muted, #666);
}

.copy-btn:hover {
  background: var(--bg-secondary, #f0f0f0);
}

.complex-row .prop-val {
  padding-top: 4px;
}

.modal-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--border-color, #eee);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.copy-all-btn {
  padding: 8px 16px;
  background: var(--bg-secondary, #f0f0f0);
  color: var(--text-primary, #333);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s;
}

.copy-all-btn:hover {
  background: var(--bg-tertiary, #e0e0e0);
}

.dismiss-btn {
  padding: 8px 20px;
  background: var(--primary-color, #42b883);
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s;
}

.dismiss-btn:hover {
  background: var(--primary-hover, #3aa876);
}
</style>
