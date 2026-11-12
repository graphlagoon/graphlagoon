<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, type Ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useCurrentCaseStore } from '@/stores/currentCase';
import { useGraphStore } from '@/stores/graph';
import { useToolbarStore, type LookTab, type PanelId } from '@/stores/toolbar';
import { useQueryConsoleStore } from '@/stores/queryConsole';
import { useClusterStore } from '@/stores/cluster';
import { useCommunityStore } from '@/stores/community';
import { useSimilarityStore } from '@/stores/similarity';
import GraphCanvas3D from '@/components/GraphCanvas3D.vue';
import SidePanel from '@/components/SidePanel.vue';
import FilterPanel from '@/components/FilterPanel.vue';
import LayoutPanel from '@/components/LayoutPanel.vue';
import GraphQueryPanel from '@/components/GraphQueryPanel.vue';
import ContextInfoPanel from '@/components/ContextInfoPanel.vue';
import MetricsPanel from '@/components/MetricsPanel.vue';
import ResourceMonitorModal from '@/components/ResourceMonitorModal.vue';
import LookPanel from '@/components/LookPanel.vue';
import GraphCanvasToolbar, { type CanvasToolbarButton } from '@/components/GraphCanvasToolbar.vue';
import GroupLegend from '@/components/GroupLegend.vue';
import GraphStatusBar from '@/components/GraphStatusBar.vue';
import { useCanvasFullscreen } from '@/composables/useCanvasFullscreen';
import QueryErrorModal from '@/components/QueryErrorModal.vue';
import QueryRunningState from '@/components/QueryRunningState.vue';
import ClusterProgramPanel, { type ClustersTab } from '@/components/ClusterProgramPanel.vue';
import ClusterNodeModal from '@/components/ClusterNodeModal.vue';
import CommunityNodeModal from '@/components/CommunityNodeModal.vue';
import ClusterProgramRunHost from '@/components/ClusterProgramRunHost.vue';
import { resetMetricsCalculator } from '@/services/metricsCalculator';
import { contextDefaultLook } from '@/utils/caseLook';
import { storedDefaultLook, toDefaultLook, useContextDefaultLook, type DefaultLook } from '@/composables/useContextDefaultLook';
import { getErrorMessage } from '@/utils/errorMessage';
import { useCommunityMenuActions } from '@/composables/useCommunityMenuActions';
import { useClusterProgramMenuActions } from '@/composables/useClusterProgramMenuActions';
import { useConfigurableMenuActions } from '@/composables/useConfigurableMenuActions';
import { useContextMenuActionsStore } from '@/stores/contextMenuActions';
import ContextMenuActionsModal from '@/components/ContextMenuActionsModal.vue';
import TemplateExecuteModal from '@/components/TemplateExecuteModal.vue';
import DetailModal from '@/components/DetailModal.vue';
import DataTablePanel from '@/components/DataTablePanel.vue';
import YourDataButton from '@/components/YourDataButton.vue';
import QueryConsolePanel from '@/components/QueryConsolePanel.vue';
import QueryTemplatesPanel from '@/components/QueryTemplatesPanel.vue';
import PrecomputedGraphPanel from '@/components/PrecomputedGraphPanel.vue';
import SchemaDriftModal from '@/components/SchemaDriftModal.vue';
import { TerminalSquare, AlertCircle, Network } from 'lucide-vue-next';
import { useToast } from '@/composables/useToast';
import { useLiveRevision } from '@/composables/useLiveRevision';
import { describeSummary } from '@/utils/liveMerge';
import {
  layoutQuerySignature,
  parseLayoutOverrides,
  summarizeLayoutIssues,
  type LayoutOverrideIssue,
  type QueryLike,
} from '@/utils/layoutUrlOverrides';
import {
  precomputedName,
  precomputedParams,
  precomputedQuerySignature,
} from '@/utils/precomputedUrlParams';
import {
  parseTemplateUrl,
  resolveTemplateExecution,
  summarizeTemplateIssues,
  templateQuerySignature,
  type ParsedTemplateUrl,
  type TemplateUrlIssue,
} from '@/utils/templateUrlParams';
import { useQueryTemplatesStore } from '@/stores/queryTemplates';
import { useTemplateExecution } from '@/composables/useTemplateExecution';
import { uuidOrNull } from '@/utils/uuid';
import {
  capabilitiesFor,
  resolveDatasourceType,
} from '@/composables/useDatasourceCapabilities';

const props = defineProps<{
  contextId: string;
}>();

const route = useRoute();
const currentCaseStore = useCurrentCaseStore();
/** `?case=<id>`: a new exploration started from the case popover (F3). */
const caseReturnId = computed(() => uuidOrNull(route.query.case));
const toast = useToast();


/**
 * Layout parameters the URL asked for but could not be applied.
 *
 * View-local rather than store state: parsing does no I/O and is driven entirely
 * by the router, which the graph store deliberately does not depend on. Keeping
 * it here also stops it leaking into buildStylePreset/getExplorationState, which
 * serialize a broad slice of the store.
 */
const layoutOverrideIssues = ref<LayoutOverrideIssue[]>([]);
const layoutOverrideIssuesTitle = computed(() =>
  summarizeLayoutIssues(layoutOverrideIssues.value),
);

/**
 * Why a `?template=` link did not run, and which one is on screen when it did.
 *
 * View-local for the same reason layoutOverrideIssues is: driven entirely by
 * the router, and it must not leak into buildStylePreset/getExplorationState.
 */
const templateIssues = ref<TemplateUrlIssue[]>([]);
const templateIssuesTitle = computed(() =>
  summarizeTemplateIssues(templateIssues.value),
);
const activeUrlTemplate = ref<{
  name: string;
  values: Record<string, string>;
} | null>(null);
const activeUrlTemplateTitle = computed(() => {
  if (!activeUrlTemplate.value) return '';
  const args = Object.entries(activeUrlTemplate.value.values)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${value}`);
  // Name the values, or two links differing only by ?template.depth= would
  // produce two identical-looking chips — same reasoning as the precomputed
  // chip's arguments.
  const withArgs = args.length ? ` Parameters: ${args.join(', ')}.` : '';
  return `Query template “${activeUrlTemplate.value.name}”, run from the URL.${withArgs}`;
});
// Guards STALE CHIP WRITES only — two rapid URL edits must not let the older
// run's outcome land on top of the newer one's. Query ordering itself belongs
// to the graph store's own job handling.
let templateRunToken = 0;

// Opened by the "Check context schema" CTA in QueryErrorModal (a stale-schema
// query failure) and by the drift banner below (an enrichment failure, or a
// clean automatic column check surfacing a warning/info-level finding).
const schemaDriftModalOpen = ref(false);

function reviewContextSchema() {
  schemaDriftModalOpen.value = true;
}

const graphStore = useGraphStore();

// What an agent (or another tab) saves into the open exploration shows up in place.
useLiveRevision({
  targets: () => ({ exploration: graphStore.currentExploration?.id }),
  paused: () => graphStore.loading,
  onUpdate: async (live) => {
    const exp = graphStore.currentExploration;
    const info = exp ? live.explorations[exp.id] : null;
    if (!exp || !info || info.revision <= (exp.state.revision ?? 0)) return;
    const change = await graphStore.applyRemoteChange();
    if (!change) return;
    const who = change.author_kind === 'agent' ? `An agent${change.by ? ` (for ${change.by})` : ''}` : (change.by ?? 'Someone');
    const what = describeSummary(change.summary);
    toast.info(`${who} changed this exploration${what ? `: ${what}` : ''}`);
  },
});
const toolbarStore = useToolbarStore();
const clusterStore = useClusterStore();
const communityStore = useCommunityStore();
const similarityStore = useSimilarityStore();
const queryConsoleStore = useQueryConsoleStore();
// A file context (investigations F2.5) has no query language: no console.
const supportsQuery = computed(
  () => capabilitiesFor(resolveDatasourceType(graphStore.currentContext)).supportsQuery,
);
const queryTemplatesStore = useQueryTemplatesStore();
const { executeTemplateAsGraph } = useTemplateExecution();

const showFilters = ref(false);
const showLayoutPanel = ref(false);
const showQueryPanel = ref(false);
const showContextInfo = ref(false);
const showMetricsPanel = ref(false);
const showResourceMonitor = ref(false);
// Style, labels, behaviors and presets: one panel, four tabs.
const showLookPanel = ref(false);

// The context's default look (`default_behaviors.look`): the look on screen, saved on the context.
const { setDefaultLook } = useContextDefaultLook();
const savingDefaultLook = ref(false);
const hasContextDefaultLook = computed(() => !!storedDefaultLook(graphStore.currentContext));
async function saveContextDefaultLook(look: DefaultLook | null, done: string) {
  const id = graphStore.currentContext?.id;
  if (!id) return;
  savingDefaultLook.value = true;
  try {
    await setDefaultLook(id, look);
    toast.success(done);
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to save the default look'));
  } finally {
    savingDefaultLook.value = false;
  }
}
const makeContextDefaultLook = () =>
  saveContextDefaultLook(toDefaultLook(graphStore.buildStylePreset(), 'current'), 'This look is now the context default');
const clearContextDefaultLook = () => saveContextDefaultLook(null, 'The context opens with the stock look again');
const lookTab = ref<LookTab>('style');
const showClusterPrograms = ref(false);
const showTemplatesPanel = ref(false);
const showMenuActionsModal = ref(false);
const showPrecomputedPanel = ref(false);
const selectedClusterId = ref<string | null>(null);
const communityTable = useCommunityMenuActions();
const clusterProgramActions = useClusterProgramMenuActions();
const configurableMenuActions = useConfigurableMenuActions();
// Ref driving the pre-filled TemplateExecuteModal opened by run-query-template
// actions whose required parameters could not all be bound from the click.
const { pendingTemplateExecution } = configurableMenuActions;
const showDetailModal = ref(false);
const showDataTable = ref(false);

// The Data Table and Query Console are both bottom drawers — only one at a time.
// Query Console open-state lives in its store so other components (e.g. running
// a table-mode template) can open it.
function toggleDataTable() {
  showDataTable.value = !showDataTable.value;
  if (showDataTable.value) queryConsoleStore.close();
}

function toggleQueryConsole() {
  queryConsoleStore.toggle();
}

// Keep the two bottom drawers mutually exclusive even when the console is opened
// programmatically (e.g. running a table-mode template from the templates panel).
watch(
  () => queryConsoleStore.isOpen,
  (open) => { if (open) showDataTable.value = false; },
);

const detailModalItem = computed(() => {
  if (!showDetailModal.value) return null;
  if (graphStore.selectedNode) {
    return { type: 'node' as const, data: graphStore.selectedNode };
  }
  if (graphStore.selectedEdge) {
    return { type: 'edge' as const, data: graphStore.selectedEdge };
  }
  return null;
});

const graphCanvas3DRef = ref<InstanceType<typeof GraphCanvas3D> | null>(null);
const graphContainerRef = ref<HTMLDivElement | null>(null);
const { isFullscreen, toggle: toggleFullscreen } = useCanvasFullscreen(graphContainerRef);

function setViewMode(mode: '3d' | '2d-proj') {
  graphStore.updateBehaviors({ viewMode: mode });
}

/** The shared canvas toolbar's toggles that are this page's own panels. */
function onCanvasToolbarToggle(id: CanvasToolbarButton) {
  // Info and Layout float in the same corner: one at a time, or Info covers Layout's close button.
  if (id === 'info') {
    showContextInfo.value = !showContextInfo.value;
    if (showContextInfo.value) showLayoutPanel.value = false;
  } else if (id === 'layout') {
    showLayoutPanel.value = !showLayoutPanel.value;
    if (showLayoutPanel.value) showContextInfo.value = false;
  }
  else if (id === 'table') toggleDataTable();
}

/**
 * The seven top-bar panels share ONE dock on the left of the canvas: opening
 * a panel closes whichever was open. They used to be independent booleans,
 * so Filters + Style + Labels could stack to ~780px and squeeze the canvas
 * into a strip; nobody edits three panels at once, and the floating panels
 * (Info, Layout, cluster list) and the bottom drawers are unaffected.
 */
const dockedPanels: Record<PanelId, Ref<boolean>> = {
  filters: showFilters,
  look: showLookPanel,
  query: showQueryPanel,
  metrics: showMetricsPanel,
  clusters: showClusterPrograms,
  templates: showTemplatesPanel,
  precomputed: showPrecomputedPanel,
};

function setDocked(id: PanelId, open: boolean) {
  for (const [key, r] of Object.entries(dockedPanels) as [PanelId, Ref<boolean>][]) {
    const next = key === id ? open : false;
    if (r.value !== next) {
      r.value = next;
      toolbarStore.setPanelActive(key, next);
    }
  }
}

/** Escape inside a docked panel closes it (on the canvas it keeps clearing the selection). */
function onDockEscape(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (!target || target.closest('[data-testid="graph-container"]')) return;
  const open = (Object.keys(dockedPanels) as PanelId[]).find((k) => dockedPanels[k].value);
  if (!open) return;
  setDocked(open, false);
  event.stopPropagation();
}

function toggleDocked(id: PanelId) {
  setDocked(id, !dockedPanels[id].value);
}

/**
 * Open (never toggle) a panel from somewhere else on the page — the
 * status-bar chips use it so a "not applied" notice leads straight to the
 * panel that can fix it.
 */
function openPanel(id: PanelId) {
  setDocked(id, true);
}

/** Open the Look panel on a tab (the status chips and the toolbar use it). */
function openLook(tab: LookTab) {
  lookTab.value = tab;
  setDocked('look', true);
}

function toggleLook(tab?: LookTab) {
  if (tab) openLook(tab);
  else toggleDocked('look');
}

/**
 * Which tab the Clusters panel shows. The clusters a program produced used to
 * live in a second floating panel with its own toolbar button, so "Clusters"
 * named two different surfaces; they are now the panel's Results tab, reached
 * from the status bar's cluster count.
 */
const clustersTab = ref<ClustersTab>('groups');

function showClusterResults() {
  clustersTab.value = 'results';
  openPanel('clusters');
}

function handleFocusNode(nodeId: string) {
  graphCanvas3DRef.value?.focusOnNode(nodeId);
}

function handleExportPNG(options: { scale: number; background: 'white' | 'transparent' }) {
  const filename = `${graphStore.currentContext?.title || 'graph'}.png`;
  graphCanvas3DRef.value?.exportPNG(filename, options.scale, options.background);
}

// Track canvas dimensions for the export modal
let canvasResizeObserver: ResizeObserver | null = null;

function updateCanvasDimensions() {
  if (graphContainerRef.value) {
    const rect = graphContainerRef.value.querySelector('.graph-container');
    if (rect) {
      toolbarStore.updateCanvasDimensions(rect.clientWidth, rect.clientHeight);
    }
  }
}

function formatPayloadDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'at an unknown time' : date.toLocaleString();
}

/**
 * What the status chip explains on hover.
 *
 * Names the provider and, when the graph was computed from URL arguments, the
 * arguments themselves — otherwise two links differing only by `?seed=` would
 * produce two identical-looking chips.
 */
const precomputedChipTitle = computed(() => {
  const payload = graphStore.currentPrecomputedGraph;
  if (!payload) return '';

  const origin = payload.provider ? ` by the “${payload.provider}” provider` : '';
  const when = `${formatPayloadDate(payload.created_at)}`;
  const who = payload.created_by ? ` by ${payload.created_by}` : '';

  const args = Object.entries(payload.params ?? {})
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  const withArgs = args.length ? ` Arguments: ${args.join(', ')}.` : '';

  return (
    `Precomputed graph “${payload.name}”, resolved${origin} ${when}${who}. ` +
    `It does not reflect changes made since.${withArgs}`
  );
});

/**
 * Open whatever the URL asks for: a precomputed graph, an exploration, a
 * query template, or none of them.
 *
 * A precomputed graph or template failing here deliberately does NOT fall
 * through to the default load — a mistyped or deleted link must surface as an
 * error, not silently launch an expensive warehouse query the user never
 * asked for.
 */
async function loadFromRoute(contextId: string) {
  const query = route.query as QueryLike;
  const name = precomputedName(query);
  const params = precomputedParams(query);
  const explorationId = route.query.exploration as string | undefined;
  const templateParsed = parseTemplateUrl(query);

  await loadGraphFromRoute(contextId, name, params, explorationId, templateParsed);
  await applyStyleFromRoute(contextId);
  applyLayoutOverridesFromRoute();
  validateLayoutOverridesAgainstGraph();
}

/**
 * Apply `?style=<name>` on top of whatever graph just loaded.
 *
 * Runs last, so it wins over the look an exploration restored — the URL is the
 * more specific instruction. A preset that does not exist changes nothing and
 * leaves the graph fully usable; the store records why and the status bar says
 * so, because a silent no-op would make a broken link look like a working one.
 */
async function applyStyleFromRoute(contextId: string) {
  const styleName = route.query.style as string | undefined;
  if (!styleName) return;
  await graphStore.loadStylePreset(contextId, styleName);
}

/**
 * Apply `?layout=` / `?layout.<mode>.<field>=` on top of whatever the preset
 * restored.
 *
 * Runs after applyStyleFromRoute, and that order is load-bearing rather than
 * cosmetic: applyStylePreset replaces the whole layoutModeConfig ref, so
 * overrides applied first would be silently erased. A preset is the saved
 * default; the URL is the specific instruction in the link someone was sent.
 */
function applyLayoutOverridesFromRoute() {
  const parsed = parseLayoutOverrides(route.query as QueryLike);
  layoutOverrideIssues.value = parsed.issues;
  if (!parsed.present) return;

  // Only when the URL actually named an algorithm. `?layout.ego.focusNodeId=`
  // on its own configures ego for whenever it is switched on — it must not
  // switch to it, or `?layout.hive.scale=log` would yank someone out of the
  // force layout they were using.
  //
  // Via setLayoutAlgorithm, not the ref, so its invariant holds: a non-force
  // algorithm disables community radial, and two global positional constraints
  // must not stack.
  if (parsed.algorithm) graphStore.setLayoutAlgorithm(parsed.algorithm);

  // Keep this synchronous and adjacent to the call above. GraphCanvas3D's
  // layoutAlgorithm watcher toasts "Pick a focus node" when ego turns on
  // without one; being a Vue watcher it runs after both calls and so never
  // sees the intermediate state. An await slipped in between would resurrect
  // that spurious toast.
  if (Object.keys(parsed.modeConfig).length > 0) {
    graphStore.updateLayoutModeConfig(parsed.modeConfig);
  }
}

/**
 * Confirm a focus node named in the URL is actually in the graph.
 *
 * The canvas already renders the ego layout inert when the focus is unknown, so
 * nothing here is load-bearing for safety — what is missing without it is the
 * explanation, and an inert layout with no explanation is exactly the broken
 * link that looks like a working one.
 *
 * An empty graph is not an answer. A context that does not auto-load, or a REST
 * connection with no subgraph support, opens with nothing on screen; calling the
 * focus node missing there would blame the link for the user not having run a
 * query yet.
 */
function validateLayoutOverridesAgainstGraph() {
  const focusParam = 'layout.ego.focusNodeId';
  const wasMissing = layoutOverrideIssues.value.some(
    (issue) => issue.code === 'focus-node-not-found',
  );
  layoutOverrideIssues.value = layoutOverrideIssues.value.filter(
    (issue) => issue.code !== 'focus-node-not-found',
  );

  // Only a focus the URL asked for. One inherited from a preset is the Layout
  // panel's story to tell, not this link's.
  if (!(focusParam in route.query)) return;
  const focusId = graphStore.layoutModeConfig.ego.focusNodeId;
  if (!focusId) return;
  if (graphStore.nodes.length === 0) return;
  if (graphStore.nodes.some((node) => node.node_id === focusId)) return;

  const message =
    `The ego focus node “${focusId}” is not in this graph, so the ego layout has ` +
    `nothing to centre on. Run a query that includes it, or pick a focus node in ` +
    `the Layout panel.`;
  layoutOverrideIssues.value = [
    ...layoutOverrideIssues.value,
    { code: 'focus-node-not-found', param: focusParam, value: focusId, message },
  ];
  // Longer than the default: this lands while the graph is still appearing and
  // the user is not yet looking for a message. Not sticky — the chip is the
  // surface that persists.
  if (!wasMissing) toast.warning(message, 6000);
}

async function loadGraphFromRoute(
  contextId: string,
  name: string | undefined,
  params: Record<string, string>,
  explorationId: string | undefined,
  templateParsed: ParsedTemplateUrl,
) {
  // A graph opened without an exploration wears the context's default look
  // (`default_behaviors.look`). An exploration brings its own; `?style=` runs
  // after this and wins over both.
  if (!explorationId) {
    const look = contextDefaultLook(graphStore.currentContext);
    if (look) graphStore.applyStylePreset(look);
  }

  // Precedence: exploration > precomputed > template > default auto-load.
  // A template shadowed by either of the first two is ignored ENTIRELY —
  // running it as well would race two loads for one canvas.
  if (templateParsed.present && (name || explorationId)) {
    console.warn(
      `[graph] URL carries ?template together with ?${
        explorationId ? 'exploration' : 'precomputed'
      }; the template is ignored.`,
    );
    templateIssues.value = [];
    activeUrlTemplate.value = null;
  }

  if (name) {
    if (explorationId) {
      console.warn(
        '[graph] URL carries both ?precomputed and ?exploration; loading the exploration.',
      );
    } else {
      try {
        await graphStore.loadPrecomputedGraph(contextId, name, params);
      } catch {
        // graphStore.queryError already carries the message for the UI.
      }
      clusterStore.clearAll();
      communityStore.clearCommunities();
      return;
    }
  }

  if (explorationId) {
    // Loads the exploration with its saved clusters and programs. This
    // re-executes the saved graph_query, so we DON'T call loadSubgraph first
    // (otherwise we'd load all nodes, but clusters were created for the query
    // result only).
    await graphStore.loadExploration(explorationId);
    return;
  }

  if (templateParsed.present) {
    // The template replaces the default auto-load, and deliberately does NOT
    // fall through to it on failure — same doctrine as a precomputed graph.
    // No `graphQuery = ''` either: a successful run sets it via setGraphQuery,
    // which is what keeps "save exploration" working afterwards.
    await runTemplateFromRoute(contextId, templateParsed);
    clusterStore.clearAll();
    communityStore.clearCommunities();
    return;
  }

  // Starting a new context. By default we fetch nothing — the implicit "all
  // nodes" subgraph is expensive on large graphs, so the user runs the query
  // they actually want. A context opts in via default_behaviors:
  // { autoLoadOnOpen: true }.
  // supportsSubgraph: a REST connection without a subgraph handler cannot serve
  // the implicit load — open empty and let the user run a query.
  if (graphStore.behaviors.autoLoadOnOpen && graphStore.supportsSubgraph) {
    await graphStore.loadSubgraph({});
  }
  clusterStore.clearAll();
  communityStore.clearCommunities();
  // Clear graph query - user must execute a query to save exploration
  graphStore.graphQuery = '';
}

/**
 * Resolve and run the template a `?template=` link asked for.
 *
 * Fail-closed at every stage: a grammar issue, an unfetchable template list, a
 * name that resolves to nothing (or to two things), a value that breaks a
 * declared rule — each stops here with an explaining chip and NOTHING
 * executes. These values are spliced into a query a warehouse will run;
 * a link that is only mostly right must not run a query that is only mostly
 * the one its author meant.
 */
async function runTemplateFromRoute(contextId: string, parsed: ParsedTemplateUrl) {
  const token = ++templateRunToken;
  activeUrlTemplate.value = null;

  if (parsed.issues.length > 0) {
    templateIssues.value = parsed.issues;
    return;
  }

  // Always refetch: the store is a lazily-filled cache with no context tag, so
  // whatever the templates panel loaded last may belong to another context —
  // and a link must see templates created since the panel was last opened.
  await queryTemplatesStore.loadTemplates(contextId);
  if (token !== templateRunToken) return;
  if (queryTemplatesStore.error) {
    // loadTemplates swallows its error into store state and leaves stale
    // templates in place — resolving against those would be guessing.
    templateIssues.value = [
      {
        code: 'templates-load-failed',
        param: 'template',
        message: `The template list could not be loaded: ${queryTemplatesStore.error}`,
      },
    ];
    return;
  }

  const capabilities = capabilitiesFor(
    resolveDatasourceType(graphStore.currentContext),
  );
  const resolution = resolveTemplateExecution(parsed, queryTemplatesStore.templates, {
    supportsSql: capabilities.supportsSql,
  });
  if (!resolution.ok) {
    templateIssues.value = resolution.issues;
    return;
  }

  try {
    await executeTemplateAsGraph(resolution.template, resolution.values);
    if (token === templateRunToken) {
      templateIssues.value = [];
      activeUrlTemplate.value = {
        name: resolution.template.name,
        values: resolution.values,
      };
    }
  } catch {
    // graphStore.queryError already carries the message for the UI — the same
    // QueryErrorModal surface every other execution path reports through.
  }
}

onMounted(async () => {
  // Register toolbar handlers for the global Toolbar component
  toolbarStore.registerHandlers({
    onToggleFilters: () => toggleDocked('filters'),
    onToggleQuery: () => toggleDocked('query'),
    onToggleMetrics: () => toggleDocked('metrics'),
    onToggleLook: toggleLook,
    onToggleClusterPrograms: () => toggleDocked('clusters'),
    onToggleTemplates: () => toggleDocked('templates'),
    onTogglePrecomputed: () => toggleDocked('precomputed'),
    onExportPNG: handleExportPNG,
    getViewport: () => graphCanvas3DRef.value?.getViewport() ?? null,
  });

  // Right-click a node → "View community members" (when communities are detected)
  communityTable.register();

  // Right-click a node → run flagged cluster programs as community algorithms
  clusterProgramActions.register();

  // Right-click a node/edge → user-configured actions (open URL, copy, run template)
  configurableMenuActions.register();

  // Track canvas dimensions for the export modal
  const graphContainer = graphContainerRef.value?.querySelector('.graph-container');
  if (graphContainer) {
    canvasResizeObserver = new ResizeObserver(updateCanvasDimensions);
    canvasResizeObserver.observe(graphContainer);
    updateCanvasDimensions();
  }

  await graphStore.loadContext(props.contextId);
  await loadFromRoute(props.contextId);
});

onUnmounted(() => {
  // Push any pending debounced cluster-program save before leaving the context
  void clusterStore.flushPersist();
  void useContextMenuActionsStore().flushPersist();
  communityTable.unregister();
  clusterProgramActions.unregister();
  configurableMenuActions.unregister();
  toolbarStore.unregisterHandlers();
  canvasResizeObserver?.disconnect();
  canvasResizeObserver = null;
  // Terminate background workers: the metrics pool outlives the view as a
  // module singleton, and the community worker keeps running when it has no
  // results yet (the nodes-watcher only clears when hasResults is true).
  resetMetricsCalculator();
  communityStore.clearCommunities();
  graphStore.clear();
});

watch(
  () => props.contextId,
  async (newId) => {
    graphStore.clear();
    // Clear clusters; graphStore.clear() nulled currentContext, so this resets
    // programs to the built-in defaults. loadContext() below hydrates the new
    // context's programs on top.
    clusterStore.clearAll();
    communityStore.clearCommunities();
    // In-flight metric computations belong to the graph being left — terminate
    // their workers; the pool re-initializes lazily on the next computation.
    resetMetricsCalculator();
    // Template chips describe the context being left; loadFromRoute below
    // rebuilds them for the new one if its URL still asks for a template.
    templateIssues.value = [];
    activeUrlTemplate.value = null;
    await graphStore.loadContext(newId);
    // loadContext re-resolves behaviors from the new context, so this honours the context
    // being switched TO, not the one being left.
    await loadFromRoute(newId);
  }
);

// The name AND its provider arguments live in the query string, which
// `props: true` does not track. The argument keys are open-ended, so — as with
// layout.* below — there is no single property to watch and the signature
// stands in for the whole set. This is what makes editing `?seed=` in the
// address bar re-resolve the graph.
//
// The signature deliberately excludes `style` and `layout*`: those have their
// own, cheaper watchers, and folding them in here would turn a style change
// into a full graph refetch.
watch(
  () => precomputedQuerySignature(route.query as QueryLike),
  async (next, previous) => {
    if (next === previous) return;
    // Empty means the URL names no precomputed graph. Leaving it alone rather
    // than reloading: dropping `?precomputed=` should not re-run the default
    // auto-load over whatever the user is currently looking at.
    if (next === '') return;
    if (!graphStore.currentContext) return;
    await loadFromRoute(props.contextId);
  }
);

// The template name AND its parameter values live in the query string, and the
// parameter keys are open-ended (`template.<paramId>`) — the signature stands
// in for the whole set, exactly as it does for `?precomputed=`. Editing
// `?template.depth=` in the address bar re-resolves and re-executes, the same
// contract as editing `?seed=` on a precomputed link.
watch(
  () => templateQuerySignature(route.query as QueryLike),
  async (next, previous) => {
    if (next === previous) return;
    if (next === '') {
      // Every template param dropped. That clears the chips but deliberately
      // does NOT reload anything: dropping `?template=` should not re-run the
      // default auto-load over whatever the user is currently looking at —
      // same doctrine as dropping `?precomputed=`.
      templateIssues.value = [];
      activeUrlTemplate.value = null;
      return;
    }
    if (!graphStore.currentContext) return;
    // The full orchestrator, not just the template branch, so `?style=` and
    // `?layout.*` keep their load-bearing apply-after ordering.
    await loadFromRoute(props.contextId);
  }
);

// A style change is cheaper than a graph change: re-applying the preset is
// enough, and re-running loadFromRoute would needlessly reload the graph too.
watch(
  () => route.query.style,
  async (name, previous) => {
    if (name === previous) return;
    if (!graphStore.currentContext) return;
    if (!name) {
      graphStore.currentStylePreset = null;
      graphStore.stylePresetError = null;
      return;
    }
    await applyStyleFromRoute(props.contextId);
  }
);

// The override keys are open-ended (layout.<mode>.<field>), so unlike ?style=
// there is no single key to watch — the signature stands in for the whole set.
watch(
  () => layoutQuerySignature(route.query as QueryLike),
  (next, previous) => {
    if (next === previous) return;
    if (!graphStore.currentContext) return;
    if (next === '') {
      // Every layout param dropped. That clears the notice but deliberately
      // does NOT undo the layout: unlike a preset, an override is a field edit
      // with no snapshot to restore, and the user may have adjusted the Layout
      // panel since — editing the URL must not throw that away.
      layoutOverrideIssues.value = [];
      return;
    }
    applyLayoutOverridesFromRoute();
    validateLayoutOverridesAgainstGraph();
  }
);

// The focus node can stop existing without the URL changing — a new query, a
// different cache. Watching length rather than the array itself: a deep watcher
// over tens of thousands of nodes is a performance disaster, and the progressive
// path patches properties while keeping the same ids, so a partial-to-final swap
// of equal length cannot change the answer.
watch(
  () => graphStore.nodes.length,
  () => validateLayoutOverridesAgainstGraph()
);
</script>

<template>
  <div ref="graphContainerRef" class="graph-visualization" :class="{ fullscreen: isFullscreen }">
    <!-- Started from a case (?case=): the way back; saving attaches the exploration (05 §4). -->
    <div v-if="caseReturnId" class="case-breadcrumb" data-testid="case-breadcrumb">
      <RouterLink :to="`/investigations/${caseReturnId}`" class="case-breadcrumb-link">← Case {{ currentCaseStore.title || currentCaseStore.shortId }}</RouterLink>
      <span class="case-breadcrumb-hint">Saving the exploration attaches it to the case and goes back.</span>
    </div>
    <div class="main-content" @keydown.esc="onDockEscape">
      <FilterPanel v-if="showFilters" @close="showFilters = false; toolbarStore.setPanelActive('filters', false)" />
      <LookPanel
        v-if="showLookPanel"
        v-model:tab="lookTab"
        presets-apply="url"
        :presets-context-id="graphStore.currentContext?.id ?? null"
        :can-write-presets="graphStore.currentContext?.has_write_access === true"
        @close="setDocked('look', false)"
        @open-menu-actions="showMenuActionsModal = true"
      >
        <template v-if="graphStore.currentContext?.has_write_access" #footer>
          <button
            class="btn btn-outline btn-sm"
            data-testid="look-make-context-default"
            title="Open this context with the look on screen when no exploration says otherwise"
            :disabled="savingDefaultLook"
            @click="makeContextDefaultLook"
          >
            Make context default
          </button>
          <button
            v-if="hasContextDefaultLook"
            class="btn btn-outline btn-sm"
            data-testid="look-clear-context-default"
            :disabled="savingDefaultLook"
            @click="clearContextDefaultLook"
          >
            Clear default
          </button>
        </template>
      </LookPanel>
      <GraphQueryPanel v-if="showQueryPanel" @close="showQueryPanel = false; toolbarStore.setPanelActive('query', false)" />
      <MetricsPanel
        v-if="showMetricsPanel"
        @close="showMetricsPanel = false; toolbarStore.setPanelActive('metrics', false)"
        @show-resource-monitor="showResourceMonitor = true"
      />
      <ClusterProgramPanel
        v-if="showClusterPrograms"
        v-model:tab="clustersTab"
        @close="showClusterPrograms = false; toolbarStore.setPanelActive('clusters', false)"
      />
      <QueryTemplatesPanel v-if="showTemplatesPanel" @close="showTemplatesPanel = false; toolbarStore.setPanelActive('templates', false)" />
      <PrecomputedGraphPanel v-if="showPrecomputedPanel" @close="showPrecomputedPanel = false; toolbarStore.setPanelActive('precomputed', false)" />
      <ContextMenuActionsModal v-model="showMenuActionsModal" />
      <TemplateExecuteModal
        v-if="pendingTemplateExecution"
        :template="pendingTemplateExecution.template"
        :initial-values="pendingTemplateExecution.initialValues"
        @close="pendingTemplateExecution = null"
      />

      <div class="graph-container" data-testid="graph-container">
        <div v-if="graphStore.loading" class="loading-overlay" data-testid="graph-loading">
          <QueryRunningState
            :label="graphStore.loadingMessage || 'Loading…'"
            :can-cancel="graphStore.queryCanCancel"
            :chunk-progress="graphStore.queryChunkProgress"
            @cancel="graphStore.cancelGraphQuery()"
          />
        </div>

        <div v-if="graphStore.error" class="error-overlay">
          <div class="error-state">
            <AlertCircle :size="32" class="error-state-icon" />
            <p class="error-state-title">Failed to load graph</p>
            <p class="error-state-message">{{ graphStore.error }}</p>
            <RouterLink to="/contexts" class="btn btn-outline btn-sm" data-testid="graph-error-back">← Back to contexts</RouterLink>
          </div>
        </div>

        <div v-else-if="!graphStore.loading && graphStore.nodes.length > 0 && graphStore.filteredNodes.length === 0" class="empty-overlay" data-testid="graph-no-match">
          <div class="empty-state">
            <p class="empty-state-title">No node matches the filters</p>
            <button class="btn btn-outline btn-sm" data-testid="graph-no-match-clear" @click="graphStore.resetFilters(); graphStore.clearIsolation()">Clear filters</button>
          </div>
        </div>

        <div v-else-if="!graphStore.loading && graphStore.filteredNodes.length === 0" class="empty-overlay">
          <div class="empty-state">
            <Network :size="48" class="empty-state-icon" />
            <p class="empty-state-title">No nodes to display</p>
            <p class="empty-state-message">
              Open <strong>Query</strong> in the top bar (Cypher or SQL) or pick a
              <strong>Template</strong> to load nodes. Right-click a node for actions.
            </p>
          </div>
        </div>

        <GraphCanvas3D
          ref="graphCanvas3DRef"
          @cluster-node-click="selectedClusterId = $event"
        />

        <!-- Layout Panel -->
        <div v-if="showLayoutPanel" class="panel-wrapper panel-left">
          <LayoutPanel
            :is-layout-running="graphCanvas3DRef?.isLayoutRunning ?? false"
            @start-layout="graphCanvas3DRef?.startLayout()"
            @stop-layout="graphCanvas3DRef?.stopLayout()"
            @reheat-layout="graphCanvas3DRef?.reheatLayout()"
            @scramble-layout="graphCanvas3DRef?.scrambleLayout()"
            @start-edge-type-layout="(et: string | null, s: string) => graphCanvas3DRef?.startEdgeTypeLayout(et, s as any, similarityStore.useScoreAsWeight)"
            @close="showLayoutPanel = false"
          />
        </div>

        <!-- The groups as a clickable legend while the Clusters panel is closed -->
        <GroupLegend v-if="!showClusterPrograms" @open-panel="openPanel('clusters')" />

        <!-- Floating Details Panel (shown in fullscreen mode) -->
        <SidePanel v-if="isFullscreen" variant="floating" @show-details="showDetailModal = true" />

        <!-- Context Info Panel -->
        <ContextInfoPanel
          v-if="showContextInfo"
          @close="showContextInfo = false"
          @review-schema="reviewContextSchema"
        />

        <!-- Bottom toolbar: the chrome shared with the case, plus this page's drawers -->
        <div class="graph-toolbar-host">
          <GraphCanvasToolbar
            :buttons="['info', 'layout', 'table', 'fit']"
            :active="{ info: showContextInfo, layout: showLayoutPanel, table: showDataTable }"
            :view-mode="graphStore.behaviors.viewMode"
            :is-fullscreen="isFullscreen"
            :test-ids="{ layout: 'graph-toolbar-layout' }"
            @toggle="onCanvasToolbarToggle"
            @fit="graphCanvas3DRef?.zoomToFit()"
            @fullscreen="toggleFullscreen"
            @view-mode="setViewMode"
          >
            <button
              v-if="supportsQuery"
              class="toolbar-btn"
              :class="{ active: queryConsoleStore.isOpen }"
              :aria-pressed="queryConsoleStore.isOpen"
              @click="toggleQueryConsole"
              title="Query Console"
              data-testid="query-console-toggle"
            >
              <TerminalSquare :size="14" />
              <!-- "Console", not "Query": the top bar already has a Query button
                   (graph query) and two identical labels on screen was the most
                   common point of confusion. -->
              <span class="btn-label">Console</span>
            </button>

            <!-- The user's layer (BYOD-2): enrich, add nodes and edges, draw. -->
            <YourDataButton />
          </GraphCanvasToolbar>
        </div>

        <GraphStatusBar
          :nodes="graphStore.filteredNodes.length"
          :edges="graphStore.filteredEdges.length"
          @open-behaviors="openLook('behaviors')"
          @show-clusters="showClusterResults"
        >
          <!-- Resolved from a name rather than queried just now. It may not
               reflect the current state of the source, so say so where the
               other qualifiers about this graph already live. -->
          <span
            v-if="graphStore.currentPrecomputedGraph"
            class="status-item status-precomputed"
            data-testid="graph-status-precomputed"
            :title="precomputedChipTitle"
          >
            precomputed: {{ graphStore.currentPrecomputedGraph.name }}
          </span>
          <!-- The query on screen came from a template the URL named. -->
          <span
            v-if="activeUrlTemplate"
            class="status-item status-template"
            data-testid="graph-status-template"
            :title="activeUrlTemplateTitle"
          >
            template: {{ activeUrlTemplate.name }}
          </span>
          <!-- A template the URL named but that could not be run. One chip for
               all issues, full list in the tooltip — same shape as the layout
               chip below. Nothing was executed: a link that is only mostly
               right must not run a query that is only mostly right. -->
          <button
            v-else-if="templateIssues.length"
            type="button"
            class="status-chip status-template-error"
            data-testid="graph-status-template-error"
            :title="templateIssuesTitle + '\nClick to open Templates.'"
            @click="openPanel('templates')"
          >
            template not run
          </button>
          <!-- Which named look is on, when the URL asked for one. -->
          <span
            v-if="graphStore.currentStylePreset"
            class="status-styled"
            data-testid="graph-status-style"
            :title="`Style preset “${graphStore.currentStylePreset.name}”, saved by ${graphStore.currentStylePreset.created_by}`"
          >
            style: {{ graphStore.currentStylePreset.name }}
          </span>
          <!-- A preset the URL named but could not be applied. The graph is
               unaffected, so this is a notice rather than an error state. -->
          <button
            v-else-if="graphStore.stylePresetError"
            type="button"
            class="status-chip status-style-error"
            data-testid="graph-status-style-error"
            :title="graphStore.stylePresetError + '\nClick to open Style.'"
            @click="openLook('style')"
          >
            style not applied
          </button>
          <!-- Layout parameters the URL named but could not be applied. One chip
               for all of them: the status bar is a row of terse qualifiers, and
               N chips for N typos would push the node count off the row and
               imply N different kinds of problem. Full list in the tooltip. -->
          <button
            v-if="layoutOverrideIssues.length"
            type="button"
            class="status-chip status-layout-error"
            data-testid="graph-status-layout-error"
            :title="layoutOverrideIssuesTitle + '\nClick to open Layout.'"
            @click="showLayoutPanel = true; showContextInfo = false"
          >
            {{ layoutOverrideIssues.length === 1
              ? 'layout setting not applied'
              : `${layoutOverrideIssues.length} layout settings not applied` }}
          </button>
        </GraphStatusBar>
      </div>

      <SidePanel v-if="!isFullscreen" @show-details="showDetailModal = true" />
    </div>

    <!-- Data Table (bottom drawer) -->
    <DataTablePanel
      v-if="showDataTable"
      @close="showDataTable = false"
      @focus-node="handleFocusNode"
      @focus-edge="handleFocusNode"
    />

    <!-- Query Console (bottom drawer) -->
    <QueryConsolePanel
      v-if="queryConsoleStore.isOpen && supportsQuery"
      @close="queryConsoleStore.close()"
      @focus-node="handleFocusNode"
    />

    <!-- Resource Monitor Modal -->
    <ResourceMonitorModal
      v-if="showResourceMonitor"
      @close="showResourceMonitor = false"
    />

    <!-- Query Error Modal -->
    <QueryErrorModal
      :error="graphStore.queryError"
      @close="graphStore.clearQueryError()"
      @review-schema="reviewContextSchema"
    />

    <SchemaDriftModal
      v-if="graphStore.currentContext"
      :open="schemaDriftModalOpen"
      :context-id="graphStore.currentContext.id"
      :has-write-access="graphStore.currentContext.has_write_access"
      @close="schemaDriftModalOpen = false"
      @applied="schemaDriftModalOpen = false"
    />

    <!-- Cluster Node Modal -->
    <ClusterNodeModal
      :cluster-id="selectedClusterId"
      @close="selectedClusterId = null"
    />

    <!-- Community Node Modal (opened via node context menu) -->
    <ClusterProgramRunHost />
    <CommunityNodeModal
      :community-id="communityTable.selectedCommunityId.value"
      @close="communityTable.close()"
    />

    <!-- Detail Modal (full properties view) -->
    <DetailModal
      :item="detailModalItem"
      @close="showDetailModal = false"
    />
  </div>
</template>

<style scoped>
.case-breadcrumb {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--border-color, #ddd);
  background: color-mix(in srgb, var(--color-primary, #0f766e) 8%, var(--card-background, #fff));
  font-size: 12px;
}

.case-breadcrumb-link {
  font-weight: 600;
  color: var(--color-primary, #0f766e);
  text-decoration: none;
}

.case-breadcrumb-hint {
  color: var(--text-muted, #666);
}

.graph-visualization {
  display: flex;
  flex-direction: column;
  /* Fills whatever App.vue's <main> leaves under the toolbar (see App.vue). */
  height: 100%;
  min-height: 0;
  min-width: 0;
}

.main-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.graph-container {
  flex: 1;
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--bg-color, #fafafa);
}

.graph-visualization.fullscreen {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
  height: 100vh;
  background: var(--bg-color, #fafafa);
}

.loading-overlay,
.error-overlay,
.empty-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.85);
  z-index: 10;
  pointer-events: none;
}

.loading-overlay {
  flex-direction: column;
  gap: var(--space-3, 12px);
}

/*
 * The overlays share `pointer-events: none` above so the translucent backdrop
 * doesn't swallow graph interaction while loading. The loading overlay, unlike
 * the error/empty ones, hosts an interactive Cancel button (in QueryRunningState)
 * that MUST receive clicks — re-enable pointer events on it, or the click falls
 * through to the 3D canvas and cancellation silently no-ops.
 */
.loading-overlay :deep(.cancel-btn),
.error-overlay .btn,
.empty-overlay .btn {
  pointer-events: auto;
}

.loading-message {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--color-text-secondary, #555);
}

.error-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  text-align: center;
  padding: var(--space-6);
}

.error-state-icon {
  color: var(--color-error, #e53e3e);
  opacity: 0.8;
}

.error-state-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text-color);
  margin: 0;
}

.error-state-message {
  font-size: var(--text-sm);
  color: var(--text-muted);
  margin: 0;
  max-width: 360px;
}

.empty-state-icon {
  color: var(--border-color);
  opacity: 0.6;
}

.empty-state-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text-muted);
  margin: 0;
}

.empty-state-message {
  font-size: var(--text-sm);
  color: var(--text-muted);
  opacity: 0.7;
  margin: 0;
}

/* Status chips that point at a fix are buttons; keep them looking like the
   inert chips next to them, with the cursor as the only extra tell. */
.status-chip {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  cursor: pointer;
}
.status-chip:hover { text-decoration: underline; }
.status-chip:focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: 2px; }

/* Truncation, unlike enrichment, changes what conclusions the graph supports —
   so it gets colour rather than fading into the status bar. */
.status-styled {
  color: var(--primary-color, #007bff);
  font-weight: 600;
}

.status-style-error {
  color: var(--warning-color, #b8860b);
  font-weight: 600;
}

/* Same register as an unapplied style preset: the link asked for something the
   graph could not honour, and nothing about the data itself is in doubt. */
.status-layout-error {
  color: var(--warning-color, #b8860b);
  font-weight: 600;
}

.status-precomputed {
  color: var(--primary-color, #007bff);
  font-weight: 600;
}

.status-template {
  color: var(--primary-color, #007bff);
  font-weight: 600;
}

/* Same register as the layout chip: the link asked for something that could
   not be honoured, and — because template runs are fail-closed — nothing ran. */
.status-template-error {
  color: var(--warning-color, #b8860b);
  font-weight: 600;
}

.status-truncated {
  color: var(--warning-color, #b45309);
  font-weight: 600;
}

.panel-wrapper {
  position: absolute;
  bottom: 80px;
  z-index: 20;
}

.panel-wrapper.panel-left {
  left: 16px;
}

.panel-wrapper.panel-right {
  right: 16px;
}

.graph-toolbar-host {
  position: absolute;
  bottom: 48px;
  left: 16px;
  /* Never wider than the canvas: on narrow viewports the buttons wrap
     instead of running off the right edge. */
  max-width: calc(100% - 32px);
  z-index: 20;
}

/* The page's own buttons inside the shared toolbar (slot content is styled here). */
.toolbar-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--card-background, white);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  color: inherit;
  transition: all 0.15s;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.toolbar-btn:hover {
  background: var(--bg-secondary, #f0f0f0);
}

.toolbar-btn.active {
  background: var(--primary-color, #42b883);
  color: white;
  border-color: var(--primary-color, #42b883);
}

.btn-label {
  font-size: 12px;
}
</style>
