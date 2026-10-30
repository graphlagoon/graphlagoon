<script setup lang="ts">
/**
 * What a selected node or edge is: its identity rows, its properties (pruned
 * by the property allowlist and "hide empty values", with the hints that lead
 * back) and its computed metrics.
 *
 * One component for both hosts — the exploration's side panel and the case's
 * inspector — so an edge reads the same on either page and a change to how a
 * property is shown lands on both at once.
 */
import { ref, computed, watch } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useItemMetrics, type SelectedGraphItem } from '@/composables/useItemMetrics';
import { formatMetricValue } from '@/utils/metricFormat';
import { tryParseJson } from '@/utils/jsonDetection';
import JsonValueViewer from './JsonValueViewer.vue';
import PropertyVisibilityHint from './PropertyVisibilityHint.vue';
import EmptyValuesHint from './EmptyValuesHint.vue';
import { hideEmpty, isEmptyValue, isEmptyPropertyValue } from '@/utils/emptyValue';

const props = withDefaults(
  defineProps<{
    item: SelectedGraphItem;
    /** The identity rows (id, type, source → target). Off when the host shows them in its own header. */
    showIdentity?: boolean;
    /** Readable name for an endpoint id; with it, source and target are buttons that select the node. */
    labelOf?: (id: string) => string;
    /** Values other sources disagree on (a case's unified graph), by property. */
    conflicts?: Record<string, { value: unknown; sourceId: string }[]> | null;
  }>(),
  { showIdentity: true, labelOf: undefined, conflicts: null },
);

const emit = defineEmits<{ 'select-node': [id: string] }>();

const graphStore = useGraphStore();

// Column names from the context structure; a case has no context, so the
// generic names show.
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

const item = computed(() => props.item);

// Properties, pruned by the property allowlist (Style → Property Visibility).
// The unfiltered count feeds the hint.
const totalPropertyCount = computed(() =>
  item.value.data.properties ? Object.keys(item.value.data.properties).length : 0,
);

const allowedProperties = computed(() => {
  if (!item.value.data.properties) return [];
  const kind = item.value.type;
  const itemProps = item.value.data.properties;
  // Values the user's layer (BYOD-2) set: marked, so they never pass for the context's.
  const data = item.value.data as { node_id?: string; edge_id?: string };
  const fromLayer = graphStore.overlayKeysFor(kind, (kind === 'node' ? data.node_id : data.edge_id) ?? '');
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
        fromLayer: fromLayer.has(key),
        conflicts: props.conflicts?.[key] ?? null,
      };
    });
});

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

// Computed + custom metrics for the item (shared lookup). Deliberately the
// raw list: the section gate and the hint both need the pre-filter count.
const itemMetrics = useItemMetrics(item);

// "Hide empty values" (Style → Details Display), with a per-surface peek. The
// reveal is local on purpose — flipping the saved setting would dirty the
// exploration just to look at one node. A new selection is a new question.
const revealEmpty = ref(false);
watch(() => item.value.data, () => { revealEmpty.value = false; });

const hideEmptyEnabled = computed(
  () => graphStore.aesthetics.hideEmptyValues && !revealEmpty.value,
);

const propertySplit = computed(() =>
  hideEmpty(allowedProperties.value, (p) => isEmptyPropertyValue(p.rawValue), hideEmptyEnabled.value),
);
const shownProperties = computed(() => propertySplit.value.kept);

const metricSplit = computed(() =>
  hideEmpty(itemMetrics.value, (m) => isEmptyValue(m.value), hideEmptyEnabled.value),
);

const endpointLabel = (id: string) => props.labelOf?.(id) ?? id;
</script>

<template>
  <div class="selection-details">
    <div v-if="showIdentity" class="detail-section">
      <template v-if="item.type === 'node'">
        <div class="detail-row">
          <span class="label">
            ID
            <span class="col-name">({{ nodeColumns.id }})</span>
          </span>
          <span class="value mono" :title="String(item.data.node_id)">{{ item.data.node_id }}</span>
        </div>
        <div class="detail-row">
          <span class="label">
            Type
            <span class="col-name">({{ nodeColumns.type }})</span>
          </span>
          <span class="value badge badge-primary" :title="item.data.node_type">{{ item.data.node_type }}</span>
        </div>
      </template>

      <template v-else>
        <div class="detail-row">
          <span class="label">
            ID
            <span class="col-name">({{ edgeColumns.id }})</span>
          </span>
          <span class="value mono" :title="String(item.data.edge_id)">{{ item.data.edge_id }}</span>
        </div>
        <div class="detail-row">
          <span class="label">
            Type
            <span class="col-name">({{ edgeColumns.type }})</span>
          </span>
          <span class="value badge badge-secondary" :title="item.data.relationship_type">{{ item.data.relationship_type }}</span>
        </div>
        <div class="detail-row">
          <span class="label">
            Source
            <span class="col-name">({{ edgeColumns.src }})</span>
          </span>
          <button
            v-if="labelOf"
            class="value link-btn endpoint"
            :title="String(item.data.src)"
            data-testid="selection-details-src"
            @click="emit('select-node', String(item.data.src))"
          >{{ endpointLabel(String(item.data.src)) }}</button>
          <span v-else class="value mono" :title="String(item.data.src)">{{ item.data.src }}</span>
        </div>
        <div class="detail-row">
          <span class="label">
            Target
            <span class="col-name">({{ edgeColumns.dst }})</span>
          </span>
          <button
            v-if="labelOf"
            class="value link-btn endpoint"
            :title="String(item.data.dst)"
            data-testid="selection-details-dst"
            @click="emit('select-node', String(item.data.dst))"
          >{{ endpointLabel(String(item.data.dst)) }}</button>
          <span v-else class="value mono" :title="String(item.data.dst)">{{ item.data.dst }}</span>
        </div>
      </template>
    </div>

    <!-- Properties section: keyed on the unfiltered count so the hint (and
         the way back to "show all") survives even a fully pruned list -->
    <div v-if="totalPropertyCount > 0" class="detail-section">
      <h4>Properties</h4>
      <PropertyVisibilityHint
        :kind="item.type"
        :visible="allowedProperties.length"
        :total="totalPropertyCount"
      />
      <EmptyValuesHint
        :hidden="propertySplit.hiddenCount"
        :revealed="revealEmpty"
        @toggle="revealEmpty = !revealEmpty"
      />
      <template v-for="prop in shownProperties" :key="prop.key">
        <!-- JSON value: full-width viewer below key -->
        <div v-if="prop.isJson" class="prop-json-block">
          <span class="prop-json-label" :title="prop.key">{{ prop.key }}</span>
          <JsonValueViewer :value="prop.parsedJson" />
        </div>
        <!-- Plain value: key-value row -->
        <div v-else class="detail-row">
          <span class="label prop-label" :title="prop.key">{{ prop.key }}</span>
          <span class="value prop-value-text" :title="String(prop.rawValue)">
            {{ prop.value }}
            <span v-if="prop.fromLayer" class="layer-chip" title="From your data on this exploration, not from the context" data-testid="prop-from-layer">your data</span>
            <span v-if="prop.conflicts" class="conflict" title="Other items disagree">≠ {{ prop.conflicts.map((c) => c.value).join(', ') }}</span>
          </span>
        </div>
      </template>
    </div>

    <div v-if="itemMetrics.length > 0" class="detail-section">
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
  </div>
</template>

<style scoped>
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

.link-btn.endpoint {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--color-primary);
  cursor: pointer;
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

.layer-chip {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 10px;
  background: color-mix(in srgb, #f59e0b 18%, transparent);
  color: var(--text-muted);
}

.conflict {
  margin-left: 6px;
  font-size: 10px;
  color: var(--color-warning, #d97706);
}
</style>
