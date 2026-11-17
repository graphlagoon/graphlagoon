<script setup lang="ts">
/**
 * The status bar under a graph canvas, shared by the exploration page and the
 * case: counts, the qualifiers about the graph on screen that come from the
 * stores (properties still loading, a truncated result, clusters) and the
 * shortcuts chip that replaced the hint strip over the canvas. Page-specific
 * chips go in the default slot; a case puts its sources and journal there.
 */
import { computed } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useClusterStore } from '@/stores/cluster';
import { useToolbarStore } from '@/stores/toolbar';

const props = withDefaults(
  defineProps<{
    nodes: number;
    edges: number;
    testId?: string;
    /** The Filters-panel chip; a case has its own filter chips with their own Clear. */
    filterChip?: boolean;
  }>(),
  { testId: 'graph-status-bar', filterChip: true },
);

const emit = defineEmits<{
  /** The truncated chip: open the behaviors (edge limit). */
  'open-behaviors': [];
  /** The clusters chip: list them. */
  'show-clusters': [];
}>();

const graphStore = useGraphStore();
const clusterStore = useClusterStore();
const toolbarStore = useToolbarStore();

const clusterCount = computed(() => clusterStore.clusters.length);

/** Why the automatic leaf arrangement acted, for the chip's tooltip. */
const autoHubLeavesTitle = computed(() => {
  const stats = graphStore.hubLeavesStats;
  if (!stats?.auto) return '';
  const shapes = [
    stats.auto.petals ? `${stats.auto.petals} in petals${stats.autoKeys?.length ? ` by ${stats.autoKeys.join(', ')}` : ''}` : '',
    stats.auto.crown ? `${stats.auto.crown} in a crown` : '',
  ].filter(Boolean).join(', ');
  return `Leaves are on Automatic: ${stats.hubs === 1 ? 'a node has' : `${stats.hubs} nodes have`} ${graphStore.behaviors.hubLeavesMinLeaves} or more neighbours linked to nothing else, so those are laid out next to ${stats.hubs === 1 ? 'it' : 'them'} (${shapes}). Click ✕ to leave them to the simulation (Layout → Hubs with many leaves).`;
});

/** "petals by qualificacao" / "crown": what the automatic arrangement did, said on the chip itself. */
const autoHubLeavesShort = computed(() => {
  const stats = graphStore.hubLeavesStats;
  if (!stats?.auto) return '';
  if (stats.auto.petals && !stats.auto.crown) return stats.autoKeys?.length ? `, petals by ${stats.autoKeys.join(', ')}` : ', petals';
  if (stats.auto.crown && !stats.auto.petals) return ', crown';
  return '';
});

/** The ego ring ordering on Automatic chose sectors (not its fallback). */
const autoEgoSectors = computed(() => {
  if (graphStore.layoutAlgorithm !== 'ego' || graphStore.layoutModeConfig.ego.ringOrdering !== 'auto') return null;
  const auto = graphStore.egoLayoutStats?.autoOrdering;
  if (!auto || auto.ordering === 'barycenter') return null;
  return { by: auto.ordering === 'node-type' ? 'node type' : auto.key ?? '', reason: auto.reason };
});

/** Nodes drawn, when filters or "show only" hide some of the nodes loaded. */
const shownOf = computed(() => {
  const total = graphStore.nodes.length;
  const shown = graphStore.visibleNodeCount;
  return shown < total ? `${shown} of ${total}` : null;
});

/** What the Filters panel hides, in words (types, and the search in hide mode). */
const filterLabel = computed(() => {
  const parts: string[] = [];
  const n = graphStore.hiddenTypeCount;
  if (n) parts.push(`${n} ${n === 1 ? 'type' : 'types'} hidden`);
  if (graphStore.filters.search_query && graphStore.behaviors.searchMode === 'hide') parts.push(`search “${graphStore.filters.search_query}”`);
  return parts.join(' · ');
});

/** How many nodes "show only" keeps, against the nodes loaded. */
const isolationTitle = computed(() => {
  const keep = graphStore.isolatedNodeIds;
  const rule = graphStore.isolation;
  if (!rule) return '';
  const counted = keep ? `${keep.size} of ${graphStore.nodes.length} nodes shown` : 'not applied: what it names is not on the graph';
  const loading = rule.kind === 'value' && graphStore.enriching
    ? ` — ${graphStore.pendingPropertyNodeIds.size} nodes are still loading properties and may join`
    : '';
  return `${counted}${loading}. Click ✕ to show every node.`;
});
</script>

<template>
  <div class="status-bar" :data-testid="props.testId">
    <span data-testid="graph-status-nodes">{{ shownOf ?? nodes }} nodes</span>
    <span>{{ edges }} edges</span>
    <!-- Progressive load: the graph is already interactive here; this only
         explains why some tooltips are still empty. -->
    <span
      v-if="graphStore.enriching"
      class="status-enriching"
      data-testid="graph-status-enriching"
      :title="`Loading properties for ${graphStore.pendingPropertyNodeIds.size} nodes`"
    >
      loading properties…
    </span>
    <!-- The edge result hit its cap, so this graph is a slice of a larger
         one. Worth stating plainly: a truncated graph looks exactly like
         a complete one, and conclusions drawn from it may not hold. -->
    <button
      v-if="graphStore.truncated"
      type="button"
      class="status-chip status-truncated"
      data-testid="graph-status-truncated"
      title="The edge limit was reached — this graph is a partial view. Raise the limit or narrow the query to see more. Click to open Behaviors."
      @click="emit('open-behaviors')"
    >
      ⚠ truncated
    </button>
    <button
      v-if="clusterCount > 0"
      type="button"
      class="status-chip status-item"
      data-testid="graph-status-clusters"
      :title="`${clusterCount} clusters on this graph — click to list them`"
      @click="emit('show-clusters')"
    >
      {{ clusterCount }} clusters
    </button>

    <!-- Automatic adjustments that acted (utils/autoAdjust.ts): what and why on
         hover, ✕ turns that one off. -->
    <span
      v-if="graphStore.hubLeavesStats?.auto"
      class="status-isolation"
      data-testid="status-auto-hub-leaves"
      :title="autoHubLeavesTitle"
    >
      Auto: <strong>{{ graphStore.hubLeavesStats.hubs }}</strong> {{ graphStore.hubLeavesStats.hubs === 1 ? 'hub' : 'hubs' }} arranged{{ autoHubLeavesShort }}
      <button
        type="button"
        class="status-isolation-clear"
        data-testid="status-auto-hub-leaves-off"
        aria-label="Stop arranging leaves automatically"
        @click="graphStore.updateBehaviors({ hubLeaves: 'free' })"
      >✕</button>
    </span>
    <span
      v-if="autoEgoSectors"
      class="status-isolation"
      data-testid="status-auto-ego-ordering"
      :title="`Ring ordering is on Automatic: ${autoEgoSectors.reason}, so the ring is in sectors by ${autoEgoSectors.by}. Click ✕ for fewest crossings (Layout → Ring ordering).`"
    >
      Auto: ring 1 in sectors by <strong>{{ autoEgoSectors.by }}</strong>
      <button
        type="button"
        class="status-isolation-clear"
        data-testid="status-auto-ego-ordering-off"
        aria-label="Order the rings by fewest crossings"
        @click="graphStore.updateLayoutModeConfig({ ego: { ringOrdering: 'barycenter' } })"
      >✕</button>
    </span>

    <!-- Hub leaf arrangement: hub–leaf edges are left out of the drawing. Said
         here so a screenshot never passes them off as absent. -->
    <span
      v-if="graphStore.hubLeavesStats && graphStore.hubLeavesStats.implicitEdges > 0"
      class="status-isolation"
      data-testid="status-hub-edges-implied"
      :title="`${graphStore.hubLeavesStats.leaves} nodes linked only to a hub are laid out next to it; their edges to the hub are shown on hover and selection. Click ✕ to draw them.`"
    >
      <strong>{{ graphStore.hubLeavesStats.implicitEdges }}</strong> hub edges not drawn
      <button
        type="button"
        class="status-isolation-clear"
        data-testid="status-hub-edges-draw"
        aria-label="Draw the hub edges"
        @click="graphStore.updateBehaviors({ hubLeavesImplicitEdges: false })"
      >✕</button>
    </span>

    <span
      v-if="graphStore.hubLeavesStats?.zoomHidden"
      class="status-isolation"
      data-testid="status-hub-leaves-zoom-hidden"
      title="Zoomed out, each hub region shows only its inner leaves; zoom in to see the rest. Click ✕ to show every leaf at any zoom."
    >
      <strong>{{ graphStore.hubLeavesStats.zoomHidden }}</strong> leaves hidden until you zoom in
      <button
        type="button"
        class="status-isolation-clear"
        data-testid="status-hub-leaves-zoom-show"
        aria-label="Show every leaf"
        @click="graphStore.updateBehaviors({ hubLeavesRevealByZoom: 'off' })"
      >✕</button>
    </span>

    <span
      v-if="graphStore.isolation"
      class="status-isolation"
      data-testid="status-isolation"
      :title="isolationTitle"
    >
      Showing only: <strong>{{ graphStore.isolation.label }}</strong>
      <button
        type="button"
        class="status-isolation-clear"
        data-testid="status-isolation-clear"
        aria-label="Show every node"
        @click="graphStore.clearIsolation()"
      >✕</button>
    </span>

    <span v-if="filterChip && filterLabel" class="status-isolation" data-testid="status-filtered" title="The Filters panel hides part of the graph. Click ✕ to show every type.">
      Filtered: <strong>{{ filterLabel }}</strong>
      <button
        type="button"
        class="status-isolation-clear"
        data-testid="status-filtered-clear"
        aria-label="Clear the filters"
        @click="graphStore.resetFilters()"
      >✕</button>
    </span>

    <slot />

    <button
      type="button"
      class="status-chip shortcuts"
      data-testid="graph-status-shortcuts"
      title="Keyboard and mouse shortcuts of the canvas"
      @click="toolbarStore.aboutOpen = true"
    >
      <kbd>?</kbd> Shortcuts
    </button>
  </div>
</template>

<style scoped>
/* Above the loading / error / empty overlays: those cover the canvas, and the
   status bar must stay readable (and clickable) through them. */
.status-bar {
  position: relative;
  z-index: 20;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  padding: 6px 16px;
  border-top: 1px solid var(--border-color);
  background: var(--card-background);
  font-size: 12px;
  color: var(--text-muted);
}

.status-chip {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.status-chip:hover { text-decoration: underline; }
.status-chip:focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: 2px; }

.status-isolation {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 4px 1px 8px;
  border-radius: 10px;
  background: var(--primary-light, rgba(66, 184, 131, 0.12));
  color: var(--text-color);
}

.status-isolation strong {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-isolation-clear {
  border: none;
  background: none;
  padding: 0 4px;
  min-width: 24px;
  min-height: 24px;
  cursor: pointer;
  color: inherit;
  font: inherit;
}

.status-isolation-clear:focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: 2px; }

.status-enriching {
  font-style: italic;
}

.status-truncated {
  color: var(--color-warning, #d97706);
}

.shortcuts {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.shortcuts kbd {
  padding: 0 4px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  font-family: inherit;
  font-size: 10px;
  line-height: 1.4;
}
</style>
