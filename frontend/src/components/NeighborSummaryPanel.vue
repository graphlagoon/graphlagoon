<script setup lang="ts">
/**
 * The selected node's neighbours, from what is loaded (hubs-densos F2): one row
 * per (relationship type, direction, neighbour type) with a count, and the
 * split the investigator asks about a hub — neighbours linked to nothing else
 * vs. those with another link. Each row can be selected or grouped into a
 * closed cluster; the leaves can be folded into collections (F1).
 */
import { computed, ref, watch } from 'vue';
import { api } from '@/services/api';
import { useGraphStore } from '@/stores/graph';
import { useClusterStore } from '@/stores/cluster';
import { useToast } from '@/composables/useToast';
import { formatNodeLabel } from '@/utils/labelFormatter';
import { connectorGroups, leafCollections, neighborRowLabel, summarizeNeighbors, type NeighborRow } from '@/utils/neighborSummary';

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

// D5: is a leaf on the canvas a leaf in the source? Asked on demand (one
// aggregate query over up to MAX_CHECK ids), never automatically.
const MAX_CHECK = 5000;
const sourceCheck = ref<{ state: 'idle' | 'loading' | 'done' | 'unsupported' | 'error'; withMore: string[]; checked: number }>({
  state: 'idle',
  withMore: [],
  checked: 0,
});
watch(() => [props.nodeId, graphStore.edges.length], () => {
  sourceCheck.value = { state: 'idle', withMore: [], checked: 0 };
});
const canCheckSource = computed(() => !!graphStore.currentContext && !graphStore.investigationMode);
async function checkSource() {
  const ctx = graphStore.currentContext;
  if (!ctx) return;
  const ids = summary.value.leafIds.slice(0, MAX_CHECK);
  sourceCheck.value = { state: 'loading', withMore: [], checked: ids.length };
  try {
    const r = await api.nodeDegrees(ctx.id, ids);
    if (!r.supported) {
      sourceCheck.value = { state: 'unsupported', withMore: [], checked: ids.length };
      return;
    }
    // A leaf has exactly its edges to the node on the canvas; more in the source = links not loaded.
    const onCanvas = new Map<string, number>();
    for (const e of graphStore.edges) {
      if (e.src === e.dst) continue;
      for (const end of [e.src, e.dst]) onCanvas.set(end, (onCanvas.get(end) ?? 0) + 1);
    }
    const withMore = ids.filter((id) => (r.degrees[id] ?? 0) > (onCanvas.get(id) ?? 0));
    sourceCheck.value = { state: 'done', withMore, checked: ids.length };
  } catch {
    sourceCheck.value = { state: 'error', withMore: [], checked: ids.length };
  }
}
/** Neighbours with another link, grouped by what else they share (connector motif). */
const connectors = computed(() => connectorGroups(props.nodeId, graphStore.edges).slice(0, 5));
const labelOf = (id: string) => {
  const node = graphStore.nodes.find((n) => n.node_id === id);
  return node ? formatNodeLabel(node, graphStore.textFormatRules, graphStore.textFormatDefaults.nodeTemplate) || id : id;
};
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

/** Folds the row's leaves only: neighbours with another link are what the investigation is about. */
function group(row: NeighborRow) {
  if (row.leafIds.length === 0) {
    toast.info('Every neighbour in this row has another link: nothing to fold.');
    return;
  }
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
    node_ids: row.leafIds,
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
            <button
              v-if="row.leafIds.length"
              type="button"
              class="link-btn"
              :title="row.leafIds.length === row.nodeIds.length
                ? 'Fold them into one closed cluster'
                : `Fold the ${row.leafIds.length} with no other link into one closed cluster; the ${row.nodeIds.length - row.leafIds.length} with another link stay on the canvas`"
              :data-testid="`neighbor-group-${row.relationshipType}-${row.direction}-${row.nodeType}`" @click="group(row)">group</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="summary.rows.length > MAX_ROWS" class="muted small">{{ summary.rows.length - MAX_ROWS }} more kinds not listed.</p>

    <table class="nb-table nb-split" data-testid="neighbor-summary-split">
      <tbody>
        <tr>
          <td class="nb-label">No other link loaded</td>
          <td class="nb-num"><strong>{{ summary.leafIds.length.toLocaleString() }}</strong></td>
          <td class="nb-actions">
            <button v-if="summary.leafIds.length" type="button" class="link-btn" title="Select them on the canvas" @click="select(summary.leafIds)">select</button>
          </td>
        </tr>
        <tr>
          <td class="nb-label">Other links</td>
          <td class="nb-num"><strong>{{ summary.linkedIds.length.toLocaleString() }}</strong></td>
          <td class="nb-actions">
            <button
              v-if="summary.linkedIds.length"
              type="button"
              class="link-btn"
              data-testid="neighbor-select-linked"
              title="Select the neighbours that have another link — usually the ones the investigation is about"
              @click="select(summary.linkedIds)"
            >select</button>
          </td>
        </tr>
      </tbody>
    </table>
    <ul v-if="connectors.length" class="nb-connectors" data-testid="neighbor-connectors">
      <li v-for="g in connectors" :key="g.sharedIds.join()" :data-testid="`neighbor-connector-${g.sharedIds.join('-')}`">
        <strong>{{ g.memberIds.length }}</strong> also linked to
        {{ g.sharedIds.slice(0, 3).map(labelOf).join(', ') }}<template v-if="g.sharedIds.length > 3"> +{{ g.sharedIds.length - 3 }}</template>
        <button type="button" class="link-btn" title="Select these neighbours on the canvas" @click="select(g.memberIds)">select</button>
      </li>
    </ul>
    <p class="muted small" data-testid="neighbor-source-check">
      <template v-if="sourceCheck.state === 'done'">
        <template v-if="sourceCheck.withMore.length">
          In the source, <strong>{{ sourceCheck.withMore.length.toLocaleString() }}</strong> of these
          {{ sourceCheck.checked.toLocaleString() }} have links not loaded
          <button type="button" class="link-btn" title="Select them; expand them to load the rest" @click="select(sourceCheck.withMore)">select</button>
        </template>
        <template v-else>Checked in the source: none of the {{ sourceCheck.checked.toLocaleString() }} has another link.</template>
      </template>
      <template v-else-if="sourceCheck.state === 'loading'">Checking the source…</template>
      <template v-else-if="sourceCheck.state === 'unsupported'">This source cannot count links without loading them.</template>
      <template v-else>
        Loaded edges only.
        <button
          v-if="canCheckSource && summary.leafIds.length"
          type="button"
          class="link-btn"
          data-testid="neighbor-check-source"
          :title="`Count the links of ${Math.min(summary.leafIds.length, MAX_CHECK).toLocaleString()} leaves in the source (one query)`"
          @click="checkSource"
        >check the source</button>
        <template v-if="sourceCheck.state === 'error'"> (the check failed)</template>
      </template>
    </p>

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
  margin-top: 8px;
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
.nb-connectors {
  list-style: none;
  padding: 0;
  margin: 4px 0;
  font-size: 12px;
}
.nb-connectors li {
  padding: 1px 0;
}
.nb-collect {
  margin-top: 8px;
}
</style>
