<script setup lang="ts">
import { ref, computed } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useCommunityStore } from '@/stores/community';
import { useSimilarityStore } from '@/stores/similarity';
import type { LayoutAlgorithm, RingOrdering, CrossingHeuristic } from '@/types/graph';
import { Play, Square, Flame, Shuffle, ChevronDown, ChevronRight, HelpCircle, X } from 'lucide-vue-next';

const graphStore = useGraphStore();
const communityStore = useCommunityStore();
const similarityStore = useSimilarityStore();

// Help modal state
const showHelpModal = ref(false);
// Advanced mode toggle for 3D settings
const showAdvanced = ref(false);
// Advanced disclosure for the ego block (ring geometry / edge drawing refinements)
const showEgoAdvanced = ref(false);

const emit = defineEmits<{
  (e: 'start-layout'): void;
  (e: 'stop-layout'): void;
  (e: 'reheat-layout'): void;
  (e: 'scramble-layout'): void;
  (e: 'start-edge-type-layout', edgeType: string | null, strategy: string): void;
}>();

const props = defineProps<{
  isLayoutRunning: boolean;
}>();

function toggleLayout() {
  if (props.isLayoutRunning) {
    emit('stop-layout');
  } else {
    emit('start-layout');
  }
}

// ---------------------------------------------------------------------------
// Layout mode selector
// ---------------------------------------------------------------------------

const LAYOUT_OPTIONS: { id: LayoutAlgorithm; label: string; icon: string }[] = [
  { id: 'force', label: 'Force', icon: '🌀' },
  { id: 'ego', label: 'Ego Network', icon: '🎯' },
  { id: 'hive', label: 'Hive Plot', icon: '🕸️' },
  { id: 'hierarchical', label: 'Hierarchical', icon: '🌳' },
];

const layoutMode = computed(() => graphStore.layoutAlgorithm);
const egoConfig = computed(() => graphStore.layoutModeConfig.ego);
const hiveConfig = computed(() => graphStore.layoutModeConfig.hive);

function selectLayout(mode: LayoutAlgorithm) {
  graphStore.setLayoutAlgorithm(mode);
}

// ---------------------------------------------------------------------------
// Ego mode
// ---------------------------------------------------------------------------

const egoFocusLabel = computed(() => {
  const id = egoConfig.value.focusNodeId;
  if (!id) return null;
  return id.length > 20 ? id.slice(0, 20) + '...' : id;
});

function useSelectedAsFocus() {
  const selected = graphStore.selectedNode;
  if (!selected) return;
  graphStore.updateLayoutModeConfig({ ego: { focusNodeId: selected.node_id } });
}

const egoUsesAllEdgeTypes = computed(() => egoConfig.value.edgeTypes === null);

function toggleEgoAllEdgeTypes(checked: boolean) {
  graphStore.updateLayoutModeConfig({ ego: { edgeTypes: checked ? null : [...graphStore.edgeTypes] } });
}

function toggleEgoEdgeType(edgeType: string, checked: boolean) {
  const current = egoConfig.value.edgeTypes ?? [...graphStore.edgeTypes];
  const next = checked ? [...new Set([...current, edgeType])] : current.filter((t) => t !== edgeType);
  graphStore.updateLayoutModeConfig({ ego: { edgeTypes: next } });
}

// Slider convention: 0 = no hop limit (∞)
function setEgoMaxHops(raw: number) {
  graphStore.updateLayoutModeConfig({ ego: { maxHops: raw === 0 ? null : raw } });
}

/**
 * How many nodes actually carry the attribute the chosen sector strategy groups
 * by. Graphs here are heterogeneous — a node may simply not have the field — so
 * the panel reports coverage instead of letting the layout degrade silently.
 */
const egoSectorCoverage = computed(() => {
  const ordering = egoConfig.value.ringOrdering;
  const nodes = graphStore.nodes;
  if (ordering === 'id' || ordering === 'barycenter' || nodes.length === 0) return null;

  let withValue = 0;
  for (const node of nodes) {
    let value: unknown;
    if (ordering === 'node-type') value = node.node_type;
    else if (ordering === 'community') value = communityStore.communityMap.get(node.node_id);
    else {
      const key = (egoConfig.value.ringOrderingKey ?? '').replace(/^prop:/, '');
      value = key ? node.properties?.[key] : undefined;
    }
    if (value !== undefined && value !== null && value !== '') withValue++;
  }
  return { withValue, total: nodes.length, missing: nodes.length - withValue };
});

const egoOrderingDegraded = computed(
  () => egoSectorCoverage.value !== null && egoSectorCoverage.value.withValue === 0
);

/**
 * Crossing reduction only has something to work with when edges exist outside
 * the BFS tree. A pure convergence star (the common fraud-attribute shape) has
 * none, so the strategy is a silent no-op — say so rather than let the user
 * toggle it looking for a change.
 */
const egoCrossingReductionIsNoop = computed(
  () =>
    egoConfig.value.ringOrdering === 'barycenter' &&
    graphStore.egoLayoutStats !== null &&
    graphStore.egoLayoutStats.nonTreeEdgeCount === 0
);

/** Sifting was requested but a ring exceeded the interaction-time budget. */
const egoSiftingSkipped = computed(
  () =>
    egoConfig.value.ringOrdering === 'barycenter' &&
    egoConfig.value.crossingHeuristic === 'sifting' &&
    graphStore.egoLayoutStats?.siftingSkippedLargeRing === true
);

/** Same-ring arcs are equally a no-op when no edge joins two nodes on one ring. */
const egoHasNoSameRingEdges = computed(
  () => graphStore.egoLayoutStats !== null && graphStore.egoLayoutStats.sameRingEdgeCount === 0
);

// ---------------------------------------------------------------------------
// Hive mode
// ---------------------------------------------------------------------------

const hiveAxisCategoryCount = computed(() => {
  const key = hiveConfig.value.axisKey;
  if (key === 'node_type') return graphStore.nodeTypes.length;
  if (key === 'community') return communityStore.communityCount;
  const propName = key.startsWith('prop:') ? key.slice(5) : key;
  const values = new Set<string>();
  for (const node of graphStore.nodes) {
    const value = node.properties?.[propName];
    values.add(value === null || value === undefined ? '(missing)' : String(value));
  }
  return values.size;
});

const hiveOthersCount = computed(() =>
  Math.max(0, hiveAxisCategoryCount.value - hiveConfig.value.maxAxes)
);

// ---------------------------------------------------------------------------
// Hierarchical mode
// ---------------------------------------------------------------------------

const hierarchicalConfig = computed(() => graphStore.layoutModeConfig.hierarchical);

const hierarchicalUsesAllEdgeTypes = computed(() => hierarchicalConfig.value.edgeTypes === null);

function toggleHierarchicalAllEdgeTypes(checked: boolean) {
  graphStore.updateLayoutModeConfig({ hierarchical: { edgeTypes: checked ? null : [...graphStore.edgeTypes] } });
}

function toggleHierarchicalEdgeType(edgeType: string, checked: boolean) {
  const current = hierarchicalConfig.value.edgeTypes ?? [...graphStore.edgeTypes];
  const next = checked ? [...new Set([...current, edgeType])] : current.filter((t) => t !== edgeType);
  graphStore.updateLayoutModeConfig({ hierarchical: { edgeTypes: next } });
}
</script>

<template>
  <div class="layout-panel">
    <div class="panel-header">
      <h4>Layout</h4>
      <button
        class="help-btn"
        title="Help - Parameter explanations"
        @click="showHelpModal = true"
      ><HelpCircle :size="14" /></button>
    </div>

    <!-- Layout mode selector -->
    <div class="layout-selector">
      <button
        v-for="opt in LAYOUT_OPTIONS"
        :key="opt.id"
        class="layout-option"
        :class="{ active: layoutMode === opt.id }"
        :title="opt.label"
        :data-testid="`layout-option-${opt.id}`"
        @click="selectLayout(opt.id)"
      >
        <span class="layout-icon">{{ opt.icon }}</span>
        <span class="layout-label">{{ opt.label }}</span>
      </button>
    </div>

    <div class="settings-divider"></div>

    <!-- Ego network controls -->
    <div v-if="layoutMode === 'ego'" class="settings-group">
      <p class="settings-group-title">Ego Network</p>

      <div class="setting-item">
        <label>
          <span class="setting-label">Focus node</span>
          <span class="setting-value" data-testid="ego-focus-label">{{ egoFocusLabel ?? '—' }}</span>
        </label>
        <button
          class="apply-btn"
          :disabled="!graphStore.selectedNode"
          data-testid="ego-use-selected-btn"
          @click="useSelectedAsFocus"
        >
          Use selected node
        </button>
        <span v-if="!egoConfig.focusNodeId" class="setting-hint" data-testid="ego-no-focus-hint">
          Select a node in the graph, then click "Use selected node" (or right-click a node → "Ego layout from here").
        </span>
      </div>

      <div class="setting-item">
        <label>
          <span class="setting-label">Direction</span>
        </label>
        <select
          class="setting-select"
          data-testid="ego-direction-select"
          :value="egoConfig.direction"
          @change="graphStore.updateLayoutModeConfig({ ego: { direction: ($event.target as HTMLSelectElement).value as 'both' | 'out' | 'in' } })"
        >
          <option value="both">Both directions</option>
          <option value="out">Outgoing (where it goes)</option>
          <option value="in">Incoming (where it comes from)</option>
        </select>
      </div>

      <div class="setting-item">
        <label class="checkbox-item">
          <input
            type="checkbox"
            data-testid="ego-all-edge-types"
            :checked="egoUsesAllEdgeTypes"
            @change="toggleEgoAllEdgeTypes(($event.target as HTMLInputElement).checked)"
          />
          <span>Traverse all edge types</span>
        </label>
        <template v-if="!egoUsesAllEdgeTypes">
          <label v-for="et in graphStore.edgeTypes" :key="et" class="checkbox-item edge-type-item">
            <input
              type="checkbox"
              :checked="(egoConfig.edgeTypes ?? []).includes(et)"
              @change="toggleEgoEdgeType(et, ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ et }}</span>
          </label>
        </template>
      </div>

      <div class="setting-item">
        <label>
          <span class="setting-label">Max hops</span>
          <span class="setting-value">{{ egoConfig.maxHops ?? '∞' }}</span>
        </label>
        <span class="setting-hint">Hide nodes farther than this many hops (∞ = show all)</span>
        <input
          type="range"
          min="0"
          max="6"
          step="1"
          data-testid="ego-max-hops"
          :value="egoConfig.maxHops ?? 0"
          @input="setEgoMaxHops(parseInt(($event.target as HTMLInputElement).value))"
        />
      </div>

      <div class="setting-item">
        <label>
          <span class="setting-label">Ring ordering</span>
        </label>
        <span class="setting-hint">
          What the angle around each ring means. One meaning at a time, so two runs stay comparable.
        </span>
        <select
          data-testid="ego-ring-ordering"
          :value="egoConfig.ringOrdering"
          @change="graphStore.updateLayoutModeConfig({ ego: { ringOrdering: ($event.target as HTMLSelectElement).value as RingOrdering } })"
        >
          <option value="barycenter">Fewest crossings</option>
          <option value="node-type">Sector by node type</option>
          <option value="community">Sector by community</option>
          <option value="property">Sector by property</option>
          <option value="id">None (by id)</option>
        </select>

        <select
          v-if="egoConfig.ringOrdering === 'property'"
          class="ego-ordering-key"
          data-testid="ego-ring-ordering-key"
          :value="egoConfig.ringOrderingKey ?? ''"
          @change="graphStore.updateLayoutModeConfig({ ego: { ringOrderingKey: ($event.target as HTMLSelectElement).value || null } })"
        >
          <option value="">Select a property…</option>
          <option v-for="p in graphStore.categoricalNodeProperties" :key="p.name" :value="p.name">
            {{ p.name }}
          </option>
        </select>

        <span
          v-if="egoCrossingReductionIsNoop"
          class="setting-hint setting-hint-warn"
          data-testid="ego-crossing-noop-hint"
        >
          No edges outside the tree — nothing to uncross here. Sector by type or property to
          give the angle meaning.
        </span>
        <span
          v-if="egoOrderingDegraded"
          class="setting-hint setting-hint-warn"
          data-testid="ego-ordering-degraded-hint"
        >
          No node carries this attribute — falling back to id order.
        </span>
        <span
          v-else-if="egoSectorCoverage && egoSectorCoverage.missing > 0"
          class="setting-hint"
          data-testid="ego-ordering-coverage-hint"
        >
          {{ egoSectorCoverage.missing }} of {{ egoSectorCoverage.total }} nodes lack this
          attribute — they form their own sector, never hidden.
        </span>
      </div>

      <!-- Advanced: ring geometry and edge drawing refinements -->
      <div class="advanced-toggle" data-testid="ego-advanced-toggle" @click="showEgoAdvanced = !showEgoAdvanced">
        <ChevronDown v-if="showEgoAdvanced" :size="12" class="toggle-icon" />
        <ChevronRight v-else :size="12" class="toggle-icon" />
        <span class="advanced-label">Advanced</span>
      </div>

      <template v-if="showEgoAdvanced">
        <div v-if="egoConfig.ringOrdering === 'barycenter'" class="setting-item">
          <label>
            <span class="setting-label">Crossing heuristic</span>
          </label>
          <span class="setting-hint">
            How hard the layout works to uncross edges. All are deterministic.
          </span>
          <select
            class="setting-select"
            data-testid="ego-crossing-heuristic"
            :value="egoConfig.crossingHeuristic"
            @change="graphStore.updateLayoutModeConfig({ ego: { crossingHeuristic: ($event.target as HTMLSelectElement).value as CrossingHeuristic } })"
          >
            <option value="barycenter">Barycenter — fastest (default)</option>
            <option value="median">Median — fast, outlier-resistant</option>
            <option value="sifting">Sifting — far stronger, slower</option>
          </select>
          <span
            v-if="egoConfig.crossingHeuristic !== 'sifting'"
            class="setting-hint"
            data-testid="ego-heuristic-weak-hint"
          >
            The fast heuristics only reorder siblings, so they barely help when most nodes hang
            off one hub. Sifting uncrosses far more there, at up to ~90ms per layout pass.
          </span>
          <span
            v-if="egoSiftingSkipped"
            class="setting-hint setting-hint-warn"
            data-testid="ego-sifting-skipped-hint"
          >
            A ring was too large to sift within the interaction budget — it kept the faster sweep
            result.
          </span>
        </div>

        <div
          v-if="egoConfig.ringOrdering === 'barycenter' && egoConfig.crossingHeuristic !== 'sifting'"
          class="setting-item"
        >
          <label>
            <span class="setting-label">Sweeps</span>
            <span class="setting-value">{{ egoConfig.crossingSweeps }}</span>
          </label>
          <span class="setting-hint">More sweeps settle further; 0 keeps the plain id order.</span>
          <input
            type="range"
            min="0"
            max="8"
            step="1"
            data-testid="ego-crossing-sweeps"
            :value="egoConfig.crossingSweeps"
            @input="graphStore.updateLayoutModeConfig({ ego: { crossingSweeps: parseInt(($event.target as HTMLInputElement).value) } })"
          />
        </div>

        <div class="setting-item">
          <label>
            <span class="setting-label">Ring spacing</span>
            <span class="setting-value">{{ egoConfig.ringSpacing }}</span>
          </label>
          <input
            type="range"
            min="20"
            max="200"
            step="10"
            data-testid="ego-ring-spacing"
            :value="egoConfig.ringSpacing"
            @input="graphStore.updateLayoutModeConfig({ ego: { ringSpacing: parseInt(($event.target as HTMLInputElement).value) } })"
          />
        </div>

        <div class="setting-item">
          <label class="checkbox-item">
            <input
              type="checkbox"
              data-testid="ego-arc-intra-ring"
              :checked="egoConfig.arcIntraRingEdges"
              @change="graphStore.updateLayoutModeConfig({ ego: { arcIntraRingEdges: ($event.target as HTMLInputElement).checked } })"
            />
            <span class="setting-label">Arc same-ring edges</span>
          </label>
          <span class="setting-hint">
            Edges between nodes on the same ring follow the ring instead of cutting across the
            middle. Each edge stays individually selectable.
          </span>
          <span
            v-if="egoHasNoSameRingEdges"
            class="setting-hint setting-hint-warn"
            data-testid="ego-no-same-ring-hint"
          >
            No edges join two nodes on the same ring in this graph — this has nothing to redraw.
          </span>
        </div>

        <div class="setting-item">
          <span class="setting-hint" data-testid="ego-pinned-hint">
            Nodes are placed analytically and pinned, so the simulation controls do not apply in
            this mode. The same graph always produces the same picture — that is what makes two
            ego views comparable.
          </span>
        </div>

        <div v-if="graphStore.behaviors.edgeLensMode === 'off'" class="setting-item">
          <span class="setting-hint" data-testid="ego-lens-hint">
            Tip: Graph Lens dims everything but a hovered node's edges — the cheapest way to read
            a dense ring.
            <button
              type="button"
              class="inline-action"
              data-testid="ego-enable-lens"
              @click="graphStore.behaviors.edgeLensMode = 'dim'"
            >
              Enable
            </button>
          </span>
        </div>
      </template>
    </div>

    <!-- Hive plot controls -->
    <div v-if="layoutMode === 'hive'" class="settings-group">
      <p class="settings-group-title">Hive Plot</p>

      <div class="setting-item">
        <label>
          <span class="setting-label">Axes by</span>
        </label>
        <select
          class="setting-select"
          data-testid="hive-axis-select"
          :value="hiveConfig.axisKey"
          @change="graphStore.updateLayoutModeConfig({ hive: { axisKey: ($event.target as HTMLSelectElement).value } })"
        >
          <option value="node_type">Node type</option>
          <option value="community">Community (Louvain)</option>
          <option v-for="p in graphStore.categoricalNodeProperties" :key="p.name" :value="`prop:${p.name}`">
            {{ p.display_name || p.name }}
          </option>
        </select>
        <span
          v-if="hiveConfig.axisKey === 'community' && communityStore.communityMap.size === 0"
          class="setting-hint"
          data-testid="hive-no-communities-hint"
        >
          No communities detected yet — run community detection in the Communities panel first.
        </span>
        <span v-if="hiveOthersCount > 0" class="setting-hint" data-testid="hive-others-hint">
          {{ hiveOthersCount }} categories grouped into "Others" (max {{ hiveConfig.maxAxes }} axes)
        </span>
        <span v-if="hiveAxisCategoryCount <= 1" class="setting-hint">
          Only one category — try a different axis attribute for a readable hive plot.
        </span>
      </div>

      <div class="setting-item">
        <label>
          <span class="setting-label">Position by</span>
        </label>
        <select
          class="setting-select"
          data-testid="hive-position-select"
          :value="hiveConfig.positionKey"
          @change="graphStore.updateLayoutModeConfig({ hive: { positionKey: ($event.target as HTMLSelectElement).value } })"
        >
          <option value="degree">Degree (connections)</option>
          <option v-for="p in graphStore.numericNodeProperties" :key="p.name" :value="`prop:${p.name}`">
            {{ p.display_name || p.name }}
          </option>
        </select>
      </div>

      <div class="setting-item">
        <label>
          <span class="setting-label">Scale</span>
        </label>
        <select
          class="setting-select"
          data-testid="hive-scale-select"
          :value="hiveConfig.scale"
          @change="graphStore.updateLayoutModeConfig({ hive: { scale: ($event.target as HTMLSelectElement).value as 'rank' | 'linear' | 'log' } })"
        >
          <option value="rank">Rank (uniform spread)</option>
          <option value="linear">Linear</option>
          <option value="log">Log (heavy-tailed values)</option>
        </select>
      </div>

      <div class="setting-item">
        <label>
          <span class="setting-label">Max axes</span>
          <span class="setting-value">{{ hiveConfig.maxAxes }}</span>
        </label>
        <input
          type="range"
          min="2"
          max="12"
          step="1"
          :value="hiveConfig.maxAxes"
          @input="graphStore.updateLayoutModeConfig({ hive: { maxAxes: parseInt(($event.target as HTMLInputElement).value) } })"
        />
      </div>

      <div class="setting-item">
        <label>
          <span class="setting-label">Radius (inner / outer)</span>
          <span class="setting-value">{{ hiveConfig.innerRadius }} / {{ hiveConfig.outerRadius }}</span>
        </label>
        <input
          type="range"
          min="0"
          max="150"
          step="10"
          :value="hiveConfig.innerRadius"
          @input="graphStore.updateLayoutModeConfig({ hive: { innerRadius: parseInt(($event.target as HTMLInputElement).value) } })"
        />
        <input
          type="range"
          min="150"
          max="800"
          step="25"
          :value="hiveConfig.outerRadius"
          @input="graphStore.updateLayoutModeConfig({ hive: { outerRadius: parseInt(($event.target as HTMLInputElement).value) } })"
        />
      </div>

      <p class="layout-help">
        Deterministic layout: same graph + same settings always produce the same picture —
        hive plots of different cases are directly comparable.
      </p>
    </div>

    <!-- Hierarchical controls -->
    <div v-if="layoutMode === 'hierarchical'" class="settings-group">
      <p class="settings-group-title">Hierarchical</p>

      <div class="setting-item">
        <label>
          <span class="setting-label">Direction</span>
        </label>
        <select
          class="setting-select"
          data-testid="hierarchical-direction-select"
          :value="hierarchicalConfig.direction"
          @change="graphStore.updateLayoutModeConfig({ hierarchical: { direction: ($event.target as HTMLSelectElement).value as 'td' | 'lr' } })"
        >
          <option value="td">Top → down</option>
          <option value="lr">Left → right</option>
        </select>
      </div>

      <div class="setting-item">
        <label>
          <span class="setting-label">Flow</span>
        </label>
        <span class="setting-hint">Which way levels descend — 'along edges' follows money flow (src → dst)</span>
        <select
          class="setting-select"
          data-testid="hierarchical-traversal-select"
          :value="hierarchicalConfig.traversal"
          @change="graphStore.updateLayoutModeConfig({ hierarchical: { traversal: ($event.target as HTMLSelectElement).value as 'both' | 'out' | 'in' } })"
        >
          <option value="out">Along edges (src → dst)</option>
          <option value="in">Against edges (dst → src)</option>
          <option value="both">Ignore direction</option>
        </select>
      </div>

      <div class="setting-item">
        <label class="checkbox-item">
          <input
            type="checkbox"
            data-testid="hierarchical-all-edge-types"
            :checked="hierarchicalUsesAllEdgeTypes"
            @change="toggleHierarchicalAllEdgeTypes(($event.target as HTMLInputElement).checked)"
          />
          <span>Use all edge types</span>
        </label>
        <template v-if="!hierarchicalUsesAllEdgeTypes">
          <label v-for="et in graphStore.edgeTypes" :key="et" class="checkbox-item edge-type-item">
            <input
              type="checkbox"
              :checked="(hierarchicalConfig.edgeTypes ?? []).includes(et)"
              @change="toggleHierarchicalEdgeType(et, ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ et }}</span>
          </label>
        </template>
      </div>

      <div class="setting-item">
        <label>
          <span class="setting-label">Level spacing</span>
          <span class="setting-value">{{ hierarchicalConfig.levelSpacing }}</span>
        </label>
        <input
          type="range"
          min="40"
          max="400"
          step="20"
          :value="hierarchicalConfig.levelSpacing"
          @input="graphStore.updateLayoutModeConfig({ hierarchical: { levelSpacing: parseInt(($event.target as HTMLInputElement).value) } })"
        />
      </div>

      <div class="setting-item">
        <label>
          <span class="setting-label">Node spacing</span>
          <span class="setting-value">{{ hierarchicalConfig.nodeSpacing }}</span>
        </label>
        <input
          type="range"
          min="15"
          max="150"
          step="5"
          :value="hierarchicalConfig.nodeSpacing"
          @input="graphStore.updateLayoutModeConfig({ hierarchical: { nodeSpacing: parseInt(($event.target as HTMLInputElement).value) } })"
        />
      </div>

      <p class="layout-help">
        Layers by distance from source nodes (no incoming edges). Money-laundering
        layering shows up as long chains; cycles land on the level where they were
        first reached.
      </p>
    </div>

    <!-- Simulation controls (not applicable to the fixed-position hive plot) -->
    <div v-if="layoutMode === 'force'" class="fa2-controls">
        <button
          class="run-btn"
          :class="{ running: isLayoutRunning }"
          @click="toggleLayout"
          data-testid="layout-run-btn"
        >
          <Square v-if="isLayoutRunning" :size="13" /> <Play v-else :size="13" />
          {{ isLayoutRunning ? 'Stop' : 'Run' }}
        </button>
        <button
          class="apply-btn"
          @click="$emit('reheat-layout')"
          title="Reheat simulation"
        >
          <Flame :size="13" /> Reheat
        </button>
        <button
          class="apply-btn"
          @click="$emit('scramble-layout')"
          title="Scramble node positions"
        >
          <Shuffle :size="13" /> Scramble
        </button>
      </div>

      <div v-if="layoutMode === 'force'" class="settings-divider"></div>

      <!-- Basic controls with friendly names -->
      <div v-if="layoutMode === 'force'" class="settings-group">
        <div class="setting-item">
          <label>
            <span class="setting-label">Repulsion</span>
            <span class="setting-value">{{ graphStore.force3DSettings.d3ChargeStrength }}</span>
          </label>
          <input
            type="range"
            min="-500"
            max="-1"
            step="1"
            :value="graphStore.force3DSettings.d3ChargeStrength"
            @input="graphStore.updateForce3DSettings({ d3ChargeStrength: parseFloat(($event.target as HTMLInputElement).value) })"
          />
        </div>

        <div class="setting-item">
          <label>
            <span class="setting-label">Link Distance</span>
            <span class="setting-value">{{ graphStore.force3DSettings.d3LinkDistance }}</span>
          </label>
          <input
            type="range"
            min="5"
            max="200"
            step="1"
            :value="graphStore.force3DSettings.d3LinkDistance"
            @input="graphStore.updateForce3DSettings({ d3LinkDistance: parseFloat(($event.target as HTMLInputElement).value) })"
          />
        </div>

        <div class="setting-item">
          <label>
            <span class="setting-label">Gravity</span>
            <span class="setting-value">{{ graphStore.force3DSettings.d3GravityStrength.toFixed(2) }}</span>
          </label>
          <input
            type="range"
            min="0"
            max="0.3"
            step="0.01"
            :value="graphStore.force3DSettings.d3GravityStrength"
            @input="graphStore.updateForce3DSettings({ d3GravityStrength: parseFloat(($event.target as HTMLInputElement).value) })"
          />
        </div>

        <label class="checkbox-item">
          <input
            type="checkbox"
            :checked="graphStore.force3DSettings.d3CollideEnabled"
            @change="graphStore.updateForce3DSettings({ d3CollideEnabled: ($event.target as HTMLInputElement).checked })"
          />
          <span>Avoid Overlap</span>
        </label>

        <template v-if="graphStore.force3DSettings.d3CollideEnabled">
          <div class="setting-item">
            <label>
              <span class="setting-label">Min. Collision Radius</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3CollideRadius }}</span>
            </label>
            <input
              type="range"
              min="1"
              max="50"
              step="1"
              :value="graphStore.force3DSettings.d3CollideRadius"
              @input="graphStore.updateForce3DSettings({ d3CollideRadius: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>
        </template>

        <!-- Blower + Clipping Plane moved to BehaviorPanel (they are behaviors, not layout) -->
      </div>

      <div v-if="layoutMode === 'force'" class="settings-divider"></div>

      <!-- Execution controls with friendly names -->
      <div v-if="layoutMode === 'force'" class="settings-group">
        <div class="setting-item">
          <label>
            <span class="setting-label">Layout Iterations</span>
            <span class="setting-value">{{ graphStore.layoutExecution.cooldownTicks }}</span>
          </label>
          <span class="setting-hint">How many iterations the simulation runs before stopping</span>
          <input
            type="range"
            min="50"
            max="2000"
            step="50"
            :value="graphStore.layoutExecution.cooldownTicks"
            @input="graphStore.updateLayoutExecution({ cooldownTicks: parseInt(($event.target as HTMLInputElement).value) })"
          />
        </div>

        <div class="setting-item">
          <label>
            <span class="setting-label">Simulation Speed</span>
            <span class="setting-value">{{ graphStore.layoutExecution.ticksPerFrame }}</span>
          </label>
          <span class="setting-hint">Calculations per frame — higher = converges faster</span>
          <input
            type="range"
            min="1"
            max="100"
            step="5"
            :value="graphStore.layoutExecution.ticksPerFrame"
            @input="graphStore.updateLayoutExecution({ ticksPerFrame: parseInt(($event.target as HTMLInputElement).value) })"
          />
        </div>

        <div class="setting-item">
          <label>
            <span class="setting-label">Pre-computation</span>
            <span class="setting-value">{{ graphStore.layoutExecution.warmupTicks }}</span>
          </label>
          <span class="setting-hint">Iterations before display — organizes the graph without rendering</span>
          <input
            type="range"
            min="0"
            max="500"
            step="10"
            :value="graphStore.layoutExecution.warmupTicks"
            @input="graphStore.updateLayoutExecution({ warmupTicks: parseInt(($event.target as HTMLInputElement).value) })"
          />
        </div>
      </div>

      <div v-if="layoutMode === 'force'" class="settings-divider"></div>

      <!-- Layout by Edge Type (force mode only — it would fight other modes' constraints) -->
      <div v-if="layoutMode === 'force'" class="settings-group">
        <p class="settings-group-title">Layout by Edge Type</p>

        <div class="setting-item">
          <label>
            <span class="setting-label">Edge Type</span>
          </label>
          <select
            v-model="similarityStore.layoutEdgeType"
            class="setting-select"
          >
            <option :value="null">All edges (default)</option>
            <option v-for="et in graphStore.edgeTypes" :key="et" :value="et">{{ et }}</option>
          </select>
        </div>

        <div class="setting-item">
          <label>
            <span class="setting-label">Strategy</span>
          </label>
          <select
            v-model="similarityStore.layoutStrategy"
            class="setting-select"
          >
            <option value="fix-then-recompute">Fix then recompute</option>
            <option value="unified">Full simulation, selected links only</option>
            <option value="selected-only">Selected only layout</option>
          </select>
        </div>

        <label class="checkbox-item">
          <input
            type="checkbox"
            v-model="similarityStore.useScoreAsWeight"
          />
          <span>Use score as weight</span>
        </label>

        <button
          class="apply-btn"
          :disabled="!similarityStore.layoutEdgeType"
          @click="emit('start-edge-type-layout', similarityStore.layoutEdgeType, similarityStore.layoutStrategy)"
        >
          <Play :size="13" /> Apply Edge Layout
        </button>
      </div>

      <div class="settings-divider"></div>

      <!-- Advanced toggle (simulation params — not applicable to hive) -->
      <div v-if="layoutMode === 'force'" class="advanced-toggle" @click="showAdvanced = !showAdvanced">
        <ChevronDown v-if="showAdvanced" :size="12" class="toggle-icon" />
        <ChevronRight v-else :size="12" class="toggle-icon" />
        <span class="advanced-label">Advanced</span>
      </div>

      <!-- Advanced settings -->
      <template v-if="showAdvanced && layoutMode === 'force'">
        <div class="settings-group">
          <p class="settings-group-title">Simulation</p>

          <div class="setting-item">
            <label>
              <span class="setting-label">Alpha Decay</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3AlphaDecay.toFixed(4) }}</span>
            </label>
            <input
              type="range"
              min="0.001"
              max="0.1"
              step="0.001"
              :value="graphStore.force3DSettings.d3AlphaDecay"
              @input="graphStore.updateForce3DSettings({ d3AlphaDecay: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>

          <div class="setting-item">
            <label>
              <span class="setting-label">Velocity Decay</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3VelocityDecay.toFixed(2) }}</span>
            </label>
            <input
              type="range"
              min="0.1"
              max="0.9"
              step="0.05"
              :value="graphStore.force3DSettings.d3VelocityDecay"
              @input="graphStore.updateForce3DSettings({ d3VelocityDecay: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>

          <div class="setting-item">
            <label>
              <span class="setting-label">Alpha Min</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3AlphaMin.toFixed(4) }}</span>
            </label>
            <input
              type="range"
              min="0.0001"
              max="0.01"
              step="0.0001"
              :value="graphStore.force3DSettings.d3AlphaMin"
              @input="graphStore.updateForce3DSettings({ d3AlphaMin: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>

          <div class="setting-item">
            <label>
              <span class="setting-label">Alpha Target</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3AlphaTarget.toFixed(2) }}</span>
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              :value="graphStore.force3DSettings.d3AlphaTarget"
              @input="graphStore.updateForce3DSettings({ d3AlphaTarget: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>
        </div>

        <div class="settings-divider"></div>

        <div class="settings-group">
          <p class="settings-group-title">Charge Force (manyBody)</p>

          <div class="setting-item">
            <label>
              <span class="setting-label">Theta (Barnes-Hut)</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3Theta.toFixed(2) }}</span>
            </label>
            <input
              type="range"
              min="0.1"
              max="2"
              step="0.05"
              :value="graphStore.force3DSettings.d3Theta"
              @input="graphStore.updateForce3DSettings({ d3Theta: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>

          <div class="setting-item">
            <label>
              <span class="setting-label">Distance Min</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3DistanceMin }}</span>
            </label>
            <input
              type="range"
              min="1"
              max="50"
              step="1"
              :value="graphStore.force3DSettings.d3DistanceMin"
              @input="graphStore.updateForce3DSettings({ d3DistanceMin: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>

          <div class="setting-item">
            <label>
              <span class="setting-label">Distance Max</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3DistanceMax === Infinity ? '∞' : graphStore.force3DSettings.d3DistanceMax }}</span>
            </label>
            <input
              type="range"
              min="100"
              max="2000"
              step="50"
              :value="graphStore.force3DSettings.d3DistanceMax === Infinity ? 2000 : graphStore.force3DSettings.d3DistanceMax"
              @input="graphStore.updateForce3DSettings({ d3DistanceMax: parseFloat(($event.target as HTMLInputElement).value) >= 2000 ? Infinity : parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>
        </div>

        <div class="settings-divider"></div>

        <div class="settings-group">
          <p class="settings-group-title">Collide Force</p>

          <div class="setting-item">
            <label>
              <span class="setting-label">Strength</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3CollideStrength.toFixed(2) }}</span>
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="graphStore.force3DSettings.d3CollideStrength"
              @input="graphStore.updateForce3DSettings({ d3CollideStrength: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>

          <div class="setting-item">
            <label>
              <span class="setting-label">Iterations</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3CollideIterations }}</span>
            </label>
            <input
              type="range"
              min="1"
              max="10"
              step="1"
              :value="graphStore.force3DSettings.d3CollideIterations"
              @input="graphStore.updateForce3DSettings({ d3CollideIterations: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>
        </div>
      </template>

    <!-- Help Modal for 3D Layout Parameters -->
    <Teleport to="body">
      <div v-if="showHelpModal" class="modal-overlay" @click.self="showHelpModal = false">
        <div class="modal-content">
          <div class="modal-header">
            <h3>D3-Force 3D Layout Parameters</h3>
            <button class="modal-close" aria-label="Close" @click="showHelpModal = false"><X :size="16" /></button>
          </div>
          <div class="modal-body">
            <p class="modal-intro">
              The force-directed layout simulates physical forces between nodes to create organic visualizations.
              In <strong>fraud and credit</strong> graphs, this helps identify clusters of related entities,
              structural anomalies, and suspicious connection patterns.
            </p>

            <div class="param-section">
              <h4>Simulation Parameters</h4>

              <div class="param-item">
                <span class="param-name">Charge Strength</span>
                <p>Repulsion force between nodes. More negative values = stronger repulsion.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> High values (-200 to -500) better separate distinct clusters, making it easier to identify groups of related accounts or isolated fraud networks.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Link Distance</span>
                <p>Target distance between connected nodes.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> Shorter distances group strongly connected entities (e.g., account-holder-address), while longer distances reveal the overall network structure.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Alpha Decay</span>
                <p>Simulation cooling rate. Lower = converges slower but with better quality.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> For complex graphs with many cross-connections, low values (0.01-0.02) allow better community separation.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Velocity Decay</span>
                <p>Friction applied to nodes. Higher = smoother and more controlled movement.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> High values (0.4-0.6) stabilize the visualization faster, useful for interactive analysis.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Alpha Min</span>
                <p>Threshold to stop the simulation. Lower = runs longer.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> For large graphs, higher values (0.005) save time; for detailed analysis, lower values (0.0001) yield a more refined layout.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Alpha Target</span>
                <p>Target alpha. If > 0, the simulation never fully stops.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> Use 0 for static layouts. Small values (0.01-0.05) keep the graph "alive" for continuous exploration.</p>
              </div>
            </div>

            <div class="param-section">
              <h4>Charge Force (manyBody)</h4>

              <div class="param-item">
                <span class="param-name">Theta (Barnes-Hut)</span>
                <p>Approximation for force calculation. Higher = faster but less accurate.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> For large graphs (>1000 nodes), high theta (1.0-1.5) improves performance. For accuracy in smaller graphs, use 0.5-0.8.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Distance Min</span>
                <p>Minimum distance to apply repulsion. Prevents extreme forces when nodes are very close.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> Low values (1-5) allow nodes to stay close in dense clusters; high values (10-20) force more separation.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Distance Max</span>
                <p>Maximum distance to apply repulsion. Beyond this, nodes do not repel each other.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> Limiting (500-1000) can create more compact clusters. Infinity (∞) maintains global repulsion, better separating distant communities.</p>
              </div>
            </div>

            <div class="param-section">
              <h4>Collide Force</h4>

              <div class="param-item">
                <span class="param-name">Enable Collision</span>
                <p>Enables collision detection to prevent node overlap.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> Essential when nodes have different sizes (e.g., based on transaction volume). Ensures that large nodes don't hide smaller ones.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Radius</span>
                <p>Base collision radius for each node.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> Adjust to be slightly larger than the visual node size. If nodes have size 5, use radius 6-8 to prevent overlap.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Strength</span>
                <p>Repulsion force when nodes collide (0-1).</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> High values (0.7-1.0) ensure clear separation; low values (0.3-0.5) allow some overlap for more compact layouts.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Iterations</span>
                <p>Collision resolution iterations per tick. More = more accurate but slower.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> For dense graphs with heavy overlap, increase to 3-5. For sparse graphs, 1 is sufficient.</p>
              </div>
            </div>

            <div class="param-section tips">
              <h4>Tips for Fraud Analysis</h4>
              <ul>
                <li><strong>Identify clusters:</strong> Use high charge strength (-300) + low link distance (20) to group related entities.</li>
                <li><strong>Find anomalies:</strong> Nodes with many connections (hubs) often indicate central accounts in fraud schemes.</li>
                <li><strong>View overall structure:</strong> Limited distance max groups communities; infinity reveals relationships between distant communities.</li>
                <li><strong>Size analysis:</strong> Enable collision when nodes have sizes based on metrics (e.g., transaction volume) to ensure visibility.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.layout-panel {
  padding: 12px;
  background: var(--card-background, white);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 8px;
  min-width: 200px;
  max-width: 240px;
  max-height: calc(100vh - 150px);
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.panel-header {
  margin-bottom: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.panel-header h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-color, #333);
}

.help-btn {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 50%;
  background: var(--card-background, white);
  color: var(--text-muted, #666);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.help-btn:hover {
  background: var(--primary-color, #42b883);
  color: white;
  border-color: var(--primary-color, #42b883);
}

.layout-selector {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}

.layout-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: transparent;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  text-align: left;
  transition: all 0.15s;
}

.layout-option:hover {
  background: var(--bg-secondary, #f5f5f5);
}

.layout-option.active {
  background: var(--primary-color, #42b883);
  color: white;
  border-color: var(--primary-color, #42b883);
}

.layout-icon {
  font-size: 14px;
}

.layout-label {
  flex: 1;
}

.edge-type-item {
  margin-left: 18px;
  font-size: 11px;
}

.fa2-controls {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.run-btn,
.apply-btn {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
  background: var(--card-background, white);
}

.run-btn:hover,
.apply-btn:hover:not(:disabled) {
  background: var(--bg-secondary, #f0f0f0);
}

.run-btn.running {
  background: var(--danger-color, #ff6b6b);
  color: white;
  border-color: var(--danger-color, #ff6b6b);
}

.apply-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.settings-divider {
  height: 1px;
  background: var(--border-color, #ddd);
  margin: 12px 0;
}

.settings-group {
  margin-bottom: 12px;
}

.settings-group:last-child {
  margin-bottom: 0;
}

.settings-group-title {
  margin: 0 0 8px 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted, #666);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.setting-item {
  margin-bottom: 10px;
}

.setting-item:last-child {
  margin-bottom: 0;
}

.setting-item label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
  font-size: 11px;
}

.setting-label {
  color: var(--text-muted, #666);
}

.setting-value {
  font-family: monospace;
  color: var(--text-color, #333);
  font-size: 11px;
}

.setting-item input[type="range"] {
  width: 100%;
  height: 4px;
  border-radius: 2px;
  appearance: none;
  background: var(--border-color, #ddd);
  cursor: pointer;
}

.setting-item input[type="range"]::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--primary-color, #42b883);
  cursor: pointer;
}

.settings-group.checkboxes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.checkbox-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-color, #333);
}

.checkbox-item input {
  cursor: pointer;
}

.setting-select {
  width: 100%;
  padding: 6px 8px;
  font-size: 11px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  background: var(--card-background, white);
  cursor: pointer;
}

.setting-select:focus {
  outline: none;
  border-color: var(--primary-color, #42b883);
}

.setting-input {
  width: 100%;
  padding: 6px 8px;
  font-size: 11px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  background: var(--card-background, white);
}

.setting-input:focus {
  outline: none;
  border-color: var(--primary-color, #42b883);
}

.setting-hint {
  display: block;
  font-size: 10px;
  color: var(--text-muted, #999);
  margin-top: 4px;
}

.setting-hint-warn {
  color: var(--warning-color, #e0a030);
}

.ego-ordering-key {
  margin-top: 6px;
}

.inline-action {
  background: none;
  border: none;
  padding: 0;
  margin-left: 4px;
  color: var(--primary-color, #42b883);
  font-size: 10px;
  cursor: pointer;
  text-decoration: underline;
}

.mode-info {
  margin-bottom: 12px;
}

.mode-badge {
  display: inline-block;
  padding: 4px 8px;
  background: var(--primary-color, #42b883);
  color: white;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}

.layout-help {
  font-size: 11px;
  color: var(--text-muted, #666);
  margin: 12px 0 0 0;
  line-height: 1.4;
}

.advanced-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted, #666);
  user-select: none;
  transition: color 0.15s;
}

.advanced-toggle:hover {
  color: var(--text-color, #333);
}

.toggle-icon {
  font-size: 10px;
  color: var(--text-muted, #666);
}

.advanced-label {
  letter-spacing: 0.3px;
}

/* Modal styles */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.modal-content {
  background: var(--card-background, white);
  border-radius: 12px;
  max-width: 600px;
  max-height: 80vh;
  width: 90%;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color, #ddd);
  background: var(--bg-secondary, #f5f5f5);
}

.modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-color, #333);
}

.modal-close {
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  background: transparent;
  font-size: 24px;
  color: var(--text-muted, #666);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s;
}

.modal-close:hover {
  background: var(--danger-color, #ff6b6b);
  color: white;
}

.modal-body {
  padding: 20px;
  overflow-y: auto;
  max-height: calc(80vh - 60px);
}

.modal-intro {
  margin: 0 0 20px 0;
  padding: 12px;
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-color, #333);
}

.param-section {
  margin-bottom: 24px;
}

.param-section:last-child {
  margin-bottom: 0;
}

.param-section h4 {
  margin: 0 0 12px 0;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--primary-color, #42b883);
  font-size: 14px;
  font-weight: 600;
  color: var(--primary-color, #42b883);
}

.param-item {
  margin-bottom: 16px;
  padding: 12px;
  background: var(--bg-secondary, #f9f9f9);
  border-radius: 6px;
  border-left: 3px solid var(--border-color, #ddd);
}

.param-item:last-child {
  margin-bottom: 0;
}

.param-name {
  display: block;
  font-weight: 600;
  font-size: 13px;
  color: var(--text-color, #333);
  margin-bottom: 4px;
}

.param-item p {
  margin: 4px 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-muted, #666);
}

.param-use {
  margin-top: 8px !important;
  padding-top: 8px;
  border-top: 1px dashed var(--border-color, #ddd);
  color: var(--text-color, #444) !important;
}

.param-section.tips {
  background: linear-gradient(135deg, rgba(66, 184, 131, 0.1), rgba(66, 184, 131, 0.05));
  padding: 16px;
  border-radius: 8px;
}

.param-section.tips h4 {
  border-bottom-color: var(--primary-color, #42b883);
}

.param-section.tips ul {
  margin: 0;
  padding-left: 20px;
}

.param-section.tips li {
  margin-bottom: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-color, #333);
}

.param-section.tips li:last-child {
  margin-bottom: 0;
}
</style>
