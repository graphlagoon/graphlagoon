<script setup lang="ts">
/**
 * The case screen (05 §3): one canvas fed by the case's graph items (checked
 * "on canvas" in the material list), filter chips over it, an analysis bar whose
 * results are items, an inspector (entity · selection · item · decision) and a
 * bottom strip (timeline · activity · suggestions · result). `?mode=dossier` is the
 * same store laid out as a document. Everything that enters the case is an item;
 * roles, tags, groups and matches are annotations.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Banknote, Plus, Route } from 'lucide-vue-next';
import { useInvestigationStore } from '@/stores/investigation';
import { useGraphStore, type InvestigationGraphMode } from '@/stores/graph';
import { useCommunityStore } from '@/stores/community';
import { useSimilarityStore } from '@/stores/similarity';
import { useClusterStore } from '@/stores/cluster';
import { useCaseFilters } from '@/stores/caseFilters';
import { useContextMenu, type ContextMenuTarget } from '@/composables/useContextMenu';
import { useToast } from '@/composables/useToast';
import type { TraceContent } from '@/composables/useCaseAnalyses';
import { resetMetricsCalculator } from '@/services/metricsCalculator';
import { caseNodeLabel } from '@/utils/caseLabels';
import { provenanceRingColors, roleColor, roleColorMap } from '@/utils/graphAppearance';
import { getErrorMessage } from '@/utils/errorMessage';
import { traceColumns, traceFlows } from '@/utils/traceView';
import { baseSourceId, mergedEntityCounts, nodeSourceIds, type NodeOrigin, type UnifiedNode } from '@/utils/unifyGraph';
import { LAYOUT_ALGORITHMS, type LayoutAlgorithm } from '@/types/graph';
import GraphCanvas3D from '@/components/GraphCanvas3D.vue';
import LayoutPanel from '@/components/LayoutPanel.vue';
import FilterPanel from '@/components/FilterPanel.vue';
import DataTablePanel from '@/components/DataTablePanel.vue';
import MetricsPanel from '@/components/MetricsPanel.vue';
import ClusterProgramPanel from '@/components/ClusterProgramPanel.vue';
import ClusterNodeModal from '@/components/ClusterNodeModal.vue';
import CaseHeader from '@/components/investigation/CaseHeader.vue';
import CaseItemsPanel from '@/components/investigation/CaseItemsPanel.vue';
import CaseFilterChips from '@/components/investigation/CaseFilterChips.vue';
import AnalysisBar, { type CasePanel } from '@/components/investigation/AnalysisBar.vue';
import SelectionInspector from '@/components/investigation/SelectionInspector.vue';
import CaseTimeline, { type TimelineTab } from '@/components/investigation/CaseTimeline.vue';
import AgentsIndicator from '@/components/investigation/AgentsIndicator.vue'; // F5 hook
import CaseSettingsDrawer from '@/components/investigation/CaseSettingsDrawer.vue';
import EntityPage from '@/components/investigation/EntityPage.vue';
import CaseDossier from '@/components/investigation/CaseDossier.vue';
import ShareDialog from '@/components/investigation/ShareDialog.vue';
import AddItemsPopover from '@/components/investigation/AddItemsPopover.vue'; // F3: popover replaces the modal
import FileImportWizard from '@/components/investigation/FileImportWizard.vue';
import type { TraceView } from '@/components/investigation/TraceResultPanel.vue';
import type { GraphResponse } from '@/types/graph';
import type { CaseItem, CaseViewContent } from '@/types/investigation';

const props = defineProps<{ id: string }>();

const route = useRoute();
const store = useInvestigationStore();
const graphStore = useGraphStore();
const communityStore = useCommunityStore();
const similarityStore = useSimilarityStore();
const clusterStore = useClusterStore();
const filters = useCaseFilters();
const contextMenu = useContextMenu();
const toast = useToast();

const mode = computed<'canvas' | 'dossier'>(() => (route.query.mode === 'dossier' ? 'dossier' : 'canvas'));

const showAdd = ref(false);
const showWizard = ref(false);
const wizardRole = ref<'graph' | 'enrichment' | 'attachment' | undefined>(undefined);
const showSettings = ref(false);
const showShare = ref(false);
const decideMode = ref(false);
const entityPage = ref<UnifiedNode | null>(null);
const activeItem = ref<CaseItem | null>(null);
const activeAnalysis = ref<CaseItem | null>(null);
const traceView = ref<TraceView>('layers');
const timelineTab = ref<TimelineTab>('timeline');
const timelineCollapsed = ref(true);
const paintByGroup = ref(false);
const selectedClusterId = ref<string | null>(null);
const panels = ref<Record<CasePanel, boolean>>({ filters: false, table: false, metrics: false, layout: false, advanced: false });
const canvasRef = ref<InstanceType<typeof GraphCanvas3D> | null>(null);
const analysisBar = ref<InstanceType<typeof AnalysisBar> | null>(null);

const sourceTitle = (sourceId: string) => store.itemTitle(baseSourceId(sourceId));
const contextTitle = (contextId: string) => store.contexts[contextId]?.title ?? store.itemTitle(contextId);
const mergedCounts = computed(() => mergedEntityCounts(store.unified.nodes));
const canEdit = computed(() => !!store.current?.has_write_access && store.current.status !== 'closed');

// --- context picker for expanding a node that exists in several contexts ---
const pickerOrigins = ref<NodeOrigin[] | null>(null);
let pickerResolve: ((o: NodeOrigin | null) => void) | null = null;

function chooseOrigin(origins: NodeOrigin[]): Promise<NodeOrigin | null> {
  pickerResolve?.(null);
  pickerOrigins.value = origins;
  return new Promise((resolve) => (pickerResolve = resolve));
}

function pick(origin: NodeOrigin | null) {
  pickerResolve?.(origin);
  pickerResolve = null;
  pickerOrigins.value = null;
}

function applyExpansion(origin: NodeOrigin, response: GraphResponse) {
  store.addExpansion(origin, response.nodes, response.edges);
}

// --- loading the unified graph into the graph store ---
// The community store clears its results whenever `nodes` changes; keep the
// communities and put them back after the swap (same timing as loadExploration).
let savedCommunities: Record<string, unknown> | undefined;

const labelOf = (n: { node_id: string; node_type: string; properties?: Record<string, unknown> }) =>
  caseNodeLabel(n, { templates: store.labelTemplates });

function graphMode(rings: Map<string, string[]>): InvestigationGraphMode {
  return {
    origins: new Map(store.unified.nodes.map((n) => [n.node_id, n.__sources])),
    rings,
    labelOf,
    chooseOrigin,
    applyExpansion,
  };
}

/** The active trace item's content (layers mode re-lays the canvas by its columns). */
const activeTrace = computed<TraceContent | null>(() => {
  const item = activeAnalysis.value;
  if (!item || item.provenance?.tool !== 'trace') return null;
  return (store.contents[`${item.id}:${item.current_version}`] as TraceContent | undefined) ?? null;
});

async function render() {
  const trace = activeTrace.value;
  if (trace && traceView.value === 'layers') return renderTraceLayers(trace);
  if (graphStore.layoutAlgorithm === 'trace-layers') {
    graphStore.traceLayers = null;
    graphStore.setLayoutAlgorithm('force');
  }
  if (graphStore.nodes.length) savedCommunities = communityStore.getState();
  const { nodes, edges } = store.unified;
  const rings = new Map(nodes.map((n) => [n.node_id, provenanceRingColors(nodeSourceIds(n), store.sourceColors)]));
  graphStore.loadInvestigationGraph(graphMode(rings), nodes, edges);
  await nextTick();
  communityStore.loadState(savedCommunities);
}

/** The traced subgraph, laid out by layer (`trace-layers`); the time-window chip filters the flows. */
function renderTraceLayers(trace: TraceContent) {
  const all = traceFlows(trace.result, trace.walked);
  const w = filters.window;
  const flows = w ? all.filter((f) => f.t >= w[0] && f.t <= w[1]) : all;
  const cols = traceColumns(trace.result, flows, trace.result.method.direction);
  const flowIds = new Set(flows.map((f) => f.id));
  graphStore.traceLayers = cols;
  graphStore.setLayoutAlgorithm('trace-layers');
  graphStore.loadInvestigationGraph(
    graphMode(new Map()),
    store.unified.nodes.filter((n) => cols.columns.has(n.node_id)),
    store.unified.edges.filter((e) => flowIds.has(e.edge_id)),
  );
}

// (Re)load the graphs once per case and graph-item set (open, add, remove).
let loadedKey: string | null = null;
async function loadWorkspace() {
  const key = `${store.current?.id}|${store.graphItems.map((s) => `${s.id}:${s.current_version}:${s.mapping?.as ?? ''}`).join(',')}`;
  if (!store.current || key === loadedKey) return;
  loadedKey = key;
  await store.loadWorkspace();
  // shortcut: the first readable exploration's style (colors, icons, labels) dresses the canvas.
  const styled = store.sourceGraphs.find((g) => g.state);
  if (styled?.state) graphStore.applyStylePreset(styled.state);
  syncGroupClusters(); // the style preset reloads the cluster state and drops the group clusters
  // Small base nodes and thin rings read better on a unified graph (05 §3).
  graphStore.updateAesthetics({ nodeSize: Math.min(graphStore.aesthetics.nodeSize, CASE_NODE_SIZE) });
  zoomToFitSoon();
}

const CASE_NODE_SIZE = 5;

/** Frames the graph once the layout has settled: case nodes arrive without
 * coordinates, so fitting right after the load frames a single point. */
function zoomToFitSoon() {
  const fit = () => canvasRef.value?.zoomToFit?.();
  const started = Date.now();
  const tick = () => {
    const running = canvasRef.value?.isLayoutRunning ?? false;
    if (!running || Date.now() - started > 4000) {
      requestAnimationFrame(fit);
      return;
    }
    setTimeout(tick, 100);
  };
  requestAnimationFrame(() => requestAnimationFrame(tick));
}

watch(
  () => props.id,
  async (id) => {
    savedCommunities = undefined;
    activeItem.value = null;
    activeAnalysis.value = null;
    decideMode.value = false;
    entityPage.value = null;
    filters.restore(null);
    await store.openInvestigation(id);
    // The journal and the brief are secondary: a failure here must not block the graph.
    store.fetchEvents().catch(() => {});
    store.fetchBrief().catch(() => {});
    await loadWorkspace();
  },
  { immediate: true },
);

watch(() => store.graphItems.map((s) => `${s.id}:${s.current_version}:${s.mapping?.as ?? ''}`).join(','), loadWorkspace);
watch([() => store.unified, activeTrace, traceView, () => filters.window, () => store.labelTemplates], render);

// Fills follow the confirmed roles (or the groups, when painting by group), without reloading the graph.
watch(
  [() => store.roles, () => store.groups, paintByGroup],
  ([roles, groups, byGroup]) => {
    if (byGroup) {
      const map = new Map<string, string>();
      for (const g of groups) for (const id of g.targets) if (!map.has(id)) map.set(id, g.color);
      graphStore.roleColors = map;
    } else graphStore.roleColors = roleColorMap(roles);
  },
  { immediate: true },
);
const legendRoles = computed(() => [...new Set(Object.values(store.roles))].sort());

// Closed groups collapse into cluster nodes (05 §5), reusing the closed-cluster rendering.
const GROUP_PREFIX = 'group:';
function removeGroupClusters() {
  for (const c of clusterStore.clusters.filter((x) => x.cluster_id.startsWith(GROUP_PREFIX))) clusterStore.deleteCluster(c.cluster_id);
}
function syncGroupClusters() {
  removeGroupClusters();
  for (const g of store.groups) {
    if (!store.groupsClosed.includes(g.id)) continue;
    clusterStore.createCluster({ cluster_id: `${GROUP_PREFIX}${g.id}`, cluster_name: g.name, cluster_class: 'group', figure: 'circle', state: 'closed', node_ids: g.targets, color: g.color });
  }
}
watch([() => store.groups, () => store.groupsClosed], syncGroupClusters, { immediate: true });

// --- analyses: context menu entries keep working, results are items ---
async function followMoney(target: ContextMenuTarget, direction: 'forward' | 'backward') {
  const ok = await analysisBar.value?.traceFrom({ type: target.type as 'node' | 'edge', id: target.id }, direction);
  if (ok === false) toast.error('No edge with an amount and a time to follow from here');
}

const TRACE_ACTIONS: ['forward' | 'backward', string][] = [
  ['forward', 'Follow the money → forward'],
  ['backward', 'Follow the money → backward'],
];
onMounted(() => {
  for (const [direction, label] of TRACE_ACTIONS) {
    contextMenu.addAction({ id: `trace-${direction}`, label, icon: Banknote, handler: (t) => followMoney(t, direction) });
  }
  contextMenu.addAction({
    id: 'path-to',
    label: 'Path to…',
    icon: Route,
    visible: (t) => t.type === 'node',
    handler: (t) => analysisBar.value?.startPath(t.id),
  });
});

function activateAnalysis(item: CaseItem) {
  activeAnalysis.value = item;
  activeItem.value = item;
  traceView.value = 'layers';
  timelineTab.value = 'result';
  timelineCollapsed.value = false;
}

// The latest version of the active analysis (a re-run adds one) stays active.
watch(
  () => store.items,
  (items) => {
    if (activeAnalysis.value) activeAnalysis.value = items.find((i) => i.id === activeAnalysis.value!.id) ?? null;
    if (activeItem.value) activeItem.value = items.find((i) => i.id === activeItem.value!.id) ?? null;
  },
);

function onRerun(tool: string) {
  analysisBar.value?.show(tool as 'trace' | 'paths' | 'links' | 'metrics');
}

function selectItem(item: CaseItem | null) {
  activeItem.value = item;
  if (item) graphStore.clearSelection();
  if (item && store.analyses.some((a) => a.id === item.id)) activateAnalysis(item);
}

function togglePanel(panel: CasePanel) {
  panels.value[panel] = !panels.value[panel];
}

/** A saved view (05 §5): chips (restored by the chips component), layout and closed groups. */
function applyView(content: CaseViewContent) {
  if ((LAYOUT_ALGORITHMS as readonly string[]).includes(content.layout) && content.layout !== 'trace-layers') {
    graphStore.setLayoutAlgorithm(content.layout as LayoutAlgorithm);
  }
  if (canEdit.value) store.saveState({ groups_closed: content.groups_closed ?? [] }).catch((e) => toast.error(getErrorMessage(e, 'Failed to apply the view')));
}

function openJournal() {
  timelineTab.value = 'activity';
  timelineCollapsed.value = false;
}

function onWizardDone(items: CaseItem[]) {
  showWizard.value = false;
  store.fetchItems().catch(() => {});
  toast.success(`Added ${items.length} file${items.length === 1 ? '' : 's'} to the case`);
}

function openUpload(role?: 'graph' | 'enrichment' | 'attachment') {
  wizardRole.value = role;
  showWizard.value = true;
}

onUnmounted(() => {
  for (const [direction] of TRACE_ACTIONS) contextMenu.removeAction(`trace-${direction}`);
  contextMenu.removeAction('path-to');
  graphStore.traceLayers = null;
  pick(null);
  resetMetricsCalculator();
  communityStore.clearCommunities();
  removeGroupClusters();
  filters.restore(null);
  graphStore.clear();
});
</script>

<template>
  <div class="workspace">
    <div v-if="store.loading && !store.current" class="loading"></div>
    <div v-else-if="store.error" class="error-message">{{ store.error }}</div>
    <template v-else-if="store.current">
      <CaseHeader :mode="mode" @decide="decideMode = true" @settings="showSettings = true" />

      <CaseDossier v-if="mode === 'dossier'" :id="id" />

      <template v-else>
        <div class="ws-body">
          <CaseItemsPanel :can-edit="canEdit" :active-item="activeItem?.id" @add="showAdd = true" @upload="openUpload()" @select="selectItem($event)" />

          <div class="center">
            <CaseFilterChips :can-edit="canEdit" @apply-view="applyView" />
            <section class="canvas-area" data-testid="graph-container">
              <div v-if="store.graphLoading || graphStore.loading" class="overlay">{{ graphStore.loadingMessage || 'Loading the case…' }}</div>
              <div v-else-if="store.graphItems.length === 0" class="overlay empty-canvas" data-testid="canvas-empty">
                <p>Nothing on the canvas yet. Add a recent exploration, start a new one from a context, or upload a file with a mapping.</p>
                <button v-if="canEdit" class="btn btn-primary btn-sm" data-testid="canvas-empty-add" @click="showAdd = true"><Plus :size="14" /> Add exploration</button>
              </div>
              <div v-if="graphStore.queryError" class="error-banner">{{ graphStore.queryError.message }}</div>

              <div v-if="store.canvasItems.length" class="legend" data-testid="provenance-legend">
                <div class="legend-title">Provenance (ring)</div>
                <div v-for="s in store.canvasItems" :key="s.id" class="legend-row">
                  <span class="ring" :style="{ borderColor: store.sourceColors[s.id] }"></span>
                  {{ s.title }}
                </div>
                <template v-if="paintByGroup && store.groups.length">
                  <div class="legend-title roles-title">Group (fill)</div>
                  <div v-for="g in store.groups" :key="g.id" class="legend-row"><span class="fill" :style="{ background: g.color }"></span>{{ g.name }}</div>
                </template>
                <template v-else-if="legendRoles.length">
                  <div class="legend-title roles-title">Role (fill)</div>
                  <div v-for="role in legendRoles" :key="role" class="legend-row">
                    <span class="fill" :style="{ background: roleColor(role) }"></span>
                    {{ role }}
                  </div>
                </template>
                <p class="muted" data-testid="unification-summary">
                  <template v-if="Object.keys(mergedCounts).length">
                    {{ Object.values(mergedCounts).reduce((a, b) => a + b, 0) }} entities merged by identity key:
                    {{ Object.entries(mergedCounts).map(([e, n]) => `${n} by ${e}`).join(', ') }}
                  </template>
                  <template v-else>No entity merged across items yet.</template>
                </p>
              </div>

              <GraphCanvas3D ref="canvasRef" @cluster-node-click="selectedClusterId = $event" />

              <div v-if="panels.filters" class="side-panel left" data-testid="panel-filters"><FilterPanel @close="panels.filters = false" /></div>
              <div v-if="panels.metrics" class="side-panel right" data-testid="panel-metrics"><MetricsPanel @close="panels.metrics = false" /></div>
              <div v-if="panels.advanced" class="side-panel right" data-testid="panel-advanced"><ClusterProgramPanel @close="panels.advanced = false" /></div>
              <div v-if="panels.layout" class="layout-panel">
                <LayoutPanel
                  :is-layout-running="canvasRef?.isLayoutRunning ?? false"
                  @start-layout="canvasRef?.startLayout()"
                  @stop-layout="canvasRef?.stopLayout()"
                  @reheat-layout="canvasRef?.reheatLayout()"
                  @scramble-layout="canvasRef?.scrambleLayout()"
                  @start-edge-type-layout="(et: string | null, s: string) => canvasRef?.startEdgeTypeLayout(et, s as any, similarityStore.useScoreAsWeight)"
                  @close="panels.layout = false"
                />
              </div>

              <AnalysisBar
                ref="analysisBar"
                :can-edit="canEdit"
                :panels="panels"
                :active-item="activeAnalysis"
                v-model:paint-by-group="paintByGroup"
                @toggle="togglePanel"
                @fit="canvasRef?.zoomToFit?.()"
                @settings="showSettings = true"
                @console="toast.info('The case console arrives with the query loop (F3): save the result as a table of the case from the Query Console')"
                @upload="openUpload('enrichment')"
                @activate="activateAnalysis"
                @select-item="selectItem"
              />
            </section>
            <div v-if="panels.table" class="table-panel" data-testid="panel-table">
              <DataTablePanel @close="panels.table = false" @focus-node="canvasRef?.focusOnNode($event)" />
            </div>
          </div>

          <SelectionInspector
            :active-item="activeItem"
            :can-edit="canEdit"
            :decide-mode="decideMode"
            @open-entity="entityPage = $event"
            @select-item="selectItem($event)"
            @activate="activateAnalysis"
            @decided="decideMode = false"
            @cancel-decide="decideMode = false"
            @trace="(t, d) => followMoney({ ...t, label: '' }, d)"
            @path-from="analysisBar?.startPath($event)"
          />
        </div>

        <CaseTimeline
          v-model:tab="timelineTab"
          v-model:collapsed="timelineCollapsed"
          :active-item="activeAnalysis"
          :can-edit="canEdit"
          :trace-view="traceView"
          @update:trace-view="traceView = $event"
          @select-item="selectItem($event)"
          @close-analysis="activeAnalysis = null"
          @rerun="onRerun"
        />

        <footer class="status-bar" data-testid="workspace-status">
          <span>{{ graphStore.nodes.length }} nodes</span>
          <span>{{ graphStore.edges.length }} edges</span>
          <span>
            {{ store.canvasItems.length }} {{ store.canvasItems.length === 1 ? 'source' : 'sources' }}<template v-if="store.restrictedItems.length"> + {{ store.restrictedItems.length }} restricted</template>
          </span>
          <span v-if="store.groups.length" data-testid="status-groups">{{ store.groups.length }} {{ store.groups.length === 1 ? 'group' : 'groups' }}</span>
          <span v-if="store.suggestions.length" data-testid="status-suggestions">● {{ store.suggestions.length }} {{ store.suggestions.length === 1 ? 'suggestion' : 'suggestions' }}</span>
          <AgentsIndicator v-if="store.current" :investigation-id="store.current.id" /><!-- F5 hook -->
          <button class="link-btn journal-btn" data-testid="journal-toggle" @click="openJournal">Journal ({{ store.events.length }})</button>
        </footer>
      </template>
    </template>

    <AddItemsPopover :open="showAdd" :investigation-id="id" @close="showAdd = false" @upload="showAdd = false; openUpload()" /><!-- F3 -->
    <FileImportWizard v-if="showWizard" :investigation-id="id" :initial-role="wizardRole" @close="showWizard = false" @done="onWizardDone" />
    <CaseSettingsDrawer :open="showSettings" @close="showSettings = false" @share="showShare = true" />
    <ShareDialog :open="showShare" @close="showShare = false" />
    <EntityPage v-if="entityPage" :node="entityPage" :can-edit="canEdit" @close="entityPage = null" @select-item="(i) => { entityPage = null; selectItem(i); }" />
    <ClusterNodeModal v-if="selectedClusterId" :cluster-id="selectedClusterId" @close="selectedClusterId = null" />

    <div v-if="pickerOrigins" class="modal-overlay" @click.self="pick(null)">
      <div class="modal picker" data-testid="expand-context-picker">
        <div class="modal-header">
          <h2>Expand from which context?</h2>
          <button class="modal-close" aria-label="Close" @click="pick(null)">&times;</button>
        </div>
        <p class="muted">This entity exists in more than one context. Its neighbors come from the one you pick.</p>
        <button v-for="o in pickerOrigins" :key="o.contextId" class="btn btn-outline picker-option" :data-testid="`expand-context-${o.contextId}`" @click="pick(o)">
          <strong>{{ contextTitle(o.contextId) }}</strong>
          <span class="muted">{{ sourceTitle(o.sourceId) }} · id {{ o.nodeId }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workspace {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.ws-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 290px 1fr 320px;
}

.center {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.canvas-area {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg-color, #fafafa);
}

.table-panel {
  max-height: 40%;
  min-height: 160px;
  overflow: auto;
  border-top: 1px solid var(--border-color);
}

.overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  pointer-events: none;
}

.empty-canvas {
  flex-direction: column;
  gap: 10px;
}

.empty-canvas p {
  margin: 0;
  max-width: 360px;
  text-align: center;
}

.empty-canvas button {
  pointer-events: auto;
}

.error-banner {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 6;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--color-error);
  color: #fff;
  font-size: 12px;
}

.legend {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 4;
  max-width: 260px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  font-size: 12px;
}

.legend-title {
  margin-bottom: 4px;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.legend-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.legend p {
  margin: 8px 0 0;
}

.ring {
  width: 10px;
  height: 10px;
  border: 2px solid;
  border-radius: 50%;
}

.roles-title {
  margin-top: 10px;
}

.fill {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.side-panel {
  position: absolute;
  top: 12px;
  bottom: 60px;
  z-index: 7;
  width: 320px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.12));
}

.side-panel.left {
  left: 12px;
}

.side-panel.right {
  right: 12px;
}

.layout-panel {
  position: absolute;
  bottom: 56px;
  left: 12px;
  z-index: 7;
}

.link-btn {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--color-primary);
  cursor: pointer;
}

.journal-btn {
  margin-left: auto;
}

.status-bar {
  display: flex;
  gap: 24px;
  padding: 6px 16px;
  border-top: 1px solid var(--border-color);
  font-size: 12px;
  color: var(--text-muted);
}

.picker {
  max-width: 420px;
  padding-bottom: 16px;
}

.picker > p,
.picker-option {
  margin: 8px 16px 0;
}

.picker-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: calc(100% - 32px);
}
</style>
