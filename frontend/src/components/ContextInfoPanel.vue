<script setup lang="ts">
import { computed } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useSchemaDrift } from '@/composables/useSchemaDrift';
import {
  useDatasourceCapabilities,
  useDatasourceDescriptor,
} from '@/composables/useDatasourceCapabilities';
import SchemaDriftBanner from '@/components/SchemaDriftBanner.vue';
import { X, SearchCheck } from 'lucide-vue-next';

defineEmits<{
  close: [];
  'review-schema': [];
}>();

const graphStore = useGraphStore();

// User-initiated only — no automatic check on graph load (two DESCRIBEs on
// every open is real cost for a rare event). Shares its cache with the
// ContextsView row action and the query-error CTA via useSchemaDrift.
const { state: schemaDriftState, check: checkSchemaDrift } = useSchemaDrift();
const drift = computed(() =>
  graphStore.currentContext ? schemaDriftState(graphStore.currentContext.id).drift : null,
);
const checking = computed(() =>
  graphStore.currentContext ? schemaDriftState(graphStore.currentContext.id).loading : false,
);

function checkSchema() {
  if (graphStore.currentContext) void checkSchemaDrift(graphStore.currentContext.id);
}

const capabilities = useDatasourceCapabilities(
  computed(() => graphStore.currentContext),
);
const datasourceDescriptor = useDatasourceDescriptor(
  computed(() => graphStore.currentContext),
);
const datasourceLabel = computed(() => datasourceDescriptor.value.copy.label);
/** The workload this context is served by — what to expect from its results. */
const datasourceTagline = computed(() => datasourceDescriptor.value.copy.tagline);
</script>

<template>
  <div class="context-info-panel">
    <div class="panel-header">
      <h3>Context Info</h3>
      <button class="btn-icon-only close-btn" aria-label="Close" @click="$emit('close')"><X :size="16" /></button>
    </div>

    <div class="panel-content" v-if="graphStore.currentContext">
      <SchemaDriftBanner
        v-if="capabilities.supportsDrift && drift"
        :status="drift.status"
        :counts="drift.counts"
        class="drift-banner-slot"
        @review="$emit('review-schema')"
      />
      <button
        v-else-if="capabilities.supportsDrift"
        type="button"
        class="check-schema-btn"
        data-testid="context-info-check-schema"
        :disabled="checking"
        @click="checkSchema"
      >
        <SearchCheck :size="13" /> {{ checking ? 'Checking schema…' : 'Check schema' }}
      </button>

      <div class="info-section">
        <h4>General</h4>
        <div class="info-row">
          <span class="label">Title</span>
          <span class="value">{{ graphStore.currentContext.title }}</span>
        </div>
        <div class="info-row" v-if="graphStore.currentContext.description">
          <span class="label">Description</span>
          <span class="value">{{ graphStore.currentContext.description }}</span>
        </div>
        <div class="info-row" v-if="graphStore.currentContext.tags?.length">
          <span class="label">Tags</span>
          <span class="value">{{ graphStore.currentContext.tags.join(', ') }}</span>
        </div>
        <div class="info-row">
          <span class="label">Datasource</span>
          <span class="value">
            {{ datasourceLabel }}
            <span class="value-note">{{ datasourceTagline }}</span>
          </span>
        </div>
      </div>

      <div class="info-section" v-if="capabilities.supportsCatalog">
        <h4>Tables</h4>
        <div class="info-row">
          <span class="label">Edge Table</span>
          <span class="value mono">{{ graphStore.currentContext.edge_table_name }}</span>
        </div>
        <div class="info-row">
          <span class="label">Node Table</span>
          <span class="value mono">{{
            graphStore.currentContext.node_table_name || 'derived from edges'
          }}</span>
        </div>
      </div>

      <div
        class="info-section"
        v-if="capabilities.supportsCatalog && graphStore.currentContext.node_structure"
      >
        <h4>Node Structure</h4>
        <div class="info-row">
          <span class="label">Node ID</span>
          <span class="value mono">{{ graphStore.currentContext.node_structure.node_id_col }}</span>
        </div>
        <div class="info-row">
          <span class="label">Node Type</span>
          <span class="value mono">{{ graphStore.currentContext.node_structure.node_type_col }}</span>
        </div>
      </div>

      <div
        class="info-section"
        v-if="capabilities.supportsCatalog && graphStore.currentContext.edge_structure"
      >
        <h4>Edge Structure</h4>
        <div class="info-row">
          <span class="label">Edge ID</span>
          <span class="value mono">{{ graphStore.currentContext.edge_structure.edge_id_col }}</span>
        </div>
        <div class="info-row">
          <span class="label">Source</span>
          <span class="value mono">{{ graphStore.currentContext.edge_structure.src_col }}</span>
        </div>
        <div class="info-row">
          <span class="label">Target</span>
          <span class="value mono">{{ graphStore.currentContext.edge_structure.dst_col }}</span>
        </div>
        <div class="info-row">
          <span class="label">Relationship</span>
          <span class="value mono">{{ graphStore.currentContext.edge_structure.relationship_type_col }}</span>
        </div>
      </div>

      <div class="info-section" v-if="graphStore.currentContext.node_properties?.length">
        <h4>Node Properties</h4>
        <div class="info-row" v-for="prop in graphStore.currentContext.node_properties" :key="prop.name">
          <span class="label">{{ prop.display_name || prop.name }}</span>
          <span class="value mono">{{ prop.data_type }}</span>
        </div>
      </div>

      <div class="info-section" v-if="graphStore.currentContext.edge_properties?.length">
        <h4>Edge Properties</h4>
        <div class="info-row" v-for="prop in graphStore.currentContext.edge_properties" :key="prop.name">
          <span class="label">{{ prop.display_name || prop.name }}</span>
          <span class="value mono">{{ prop.data_type }}</span>
        </div>
      </div>

      <div class="info-section">
        <h4>Statistics</h4>
        <div class="info-row">
          <span class="label">Loaded Nodes</span>
          <span class="value">{{ graphStore.nodes.length }}</span>
        </div>
        <div class="info-row">
          <span class="label">Loaded Edges</span>
          <span class="value">{{ graphStore.edges.length }}</span>
        </div>
        <div class="info-row">
          <span class="label">Filtered Nodes</span>
          <span class="value">{{ graphStore.filteredNodes.length }}</span>
        </div>
        <div class="info-row">
          <span class="label">Filtered Edges</span>
          <span class="value">{{ graphStore.filteredEdges.length }}</span>
        </div>
        <div class="info-row">
          <span class="label">Node Types</span>
          <span class="value">{{ graphStore.nodeTypes.join(', ') || '-' }}</span>
        </div>
        <div class="info-row">
          <span class="label">Edge Types</span>
          <span class="value">{{ graphStore.edgeTypes.join(', ') || '-' }}</span>
        </div>
      </div>
    </div>

    <div class="panel-content" v-else>
      <p class="no-context">No context loaded</p>
    </div>
  </div>
</template>

<style scoped>
.context-info-panel {
  position: absolute;
  top: 16px;
  left: 16px;
  width: 300px;
  max-height: calc(100% - 120px);
  background: var(--card-background, white);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  z-index: 25;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color, #eee);
  background: var(--bg-secondary, #f8f9fa);
}

.panel-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-color, #333);
}

.close-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 18px;
  color: var(--text-muted, #666);
  transition: all 0.15s;
}

.close-btn:hover {
  background: var(--border-color, #ddd);
  color: var(--text-color, #333);
}

.panel-content {
  padding: 12px 16px;
  overflow-y: auto;
  flex: 1;
}

.drift-banner-slot {
  margin-bottom: 12px;
}

.check-schema-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  margin-bottom: 12px;
  background: var(--bg-secondary, #f5f5f5);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-color, #333);
  cursor: pointer;
}

.check-schema-btn:hover {
  background: var(--bg-tertiary, #ebebeb);
}

.check-schema-btn:disabled {
  cursor: default;
  opacity: 0.7;
}

.info-section {
  margin-bottom: 16px;
}

.info-section:last-child {
  margin-bottom: 0;
}

.info-section h4 {
  font-size: 11px;
  font-weight: 600;
  margin: 0 0 8px 0;
  color: var(--text-muted, #666);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 6px;
  font-size: 12px;
}

.info-row .label {
  color: var(--text-muted, #666);
  min-width: 80px;
  flex-shrink: 0;
}

.info-row .value {
  text-align: right;
  word-break: break-all;
  color: var(--text-color, #333);
}

/* Second line under a value: the workload, so results read in context. */
.value-note {
  display: block;
  font-size: 10px;
  color: var(--text-muted, #888);
}

.mono {
  font-family: monospace;
  font-size: 11px;
  background: var(--bg-secondary, #f5f5f5);
  padding: 2px 4px;
  border-radius: 3px;
}

.no-context {
  color: var(--text-muted, #888);
  font-size: 13px;
  font-style: italic;
  margin: 0;
  text-align: center;
  padding: 20px 0;
}
</style>
