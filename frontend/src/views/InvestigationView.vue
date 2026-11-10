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
import { useRoute, useRouter, type LocationQuery } from 'vue-router';
import { Banknote, Plus, Route } from 'lucide-vue-next';
import { isGraphItem, useInvestigationStore } from '@/stores/investigation';
import { defaultForce3DSettings, defaultLayoutModeConfig, resolveInitialBehaviors, useGraphStore, type InvestigationGraphMode } from '@/stores/graph';
import { useCommunityStore } from '@/stores/community';
import { useSimilarityStore } from '@/stores/similarity';
import { useClusterStore } from '@/stores/cluster';
import { useCaseFilters } from '@/stores/caseFilters';
import { useItemViewerStore } from '@/stores/itemViewer';
import { useContextMenu, type ContextMenuTarget } from '@/composables/useContextMenu';
import { useCommunityMenuActions } from '@/composables/useCommunityMenuActions';
import { useClusterProgramMenuActions } from '@/composables/useClusterProgramMenuActions';
import { useConfigurableMenuActions } from '@/composables/useConfigurableMenuActions';
import { useContextMenuActionsStore } from '@/stores/contextMenuActions';
import { useCanvasFullscreen } from '@/composables/useCanvasFullscreen';
import type { LookTab } from '@/stores/toolbar';
import { useToast } from '@/composables/useToast';
import { useLiveRevision } from '@/composables/useLiveRevision';
import { useAuthStore } from '@/stores/auth';
import type { TraceContent } from '@/composables/useCaseAnalyses';
import { resetMetricsCalculator } from '@/services/metricsCalculator';
import { caseNodeLabel } from '@/utils/caseLabels';
import { provenanceRingColors, roleColorMap } from '@/utils/graphAppearance';
import { getErrorMessage } from '@/utils/errorMessage';
import { traceColumns, traceFlows } from '@/utils/traceView';
import { baseSourceId, nodeSourceIds, type NodeOrigin, type UnifiedNode } from '@/utils/unifyGraph';
import { layoutBlockChanged, mapLookToCanvas, mapLookToItem, resolveCanvasLook, toUnifiedId } from '@/utils/caseLook';
import { LAYOUT_ALGORITHMS, type LayoutAlgorithm } from '@/types/graph';
import GraphCanvas3D from '@/components/GraphCanvas3D.vue';
import LayoutPanel from '@/components/LayoutPanel.vue';
import FilterPanel from '@/components/FilterPanel.vue';
import DataTablePanel from '@/components/DataTablePanel.vue';
import MetricsPanel from '@/components/MetricsPanel.vue';
import ClusterProgramPanel from '@/components/ClusterProgramPanel.vue';
import ClusterNodeModal from '@/components/ClusterNodeModal.vue';
import CommunityNodeModal from '@/components/CommunityNodeModal.vue';
import ClusterProgramRunHost from '@/components/ClusterProgramRunHost.vue';
import DetailModal from '@/components/DetailModal.vue';
import LookPanel from '@/components/LookPanel.vue';
import GraphCanvasToolbar, { type CanvasToolbarButton } from '@/components/GraphCanvasToolbar.vue';
import GraphStatusBar from '@/components/GraphStatusBar.vue';
import TemplateExecuteModal from '@/components/TemplateExecuteModal.vue';
import CaseGraphChips from '@/components/investigation/CaseGraphChips.vue';
import GroupLegend from '@/components/GroupLegend.vue';
import CaseHeader from '@/components/investigation/CaseHeader.vue';
import CaseItemsPanel from '@/components/investigation/CaseItemsPanel.vue';
import CaseFilterChips from '@/components/investigation/CaseFilterChips.vue';
import AnalysisBar, { type CasePanel } from '@/components/investigation/AnalysisBar.vue';
import SelectionInspector from '@/components/investigation/SelectionInspector.vue';
import CaseTimeline, { type TimelineTab } from '@/components/investigation/CaseTimeline.vue';
import AgentsIndicator from '@/components/investigation/AgentsIndicator.vue'; // F5 hook
import CaseSettingsDrawer from '@/components/investigation/CaseSettingsDrawer.vue';
import EntityPage from '@/components/investigation/EntityPage.vue';
import ItemViewer from '@/components/investigation/ItemViewer.vue';
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
const auth = useAuthStore();

// What an agent or someone else does in the case (material, notes, an exploration it
// references) shows up without a reload.
useLiveRevision({
  targets: () => ({ case: store.current?.id }),
  paused: () => store.loading || store.graphLoading,
  onUpdate: async (live) => {
    const info = store.current ? live.cases[store.current.id] : null;
    if (!info) return;
    const foreign = await store.syncLive(info, auth.email);
    if (!foreign.length) return;
    const agents = foreign.filter((e) => e.actor_kind === 'agent');
    const who = agents.length ? (agents[0].agent_name ?? 'An agent') : (foreign[0].actor_email ?? 'Someone');
    toast.info(`${who} updated the case (${foreign.length} change${foreign.length === 1 ? '' : 's'})`);
  },
});

const mode = computed<'canvas' | 'dossier'>(() => (route.query.mode === 'dossier' ? 'dossier' : 'canvas'));

/**
 * The full-screen item viewer lives in the URL (`?view=<item>&v=<n>`): a link
 * opens it, Back closes it. Opening from the case pushes a history entry (so
 * Back or closing returns to the case); stepping to another item replaces it.
 */
const router = useRouter();
const itemViewer = useItemViewerStore();
let viewerPushed = false;
const viewerQuery = (query: LocationQuery) => ({
  itemId: typeof query.view === 'string' && query.view ? query.view : null,
  version: typeof query.v === 'string' && /^\d+$/.test(query.v) ? Number(query.v) : null,
});
watch(
  () => viewerQuery(route.query),
  ({ itemId, version }) => {
    const open = itemViewer.target;
    if (!itemId) {
      viewerPushed = false;
      if (open) itemViewer.close();
    } else if (open?.itemId !== itemId || open.version !== version) {
      itemViewer.open(itemId, version);
    }
  },
  { immediate: true, deep: true },
);
watch(
  () => itemViewer.target,
  (target) => {
    const inUrl = viewerQuery(route.query);
    const { view: _view, v: _v, ...rest } = route.query;
    if (!target) {
      if (!inUrl.itemId) return;
      if (viewerPushed) {
        viewerPushed = false;
        router.back();
      } else void router.replace({ query: rest });
      return;
    }
    if (inUrl.itemId === target.itemId && inUrl.version === target.version) return;
    const query = { ...rest, view: target.itemId, ...(target.version ? { v: String(target.version) } : {}) };
    if (inUrl.itemId) void router.replace({ query });
    else {
      viewerPushed = true;
      void router.push({ query });
    }
  },
);

const showAdd = ref(false);
/** The add popover's first tab: the analysis bar's Console opens it on "Query". */
const addTab = ref<'query' | undefined>(undefined);
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
const panels = ref<Record<CasePanel, boolean>>({ filters: false, table: false, metrics: false, layout: false, look: false, clusters: false });
const lookTab = ref<LookTab>('style');
const canvasRef = ref<InstanceType<typeof GraphCanvas3D> | null>(null);
const canvasAreaRef = ref<HTMLElement | null>(null);
const { isFullscreen, toggle: toggleFullscreen } = useCanvasFullscreen(canvasAreaRef);
/** The analysis bar's height: the panels over the canvas stop above it. */
const bottomBarHeight = ref(48);
const showDetailModal = ref(false);
const detailModalItem = computed(() => {
  if (!showDetailModal.value) return null;
  if (graphStore.selectedNode) return { type: 'node' as const, data: graphStore.selectedNode };
  if (graphStore.selectedEdge) return { type: 'edge' as const, data: graphStore.selectedEdge };
  return null;
});

/** The context of the one graph on the canvas: whose presets and menu actions apply. */
const canvasContextId = computed(() => (store.canvasItems.length === 1 ? store.canvasItems[0].context_id ?? null : null));
const canWritePresets = computed(() => !!(canvasContextId.value && store.contexts[canvasContextId.value]?.has_write_access));

function openLook(tab: LookTab) {
  lookTab.value = tab;
  panels.value.look = true;
}

function setViewMode(mode: '3d' | '2d-proj') {
  graphStore.updateBehaviors({ viewMode: mode });
}

function exportPng() {
  canvasRef.value?.exportPNG(`${store.current?.title || 'case'}.png`, 2, 'white');
}

// Right-click: the context's configured actions (open a URL, copy), cluster
// programs and the community table — the same menu the exploration has.
// Query-template actions are the exploration's: running one replaces the graph.
const communityTable = useCommunityMenuActions();
const clusterProgramActions = useClusterProgramMenuActions();
const configurableMenuActions = useConfigurableMenuActions();
const { pendingTemplateExecution } = configurableMenuActions;
const menuActionsStore = useContextMenuActionsStore();
watch(
  canvasContextId,
  (id) => {
    const configs = id ? (store.contexts[id]?.context_menu_actions ?? []) : [];
    menuActionsStore.hydrateFromContext(configs.filter((c) => c.kind !== 'run-query-template'));
    // The Clusters panel offers that context's programs (the built-ins only on
    // a canvas with several graphs: a program is written for one schema).
    clusterStore.hydrateProgramsFromContext(id ? store.contexts[id]?.cluster_programs : undefined);
  },
  { immediate: true },
);
watch(() => store.contexts, () => {
  const id = canvasContextId.value;
  if (!id) return;
  menuActionsStore.hydrateFromContext((store.contexts[id]?.context_menu_actions ?? []).filter((c) => c.kind !== 'run-query-template'));
  clusterStore.hydrateProgramsFromContext(store.contexts[id]?.cluster_programs);
});
const dossierRef = ref<InstanceType<typeof CaseDossier> | null>(null);

/** Decide: the inspector's panel on the canvas, the dossier's own panel in the dossier. */
function onDecide() {
  if (mode.value === 'dossier') void dossierRef.value?.startDecision();
  else decideMode.value = true;
}
// A decision started on one side does not reopen on the other.
watch(mode, () => (decideMode.value = false));
const analysisBar = ref<InstanceType<typeof AnalysisBar> | null>(null);

const sourceTitle = (sourceId: string) => store.itemTitle(baseSourceId(sourceId));
const contextTitle = (contextId: string) => store.contexts[contextId]?.title ?? store.itemTitle(contextId);
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
  // Another graph picked (legend, row, "All graphs", a view): a clean canvas, laid out on its
  // own like its exploration, with none of the previous graph's positions or communities.
  const fresh = freshNext;
  freshNext = false;
  if (fresh) {
    savedCommunities = undefined;
    communityStore.clearCommunities();
  } else if (graphStore.nodes.length) savedCommunities = communityStore.getState();
  const { nodes, edges } = store.unified;
  const rings = new Map(nodes.map((n) => [n.node_id, provenanceRingColors(nodeSourceIds(n), store.sourceColors)]));
  graphStore.loadInvestigationGraph(graphMode(rings), nodes, edges, { fresh });
  armDefaultFocus();
  await nextTick();
  if (!fresh) communityStore.loadState(savedCommunities);
  // The cluster store drops every cluster when the nodes change: the closed
  // groups come back as cluster nodes once the new graph is in.
  syncGroupClusters();
}

/** Set before switching graphs: the next render starts from a clean canvas. */
let freshNext = false;
/** Shows other graphs on a clean canvas (see `render`). */
function switchCanvas(change: () => Promise<unknown> | unknown) {
  freshNext = true;
  void change();
  // The render the change triggers has run by the next tick; a change that moved nothing must
  // not leave the flag for an unrelated update.
  void nextTick().then(() => (freshNext = false));
  zoomToFitSoon();
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
  applyCanvasStyle();
  zoomToFitSoon();
}

/**
 * The canvas wears the look of the graph it shows (utils/caseLook): the look saved
 * on the item, else its exploration's (or the style a frozen item embeds), else
 * the stock look — never whatever the previous page or case left in the store.
 * On a unified canvas the first canvas item with a style decides. Re-applied
 * whenever the canvas, an item's version or saved look, or a source's revision
 * changes (a live refresh of the exploration's style lands too).
 */
const resolvedLook = computed(() => resolveCanvasLook(store.canvasItems, store.sourceGraphs, store.contexts));
let appliedLookKey: string | null = null;
let focusedKey: string | null = null;
function applyCanvasStyle() {
  const r = resolvedLook.value;
  if (store.graphLoading || r.key === appliedLookKey) return;
  appliedLookKey = r.key;
  // A look whose layout block matches what is on screen only recolors: no re-layout.
  const fresh = layoutBlockChanged(graphStore.buildStylePreset(), r.look, {
    layout_mode_config: defaultLayoutModeConfig(),
    force3d_settings: defaultForce3DSettings(),
  });
  // A trace laid out by layer keeps its columns whatever the look says.
  const layoutLocked = graphStore.layoutAlgorithm === 'trace-layers';
  // The context's default behaviors are the baseline a look's own behaviors land on.
  if (r.behaviors) graphStore.behaviors = resolveInitialBehaviors(r.behaviors);
  if (r.look) {
    const mapped = mapLookToCanvas(r.look, (r.sourceId ?? r.contextItemId)!, store.unified.nodes);
    const { layout_algorithm: _la, layout_mode_config: _lm, ...withoutLayout } = mapped;
    graphStore.applyStylePreset(layoutLocked ? withoutLayout : mapped, { freshLayout: fresh && !layoutLocked });
  } else {
    graphStore.resetLook({ freshLayout: fresh && !layoutLocked });
    // Small base nodes read better on a case canvas with no look of its own (05 §3).
    graphStore.updateAesthetics({ nodeSize: Math.min(graphStore.aesthetics.nodeSize, CASE_NODE_SIZE) });
  }
  syncGroupClusters(); // the look reloads the cluster state and drops the group clusters
}

/**
 * The default focus, once per canvas and focus. Armed by `render()` right after
 * the nodes land in the store: armed earlier, the canvas would look the node up
 * in the previous graph (or none) and drop it as missing.
 */
function armDefaultFocus() {
  const focus = resolvedLook.value.focus;
  const focusKey = focus ? `${[...store.canvasIds].join(',')}|${focus.sourceId}:${focus.nodeId}` : null;
  if (!focusKey) {
    focusedKey = null;
    return;
  }
  if (focusKey === focusedKey || !store.unified.nodes.length) return; // an empty render (sources still loading) retries later
  const id = toUnifiedId(store.unified.nodes, focus!.sourceId, focus!.nodeId);
  if (id) graphStore.pendingFocusNodeId = id;
  focusedKey = focusKey; // a node that is not in the graph arms nothing, and is not asked again until the canvas changes
}
watch(() => [resolvedLook.value.key, store.graphLoading], () => applyCanvasStyle());

/** The one graph on the canvas, when there is exactly one: the item a look or a focus is saved on. */
const singleCanvasItem = computed(() => (store.canvasItems.length === 1 ? store.canvasItems[0] : null));
const lookCaption = computed(() => {
  const r = resolvedLook.value;
  if (r.contextId) return `Default look of “${contextTitle(r.contextId)}”`;
  if (!r.sourceId) return 'Default look';
  const title = store.itemTitle(r.sourceId);
  return store.canvasItems.length > 1 ? `Unified canvas · look from “${title}”` : `Look of “${title}”`;
});
const saveLookBlockedReason = computed(() => {
  if (!canEdit.value) return 'Read-only case';
  if (!singleCanvasItem.value) return 'Pick one graph in the legend to save its look';
  return null;
});
async function saveLook() {
  const item = singleCanvasItem.value;
  if (!item || saveLookBlockedReason.value) return;
  const look = {
    ...mapLookToItem(graphStore.buildStylePreset(), item.id, store.unified.nodes),
    ...(item.state?.look && 'focus_node_id' in item.state.look ? { focus_node_id: item.state.look.focus_node_id } : {}),
  };
  try {
    await store.updateItem(item.id, { state: { ...(item.state ?? {}), look } });
    toast.success(`Look saved on “${item.title}”`);
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to save the look'));
  }
}
async function resetSavedLook() {
  const item = singleCanvasItem.value;
  if (!item) return;
  try {
    await store.updateItem(item.id, { state: { ...(item.state ?? {}), look: null } });
    toast.success(`“${item.title}” is back to its own look`);
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to reset the look'));
  }
}

/**
 * Legend click: only this graph, on a clean canvas; with Shift (or Ctrl/⌘), add it to or take
 * it off the canvas, keeping the layout of the others.
 */
function pickCanvasItem(id: string, event: MouseEvent) {
  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    void store.toggleCanvas(id, !store.canvasIds.has(id));
    zoomToFitSoon();
  } else if (!(store.canvasItems.length === 1 && store.canvasIds.has(id))) {
    switchCanvas(() => store.showOnly(id));
  }
}

function showAllOnCanvas() {
  if (!store.allOnCanvas) switchCanvas(() => store.showAll());
}

/** A graph picked in the material list is shown alone, like the legend; other items only select. */
function onMaterialSelect(item: CaseItem) {
  selectItem(item);
  if (isGraphItem(item) && item.accessible && !(store.canvasItems.length === 1 && store.canvasIds.has(item.id))) {
    switchCanvas(() => store.showOnly(item.id));
  }
}

const CASE_NODE_SIZE = 5;

/** Frames the graph once the layout has settled: case nodes arrive without
 * coordinates, so fitting right after the load frames a single point. A
 * pending default focus wins over the fit (the canvas's `frame`). */
function zoomToFitSoon() {
  const fit = () => (canvasRef.value?.frame ? canvasRef.value.frame() : canvasRef.value?.zoomToFit?.());
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
    graphStore.clearIsolation();
    await store.openInvestigation(id);
    // The journal and the brief are secondary: a failure here must not block the graph.
    store.fetchEvents().catch(() => {});
    store.fetchBrief().catch(() => {});
    await loadWorkspace();
  },
  { immediate: true },
);

watch(() => store.graphItems.map((s) => `${s.id}:${s.current_version}:${s.mapping?.as ?? ''}`).join(','), loadWorkspace);
// Enrichment files (BYOD-2) add properties to the canvas: a new file or version is fetched, nothing reloads.
watch(
  () => store.items.filter((i) => i.kind === 'table' && i.mapping?.as === 'enrichment').map((i) => `${i.id}:${i.current_version}`).join(','),
  () => void store.loadEnrichments(),
);
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
  communityTable.register();
  clusterProgramActions.register();
  configurableMenuActions.register();
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
  if (content.canvas_items) switchCanvas(() => store.setCanvas(content.canvas_items!));
  if (canEdit.value) store.saveState({ groups_closed: content.groups_closed ?? [] }).catch((e) => toast.error(getErrorMessage(e, 'Failed to apply the view')));
}

/** A journal line about an entity: selected and framed on the canvas. */
function focusEntity(id: string) {
  activeItem.value = null;
  graphStore.selectNode(id);
  canvasRef.value?.focusOnNode?.(id);
}

async function reloadCase() {
  await store.openInvestigation(props.id);
  store.fetchEvents().catch(() => {});
  store.fetchBrief().catch(() => {});
  loadedKey = null;
  await loadWorkspace();
}

function openJournal() {
  timelineTab.value = 'activity';
  timelineCollapsed.value = false;
}

function onWizardDone(items: CaseItem[]) {
  showWizard.value = false;
  store.fetchItems().catch(() => {});
  // A file mapped as a graph is what the person wants to see next.
  const graphs = items.filter(isGraphItem).map((i) => i.id);
  if (graphs.length) void store.setCanvas(graphs);
  toast.success(`Added ${items.length} file${items.length === 1 ? '' : 's'} to the case`);
}

function openUpload(role?: 'graph' | 'enrichment' | 'attachment') {
  wizardRole.value = role;
  showWizard.value = true;
}

onUnmounted(() => {
  itemViewer.close();
  communityTable.unregister();
  clusterProgramActions.unregister();
  configurableMenuActions.unregister();
  menuActionsStore.hydrateFromContext([]);
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
    <p v-if="store.loading && !store.current" class="loading-line" data-testid="case-loading">
      <span class="spinner" aria-hidden="true"></span> Opening the case…
    </p>
    <div v-else-if="store.error" class="error-message case-error" data-testid="case-error">
      {{ store.error }}
      <button class="btn btn-outline btn-sm" data-testid="case-retry" @click="reloadCase">Retry</button>
      <RouterLink to="/investigations" class="btn btn-outline btn-sm">← Queue</RouterLink>
    </div>
    <template v-else-if="store.current">
      <CaseHeader :mode="mode" @decide="onDecide" @settings="showSettings = true" />

      <CaseDossier v-if="mode === 'dossier'" :id="id" ref="dossierRef" />

      <template v-else>
        <div class="ws-body">
          <CaseItemsPanel :can-edit="canEdit" :active-item="activeItem?.id" @add="showAdd = true" @upload="openUpload()" @select="onMaterialSelect" />

          <div class="center">
            <div class="strip">
              <CaseGraphChips
                :paint-by-group="paintByGroup"
                @pick="pickCanvasItem"
                @show-all="showAllOnCanvas"
                @show-one="(e: MouseEvent) => pickCanvasItem(store.canvasItems[0].id, e)"
              />
              <GraphCanvasToolbar
                class="strip-toolbar"
                compact
                :buttons="['filters', 'table', 'layout', 'look', 'clusters', 'fit', 'export']"
                :active="{ filters: panels.filters, table: panels.table, layout: panels.layout, look: panels.look, clusters: panels.clusters }"
                :view-mode="graphStore.behaviors.viewMode"
                :is-fullscreen="isFullscreen"
                :test-ids="{ filters: 'workspace-filters-btn', table: 'workspace-table-btn', layout: 'workspace-layout-btn', look: 'workspace-look-btn', clusters: 'workspace-clusters-btn', fit: 'workspace-fit-btn', export: 'workspace-export-btn' }"
                @toggle="(id: CanvasToolbarButton) => togglePanel(id as CasePanel)"
                @fit="canvasRef?.zoomToFit?.()"
                @fullscreen="toggleFullscreen"
                @view-mode="setViewMode"
                @export="exportPng"
              />
            </div>
            <CaseFilterChips :can-edit="canEdit" @apply-view="applyView" />
            <!-- The groups (communities, program clusters) as chips while the Clusters panel is closed -->
            <GroupLegend v-if="!panels.clusters" variant="chips" class="group-strip" @open-panel="panels.clusters = true" />
            <div v-if="graphStore.queryError" class="error-banner" data-testid="canvas-error">{{ graphStore.queryError.message }}</div>
            <section ref="canvasAreaRef" class="canvas-area" :class="{ fullscreen: isFullscreen }" :style="{ '--canvas-bottom-bar': `${bottomBarHeight}px` }" data-testid="graph-container">
              <div v-if="store.graphLoading || graphStore.loading" class="overlay">{{ graphStore.loadingMessage || 'Loading the case…' }}</div>
              <div v-else-if="store.graphItems.length === 0" class="overlay empty-canvas" data-testid="canvas-empty">
                <p>Nothing on the canvas yet. Add a recent exploration, start a new one from a context, or upload a file with a mapping.</p>
                <button v-if="canEdit" class="btn btn-primary btn-sm" data-testid="canvas-empty-add" @click="showAdd = true"><Plus :size="14" /> Add exploration</button>
              </div>
              <div v-else-if="!store.canvasItems.length && store.readableGraphItems.length" class="overlay empty-canvas" data-testid="canvas-none-selected">
                <p>No graph on the canvas. Pick one in the legend or tick it in the material list.</p>
                <button class="btn btn-outline btn-sm" @click="showAllOnCanvas">Show all graphs</button>
              </div>
              <GraphCanvas3D ref="canvasRef" @cluster-node-click="selectedClusterId = $event" />

              <div v-if="panels.filters" class="side-panel left" data-testid="panel-filters"><FilterPanel @close="panels.filters = false" /></div>
              <div v-if="panels.metrics" class="side-panel right" data-testid="panel-metrics"><MetricsPanel @close="panels.metrics = false" /></div>
              <div v-if="panels.clusters" class="side-panel right" data-testid="panel-clusters"><ClusterProgramPanel @close="panels.clusters = false" /></div>
              <div v-if="panels.look" class="side-panel right look-host" data-testid="panel-look">
                <LookPanel
                  v-model:tab="lookTab"
                  class="fill"
                  presets-apply="store"
                  :presets-context-id="canvasContextId"
                  :can-write-presets="canWritePresets"
                  :caption="lookCaption"
                  @close="panels.look = false"
                  @applied="syncGroupClusters"
                >
                  <template #footer>
                    <div class="look-footer">
                      <button
                        class="btn btn-primary btn-sm"
                        :disabled="!!saveLookBlockedReason"
                        :title="saveLookBlockedReason ?? 'Save the look on screen on this graph item: it opens like this for everyone in the case'"
                        data-testid="style-save-look"
                        @click="saveLook"
                      >
                        Save look
                      </button>
                      <button
                        v-if="singleCanvasItem?.state?.look"
                        class="btn btn-outline btn-sm"
                        :disabled="!canEdit"
                        title="Drop the saved look: back to the exploration's own (or the stock look)"
                        data-testid="style-reset-look"
                        @click="resetSavedLook"
                      >
                        Reset look
                      </button>
                      <span v-if="saveLookBlockedReason" class="muted" data-testid="style-save-look-reason">{{ saveLookBlockedReason }}</span>
                    </div>
                  </template>
                </LookPanel>
              </div>
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
                @height="bottomBarHeight = $event"
                @settings="showSettings = true"
                @console="addTab = 'query'; showAdd = true"
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
            @open-details="showDetailModal = true"
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
          @focus-entity="focusEntity"
          @close-analysis="activeAnalysis = null"
          @rerun="onRerun"
        />

        <GraphStatusBar
          :nodes="graphStore.nodes.length"
          :edges="graphStore.edges.length"
          test-id="workspace-status"
          @open-behaviors="openLook('behaviors')"
          @show-clusters="panels.clusters = true"
        >
          <span>
            {{ store.canvasItems.length }} {{ store.canvasItems.length === 1 ? 'source' : 'sources' }}<template v-if="store.restrictedItems.length"> + {{ store.restrictedItems.length }} restricted</template>
          </span>
          <span v-if="store.groups.length" data-testid="status-groups">{{ store.groups.length }} {{ store.groups.length === 1 ? 'group' : 'groups' }}</span>
          <span v-if="store.suggestions.length" data-testid="status-suggestions">● {{ store.suggestions.length }} {{ store.suggestions.length === 1 ? 'suggestion' : 'suggestions' }}</span>
          <AgentsIndicator v-if="store.current" :investigation-id="store.current.id" /><!-- F5 hook -->
          <button class="link-btn journal-btn" data-testid="journal-toggle" @click="openJournal">Journal</button>
        </GraphStatusBar>
      </template>
    </template>

    <AddItemsPopover
      :open="showAdd"
      :investigation-id="id"
      :initial-tab="addTab"
      @close="showAdd = false; addTab = undefined"
      @upload="showAdd = false; openUpload()"
    /><!-- F3; Console opens it on a saved query of the case -->
    <FileImportWizard v-if="showWizard" :investigation-id="id" :initial-role="wizardRole" @close="showWizard = false" @done="onWizardDone" />
    <CaseSettingsDrawer :open="showSettings" @close="showSettings = false" @share="showShare = true" />
    <ShareDialog :open="showShare" @close="showShare = false" />
    <ItemViewer v-if="itemViewer.target && store.current" />
    <EntityPage v-if="entityPage" :node="entityPage" :can-edit="canEdit" @close="entityPage = null" @select-item="(i) => { entityPage = null; selectItem(i); }" />
    <ClusterNodeModal v-if="selectedClusterId" :cluster-id="selectedClusterId" @close="selectedClusterId = null" />
    <ClusterProgramRunHost />
    <CommunityNodeModal :community-id="communityTable.selectedCommunityId.value" @close="communityTable.close()" />
    <DetailModal :item="detailModalItem" @close="showDetailModal = false" />
    <TemplateExecuteModal
      v-if="pendingTemplateExecution"
      :template="pendingTemplateExecution.template"
      :initial-values="pendingTemplateExecution.initialValues"
      @close="pendingTemplateExecution = null"
    />

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
.group-strip {
  padding: 4px 12px;
  border-bottom: 1px solid var(--border-color);
}

.loading-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 24px;
  color: var(--text-muted);
}

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-color);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.case-error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 16px;
}

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

.strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--color-surface);
}

.strip-toolbar {
  margin-left: auto;
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

.canvas-area.fullscreen {
  position: fixed;
  inset: 0;
  z-index: 1000;
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
  padding: 6px 12px;
  background: var(--color-error);
  color: #fff;
  font-size: 12px;
}

.side-panel {
  position: absolute;
  top: 12px;
  /* Stops above the analysis bar, whatever its height. */
  bottom: calc(var(--canvas-bottom-bar, 48px) + 24px);
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
  bottom: calc(var(--canvas-bottom-bar, 48px) + 20px);
  left: 12px;
  z-index: 7;
}

.look-host {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.look-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
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
