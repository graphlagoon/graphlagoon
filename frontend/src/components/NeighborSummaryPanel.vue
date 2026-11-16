<script setup lang="ts">
/**
 * The selected node's neighbours, from what is loaded (hubs-densos F2): one row
 * per (relationship type, direction, neighbour type) with a count, and the
 * split the investigator asks about a hub — neighbours linked to nothing else
 * vs. those with another link. Each row can be selected or grouped into a
 * closed cluster; the leaves can be folded into collections (F1).
 */
import { computed } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useClusterStore } from '@/stores/cluster';
import { useToast } from '@/composables/useToast';
import { formatNodeLabel } from '@/utils/labelFormatter';
import { leafCollections, neighborRowLabel, summarizeNeighbors, type NeighborRow } from '@/utils/neighborSummary';

const props = defineProps<{ nodeId: string }>();

const graphStore = useGraphStore();
const clusterStore = useClusterStore();
const toast = useToast();

const MIN_COLLECTION = 5;
const MAX_ROWS = 12;

const summary = computed(() => {
  const typeOf = new Map(graphStore.nodes.map((n) => [n.node_id, n.node_type]));
  return summarizeNeighbors(props.nodeId, graphStore.edges, (id) => typeOf.get(id) ?? 'Node');
});
const total = computed(() => graphStore.expandTotals.get(props.nodeId));
const collections = computed(() => clusterStore.collectionsOf(props.nodeId));
const canCollect = computed(() => leafCollections(summary.value, MIN_COLLECTION).length > 0);

const hubLabel = computed(() => {
  const node = graphStore.nodes.find((n) => n.node_id === props.nodeId);
  if (!node) return props.nodeId;
  return formatNodeLabel(node, graphStore.textFormatRules, graphStore.textFormatDefaults.nodeTemplate) || props.nodeId;
});

function select(ids: string[]) {
  graphStore.clearSelection();
  for (const id of ids) graphStore.selectedNodeIds.add(id);
}

function group(row: NeighborRow) {
  const id = `neighbors:${props.nodeId}:${row.key.replace(/\u0000/g, ':')}`;
  if (clusterStore.clusters.some((c) => c.cluster_id === id)) {
    toast.info('Already grouped.');
    return;
  }
  clusterStore.createCluster({
    cluster_id: id,
    cluster_name: `${neighborRowLabel(row)} of ${hubLabel.value}`,
    cluster_class: 'neighbors',
    figure: 'circle',
    state: 'closed',
    node_ids: row.nodeIds,
    color: '#8b5cf6',
  });
}

function collect() {
  const made = clusterStore.groupLeafNeighbors(props.nodeId, hubLabel.value, MIN_COLLECTION);
  toast.success(`${made.length} ${made.length === 1 ? 'collection' : 'collections'} of leaf neighbours.`);
}
</script>

<template>
  <div v-if="summary.neighbors > 0" class="detail-section neighbor-summary" data-testid="neighbor-summary">
    <h4>
      Neighbors
      <span class="muted" data-testid="neighbor-summary-count">
        {{ summary.neighbors.toLocaleString() }}<template v-if="total !== undefined && total > summary.edges">
          · {{ summary.edges.toLocaleString() }} of {{ total.toLocaleString() }} edges loaded</template>
      </span>
    </h4>

    <table class="nb-table">
      <tbody>
        <tr v-for="row in summary.rows.slice(0, MAX_ROWS)" :key="row.key" :data-testid="`neighbor-row-${row.relationshipType}-${row.direction}-${row.nodeType}`">
          <td class="nb-label" :title="neighborRowLabel(row)">{{ neighborRowLabel(row) }}</td>
          <td class="nb-num">{{ row.nodeIds.length.toLocaleString() }}</td>
          <td class="nb-actions">
            <button type="button" class="link-btn" title="Select these neighbours on the canvas" @click="select(row.nodeIds)">select</button>
            <button type="button" class="link-btn" title="Fold them into one closed cluster" :data-testid="`neighbor-group-${row.relationshipType}-${row.direction}-${row.nodeType}`" @click="group(row)">group</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="summary.rows.length > MAX_ROWS" class="muted small">{{ summary.rows.length - MAX_ROWS }} more kinds not listed.</p>

    <p class="nb-split" data-testid="neighbor-summary-split">
      Linked to nothing else: <strong>{{ summary.leafIds.length.toLocaleString() }}</strong>
      · with another link: <strong>{{ summary.linkedIds.length.toLocaleString() }}</strong>
      <button
        v-if="summary.linkedIds.length"
        type="button"
        class="link-btn"
        data-testid="neighbor-select-linked"
        title="Select the neighbours that have another link — usually the ones the investigation is about"
        @click="select(summary.linkedIds)"
      >select</button>
    </p>
    <p class="muted small">Among the loaded nodes: a neighbour may have links not loaded yet.</p>

    <div class="nb-collect">
      <button
        v-if="collections.length"
        type="button"
        class="btn btn-outline btn-sm"
        data-testid="neighbor-ungroup-leaves"
        @click="clusterStore.ungroupLeafNeighbors(nodeId)"
      >Ungroup leaf neighbors ({{ collections.length }})</button>
      <button
        v-else-if="canCollect"
        type="button"
        class="btn btn-outline btn-sm"
        data-testid="neighbor-group-leaves"
        title="One closed cluster per kind of leaf neighbour (5 or more); neighbours with another link stay on the canvas"
        @click="collect"
      >Group leaf neighbors</button>
    </div>
  </div>
</template>

<style scoped>
.neighbor-summary h4 {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 8px;
  color: var(--text-muted);
}
.muted {
  color: var(--text-muted);
  font-weight: 400;
}
.small {
  font-size: 11px;
  margin: 4px 0;
}
.nb-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.nb-table td {
  padding: 3px 2px;
  border-bottom: 1px solid var(--border-color, #eee);
  vertical-align: top;
}
.nb-label {
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nb-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  padding-right: 6px;
}
.nb-actions {
  white-space: nowrap;
  text-align: right;
}
.nb-split {
  font-size: 12px;
  margin: 8px 0 2px;
}
.link-btn {
  padding: 0 3px;
  border: none;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--color-primary);
  cursor: pointer;
}
.link-btn:hover {
  text-decoration: underline;
}
.nb-collect {
  margin-top: 8px;
}
</style>
