<script setup lang="ts">
/**
 * Investigation workspace (T2): a tab per exploration plus the unified view, all
 * rendered by the regular graph store and canvas in investigation mode. Node ids
 * are unified ids in every tab, so the selection follows the entity across tabs.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { Banknote, Lock, Plus, Route } from 'lucide-vue-next';
import { useInvestigationStore } from '@/stores/investigation';
import { useGraphStore, type InvestigationGraphMode } from '@/stores/graph';
import { useCommunityStore } from '@/stores/community';
import { useSimilarityStore } from '@/stores/similarity';
import { useAuthStore } from '@/stores/auth';
import { useTraceStore, type TraceDirection } from '@/stores/trace';
import { useContextMenu, type ContextMenuTarget } from '@/composables/useContextMenu';
import { useToast } from '@/composables/useToast';
import { formatAmount } from '@/utils/edgeSemantics';
import { resetMetricsCalculator } from '@/services/metricsCalculator';
import { STATUS_LABELS, URGENT_DAYS, deadlineOf } from '@/utils/investigationStatus';
import { provenanceRingColors, roleColorMap, ROLE_COLORS, ROLE_LABELS } from '@/utils/graphAppearance';
import { describeEvent } from '@/utils/investigationEvents';
import { getErrorMessage } from '@/utils/errorMessage';
import {
  baseSourceId,
  mergedEntityCounts,
  nodeSourceIds,
  type NodeOrigin,
  type UnifiedNode,
} from '@/utils/unifyGraph';
import GraphCanvas3D from '@/components/GraphCanvas3D.vue';
import LayoutPanel from '@/components/LayoutPanel.vue';
import SourcesPanel from '@/components/investigation/SourcesPanel.vue';
import AddToInvestigationModal from '@/components/investigation/AddToInvestigationModal.vue';
import ArtifactsSpace from '@/components/investigation/ArtifactsSpace.vue';
import CaseFiles from '@/components/investigation/CaseFiles.vue';
import EnrichmentTab from '@/components/investigation/EnrichmentTab.vue';
import TracePanel from '@/components/investigation/TracePanel.vue';
import TypologyBadgesPanel from '@/components/investigation/TypologyBadgesPanel.vue';
import TraceExits from '@/components/investigation/TraceExits.vue';
import TraceSankey from '@/components/investigation/TraceSankey.vue';
import SwimlaneTimeline from '@/components/investigation/SwimlaneTimeline.vue';
import PathBar from '@/components/investigation/PathBar.vue';
import { api } from '@/services/api';
import type { GraphResponse } from '@/types/graph';
import type { InvestigationRole } from '@/types/investigation';

const props = defineProps<{ id: string }>();

const UNIFIED = 'unified';

const store = useInvestigationStore();
const graphStore = useGraphStore();
const communityStore = useCommunityStore();
const similarityStore = useSimilarityStore();
const auth = useAuthStore();
const trace = useTraceStore();
const contextMenu = useContextMenu();
const toast = useToast();

const showAdd = ref(false);
const showLayout = ref(false);
const activeTab = ref(UNIFIED);
/** The graph tabs, the case space (T10) or the money trace (T5). */
const view = ref<'graph' | 'space' | 'trace'>('graph');
const artifactCount = ref<number | null>(null);
const pendingProposals = ref(0);
const inspectorTab = ref<'data' | 'enrichment' | 'notes' | 'origin'>('data');
const showJournal = ref(false);
/** Left column: the sources or the typology badges (T9). */
const showTypologies = ref(false);
const noteDraft = ref('');
const actionError = ref<string | null>(null);
const canvasRef = ref<InstanceType<typeof GraphCanvas3D> | null>(null);
const pathBar = ref<InstanceType<typeof PathBar> | null>(null);

const readableSources = computed(() => store.sources.filter((s) => s.accessible));
const restrictedCount = computed(() => store.sources.length - readableSources.value.length);
const sourceTitle = (sourceId: string) =>
  store.sources.find((s) => s.id === baseSourceId(sourceId))?.title_snapshot ?? sourceId;
const contextTitle = (contextId: string) => store.contexts[contextId]?.title ?? contextId;
const mergedCounts = computed(() => mergedEntityCounts(store.unified.nodes));
const openMatches = computed(() => store.matches.filter((m) => m.status === 'sugerido' || m.status === 'adiado').length);

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

// --- loading a tab into the graph store ---
// The community store clears its results whenever `nodes` changes; keep each tab's
// communities and put them back after the swap (same timing as loadExploration).
const communityByTab = new Map<string, Record<string, unknown> | undefined>();
let renderedTab: string | null = null;

function graphMode(rings: Map<string, string[]>): InvestigationGraphMode {
  return {
    origins: new Map(store.unified.nodes.map((n) => [n.node_id, n.__sources])),
    rings,
    chooseOrigin,
    applyExpansion,
  };
}

async function render() {
  pathBar.value?.close();
  if (renderedTab !== null) communityByTab.set(renderedTab, communityStore.getState());
  if (view.value === 'trace') return renderTrace();
  if (graphStore.layoutAlgorithm === 'trace-layers') {
    graphStore.traceLayers = null;
    graphStore.setLayoutAlgorithm('force');
  }
  const tab = activeTab.value;

  const { nodes, edges } = store.unified;
  const tabNodes = tab === UNIFIED ? nodes : nodes.filter((n) => nodeSourceIds(n).includes(tab));
  const tabEdges = tab === UNIFIED ? edges : edges.filter((e) => baseSourceId(e.__source) === tab);

  // Rings tell sources apart, so only the unified view draws them.
  const rings = new Map(
    tab === UNIFIED ? nodes.map((n) => [n.node_id, provenanceRingColors(nodeSourceIds(n), store.sourceColors)]) : [],
  );
  graphStore.loadInvestigationGraph(graphMode(rings), tabNodes, tabEdges);
  renderedTab = tab;
  await nextTick();
  communityStore.loadState(communityByTab.get(tab));
}

// (Re)load the graphs once per case and source set (open, add).
let loadedKey: string | null = null;
async function loadWorkspace() {
  const key = `${store.current?.id}|${store.sources.map((s) => s.id).join(',')}`;
  if (!store.current || key === loadedKey) return;
  loadedKey = key;
  await store.loadWorkspace();
  // shortcut: the first readable source's style (colors, icons, labels) dresses every tab.
  const styled = store.sourceGraphs.find((g) => g.state);
  if (styled?.state) graphStore.applyStylePreset(styled.state);
}

watch(
  () => props.id,
  async (id) => {
    communityByTab.clear();
    renderedTab = null;
    activeTab.value = UNIFIED;
    view.value = 'graph';
    trace.reset();
    artifactCount.value = null;
    await store.openInvestigation(id);
    // The journal and notes are secondary: a failure here must not block the graph.
    store.fetchNotes().catch(() => {});
    store.fetchEvents().catch(() => {});
    api.getInvestigationArtifacts(id).then((a) => (artifactCount.value = a.length)).catch(() => {});
    pendingProposals.value = 0;
    api.getInvestigationProposals(id, 'pending').then((p) => (pendingProposals.value = p.length)).catch(() => {});
    await loadWorkspace();
  },
  { immediate: true },
);

watch(() => store.sources.map((s) => s.id).join(','), loadWorkspace);

watch([() => store.unified, activeTab, () => view.value === 'trace', () => trace.columns], render);

// --- money trace (T5) ---
/** The traced subgraph, laid out by layer (`trace-layers`). */
function renderTrace() {
  renderedTab = null;
  const cols = trace.columns;
  const flowIds = new Set(trace.flows.map((f) => f.id));
  graphStore.traceLayers = cols;
  graphStore.setLayoutAlgorithm('trace-layers');
  graphStore.loadInvestigationGraph(
    graphMode(new Map()),
    store.unified.nodes.filter((n) => cols?.columns.has(n.node_id)),
    store.unified.edges.filter((e) => flowIds.has(e.edge_id)),
  );
}

async function followMoney(target: ContextMenuTarget, direction: TraceDirection) {
  if (await trace.start(target, direction)) view.value = 'trace';
  else toast.error('No edge with an amount and a time to follow from here');
}

const TRACE_ACTIONS: [TraceDirection, string][] = [
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
    handler: (t) => pathBar.value?.start(t.id),
  });
});

const traceChips = computed(() => {
  const r = trace.result;
  if (!r) return null;
  const retained = Object.values(r.nodes).filter((n) => n.retained > 0);
  const frontier = r.frontier.reduce((s, f) => s + f.amount, 0);
  return {
    seed: formatAmount(r.seedTotal),
    exits: `${formatAmount(r.exitTotal)} reached ${r.method.direction === 'backward' ? 'origins' : 'exits'} (${Math.round(r.coverage * 100)}%)`,
    retained: `${formatAmount(retained.reduce((s, n) => s + n.retained, 0))} retained in ${retained.length} ${retained.length === 1 ? 'account' : 'accounts'}`,
    frontier: frontier > 0 ? `${formatAmount(frontier)} at the layer limit` : null,
    layers: trace.columns ? trace.columns.labels.length - (trace.columns.exits ? 2 : 1) : 0,
  };
});

// Role fills follow the case state, without reloading the graph.
watch(
  () => store.roles,
  (roles) => (graphStore.roleColors = roleColorMap(roles)),
  { immediate: true },
);

onUnmounted(() => {
  for (const [direction] of TRACE_ACTIONS) contextMenu.removeAction(`trace-${direction}`);
  contextMenu.removeAction('path-to');
  trace.reset();
  graphStore.traceLayers = null;
  pick(null);
  resetMetricsCalculator();
  communityStore.clearCommunities();
  graphStore.clear();
});

// --- inspector ---
const selected = computed(() => graphStore.selectedNode as UnifiedNode | null);
const selectedSources = computed(() => (selected.value ? nodeSourceIds(selected.value) : []));
const selectedProps = computed(() => Object.entries(selected.value?.properties ?? {}));

// --- roles, notes and journal (F1.7) ---
const canEdit = computed(() => !!store.current?.has_write_access && store.current.status !== 'decidido');
const selectedRole = computed(() => (selected.value ? store.roles[selected.value.node_id] ?? '' : ''));
const selectedNotes = computed(() =>
  store.notes.filter((n) => n.anchor?.kind === 'node' && n.anchor.id === selected.value?.node_id),
);
const journal = computed(() => [...store.events].reverse());

async function run(action: () => Promise<unknown>, fallback: string) {
  actionError.value = null;
  try {
    await action();
  } catch (e) {
    actionError.value = getErrorMessage(e, fallback);
  }
}

function openTab(tab: string) {
  activeTab.value = tab;
  view.value = 'graph';
}

function onArtifactsChanged(count: number) {
  artifactCount.value = count;
  store.fetchEvents().catch(() => {});
}

function onRoleChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value as InvestigationRole | '';
  const id = selected.value?.node_id;
  if (id) run(() => store.setRole(id, value || null), 'Failed to set role');
}

function addNote() {
  const id = selected.value?.node_id;
  const body = noteDraft.value.trim();
  if (!id || !body) return;
  run(async () => {
    await store.addNote({ kind: 'node', id }, body);
    noteDraft.value = '';
  }, 'Failed to add note');
}

/** Freezes what the current tab shows (F4.1): nodes, edges, roles and the selection. */
function pinGraphEvidence() {
  const tab = activeTab.value === UNIFIED ? 'Unified view' : sourceTitle(activeTab.value);
  const nodes = graphStore.nodes.map((n) => ({ node_id: n.node_id, node_type: n.node_type, properties: n.properties ?? {} }));
  const edges = graphStore.edges.map((e) => ({
    edge_id: e.edge_id, src: e.src, dst: e.dst, relationship_type: e.relationship_type, properties: e.properties ?? {},
  }));
  const ids = new Set(nodes.map((n) => n.node_id));
  store
    .pinEvidence({
      title: `Graph · ${tab} · ${nodes.length} nodes`,
      kind: 'graph_state',
      params: { tab: activeTab.value, tab_title: tab, nodes: nodes.length, edges: edges.length, selected: selected.value?.node_id ?? null },
      snapshot: { nodes, edges, roles: Object.fromEntries(Object.entries(store.roles).filter(([k]) => ids.has(k))) },
    })
    .then((row) => row && toast.success(`Evidence pinned · hash ${row.sha256.slice(0, 8)}`))
    .catch((e) => toast.error(getErrorMessage(e, 'Failed to pin evidence')));
}

const formatTime = (iso: string) => new Date(iso).toLocaleString();
const deadline = computed(() => (store.current ? deadlineOf(store.current) : null));
</script>

<template>
  <div class="workspace">
    <div v-if="store.loading && !store.current" class="loading"></div>
    <div v-else-if="store.error" class="error-message">{{ store.error }}</div>
    <template v-else-if="store.current">
      <header class="ws-header">
        <RouterLink to="/investigations" class="back">← Investigations</RouterLink>
        <h1 data-testid="investigation-title">{{ store.current.title }}</h1>
        <span v-if="view === 'trace'" class="muted">› Follow the money</span>
        <span class="status">{{ STATUS_LABELS[store.current.status] ?? store.current.status }}</span>
        <span
          v-if="deadline"
          class="status"
          :class="{ urgent: deadline.daysLeft < URGENT_DAYS }"
          data-testid="workspace-deadline"
        >
          {{ deadline.phase }} · {{ deadline.daysLeft }} d left
        </span>
        <span v-if="store.current.typology" class="muted">{{ store.current.typology }}</span>
        <RouterLink :to="`/investigations/${id}/dossier`" class="agents-link" data-testid="dossier-link">Dossier</RouterLink>
        <RouterLink :to="`/investigations/${id}/matches`" class="agents-link" data-testid="matches-link">
          Matches · {{ openMatches }}
        </RouterLink>
        <RouterLink :to="`/investigations/${id}/agents`" class="agents-link" data-testid="proposals-counter">
          Agents · {{ pendingProposals }} {{ pendingProposals === 1 ? 'proposal' : 'proposals' }}
        </RouterLink>
      </header>

      <nav class="tabs" data-testid="workspace-tabs">
        <button
          class="tab"
          :class="{ active: view === 'graph' && activeTab === UNIFIED }"
          data-testid="tab-unified"
          @click="openTab(UNIFIED)"
        >
          <span class="dots">
            <span v-for="s in readableSources" :key="s.id" class="dot" :style="{ background: store.sourceColors[s.id] }"></span>
          </span>
          Unified view
        </button>
        <template v-for="s in store.sources" :key="s.id">
          <button
            v-if="s.accessible"
            class="tab"
            :class="{ active: view === 'graph' && activeTab === s.id }"
            :data-testid="`tab-${s.id}`"
            @click="openTab(s.id)"
          >
            <span class="dot" :style="{ background: store.sourceColors[s.id] }"></span>
            {{ s.title_snapshot }}
          </button>
          <span v-else class="tab restricted" :data-testid="`tab-${s.id}`" :title="`Owner: ${s.owner_email}`">
            <Lock :size="12" /> {{ s.context_title ?? s.title_snapshot }} · restricted
          </span>
        </template>
        <button
          v-if="store.current.has_write_access && store.current.status !== 'decidido'"
          class="tab add"
          data-testid="investigation-add-sources"
          @click="showAdd = true"
        >
          <Plus :size="14" /> Add
        </button>
        <button v-if="trace.result" class="tab" :class="{ active: view === 'trace' }" data-testid="tab-trace" @click="view = 'trace'">
          <Banknote :size="14" /> Follow the money
        </button>
        <button class="tab" :class="{ active: view === 'space' }" data-testid="tab-space" @click="view = 'space'">
          Case space<span v-if="artifactCount !== null" class="count">{{ artifactCount }}</span>
        </button>
      </nav>

      <ArtifactsSpace
        v-if="view === 'space'"
        :investigation-id="id"
        :can-edit="canEdit"
        @changed="onArtifactsChanged"
      />

      <div v-show="view !== 'space'" class="ws-body" :class="{ tracing: view === 'trace' }">
        <TracePanel v-if="view === 'trace'" />
        <TypologyBadgesPanel v-else-if="showTypologies" :can-edit="canEdit" />
        <SourcesPanel
          v-else
          :sources="store.sources"
          :graphs="store.sourceGraphs"
          :contexts="store.contexts"
          :colors="store.sourceColors"
          :merged-counts="mergedCounts"
          :active-tab="activeTab"
          @select="openTab($event)"
        >
          <template #files>
            <CaseFiles :investigation-id="id" :can-edit="canEdit" @source-added="openTab($event)" />
          </template>
        </SourcesPanel>

        <div class="center">
        <div v-if="view === 'trace' && traceChips" class="trace-bar" data-testid="trace-bar">
          <div class="trace-toggle">
            <button :class="{ on: trace.view === 'layers' }" data-testid="trace-view-layers" @click="trace.view = 'layers'">Layers</button>
            <button :class="{ on: trace.view === 'sankey' }" data-testid="trace-view-sankey" @click="trace.view = 'sankey'">Sankey</button>
          </div>
          <span class="chip-fill seed">{{ traceChips.seed }} seed</span>
          <span class="chip-fill exits" data-testid="trace-coverage">{{ traceChips.exits }}</span>
          <span class="chip-fill retained">{{ traceChips.retained }}</span>
          <span v-if="traceChips.frontier" class="chip-fill retained">{{ traceChips.frontier }}</span>
          <span class="muted trace-sub">{{ traceChips.layers }} {{ traceChips.layers === 1 ? 'layer' : 'layers' }} to the {{ trace.direction === 'backward' ? 'origins' : 'exits' }}</span>
        </div>
        <section class="canvas-area" data-testid="graph-container">
          <div v-if="store.graphLoading || graphStore.loading" class="overlay">
            {{ graphStore.loadingMessage || 'Loading sources…' }}
          </div>
          <div v-else-if="store.sources.length === 0" class="overlay">
            No sources yet. Add explorations from any context you can read.
          </div>
          <div v-if="graphStore.queryError" class="error-banner">{{ graphStore.queryError.message }}</div>

          <TraceSankey
            v-if="view === 'trace' && trace.view === 'sankey' && trace.result && trace.columns"
            :flows="trace.flows"
            :columns="trace.columns"
            :name-of="trace.nameOf"
            :allocation="trace.result.method.allocation"
          />

          <div v-if="view === 'graph' && activeTab === UNIFIED && readableSources.length" class="legend" data-testid="provenance-legend">
            <div class="legend-title">Provenance (ring)</div>
            <div v-for="s in readableSources" :key="s.id" class="legend-row">
              <span class="ring" :style="{ borderColor: store.sourceColors[s.id] }"></span>
              {{ s.title_snapshot }}
            </div>
            <div class="legend-title roles-title">Role (fill)</div>
            <div v-for="(color, role) in ROLE_COLORS" :key="role" class="legend-row">
              <span class="fill" :style="{ background: color }"></span>
              {{ ROLE_LABELS[role] }}
            </div>
          </div>

          <GraphCanvas3D ref="canvasRef" />
          <PathBar ref="pathBar" :name-of="trace.nameOf" />

          <div v-if="showLayout" class="layout-panel">
            <LayoutPanel
              :is-layout-running="canvasRef?.isLayoutRunning ?? false"
              @start-layout="canvasRef?.startLayout()"
              @stop-layout="canvasRef?.stopLayout()"
              @reheat-layout="canvasRef?.reheatLayout()"
              @scramble-layout="canvasRef?.scrambleLayout()"
              @start-edge-type-layout="(et: string | null, s: string) => canvasRef?.startEdgeTypeLayout(et, s as any, similarityStore.useScoreAsWeight)"
              @close="showLayout = false"
            />
          </div>

          <div v-if="view === 'graph'" class="canvas-actions">
            <button class="btn btn-outline btn-sm" data-testid="workspace-layout-btn" @click="showLayout = !showLayout">
              Layout
            </button>
            <button
              class="btn btn-outline btn-sm"
              :class="{ on: showTypologies }"
              data-testid="workspace-typologies-btn"
              @click="showTypologies = !showTypologies"
            >
              Typology badges
            </button>
            <button
              v-if="canEdit && graphStore.nodes.length"
              class="btn btn-outline btn-sm"
              title="Freeze what this tab shows as evidence (immutable, with a sha256)"
              data-testid="pin-evidence"
              @click="pinGraphEvidence"
            >
              Pin evidence
            </button>
          </div>
        </section>
        <SwimlaneTimeline
          v-if="view === 'trace' && trace.result"
          :result="trace.result"
          :flows="trace.allFlows"
          :name-of="trace.nameOf"
          :focus="trace.focus"
          @update:focus="trace.focus = $event"
        />
        </div>

        <TraceExits v-if="view === 'trace'" />
        <aside v-else class="inspector" data-testid="workspace-inspector">
          <template v-if="selected">
            <div class="muted">{{ selected.node_type }}</div>
            <h3 class="entity" data-testid="inspector-title">{{ selected.node_id }}</h3>
            <div class="chips">
              <span
                v-for="sid in selectedSources"
                :key="sid"
                class="chip"
                :style="{ borderColor: store.sourceColors[sid], color: store.sourceColors[sid] }"
              >
                {{ sourceTitle(sid) }}
              </span>
              <span v-if="selectedSources.length > 1" class="chip linked" data-testid="inspector-linked">
                highlighted in {{ selectedSources.length }} tabs
              </span>
            </div>
            <label class="role-row">
              <span class="muted">Role</span>
              <select
                :value="selectedRole"
                :disabled="!canEdit"
                data-testid="inspector-role"
                @change="onRoleChange"
              >
                <option value="">— none —</option>
                <option v-for="(label, role) in ROLE_LABELS" :key="role" :value="role">{{ label }}</option>
              </select>
            </label>
            <div v-if="actionError" class="action-error">{{ actionError }}</div>
            <div class="inspector-tabs">
              <button :class="{ active: inspectorTab === 'data' }" @click="inspectorTab = 'data'">Data</button>
              <button
                :class="{ active: inspectorTab === 'enrichment' }"
                data-testid="inspector-enrichment-tab"
                @click="inspectorTab = 'enrichment'"
              >
                Enrichment
              </button>
              <button :class="{ active: inspectorTab === 'notes' }" data-testid="inspector-notes-tab" @click="inspectorTab = 'notes'">
                Notes<template v-if="selectedNotes.length"> ({{ selectedNotes.length }})</template>
              </button>
              <button :class="{ active: inspectorTab === 'origin' }" data-testid="inspector-origin-tab" @click="inspectorTab = 'origin'">
                Origin
              </button>
            </div>
            <dl v-if="inspectorTab === 'data'" class="props">
              <template v-for="[k, v] in selectedProps" :key="k">
                <dt>{{ k }}</dt>
                <dd>
                  {{ v }}
                  <span v-if="selected.__conflicts?.[k]" class="conflict" title="Other sources disagree">
                    ≠ {{ selected.__conflicts[k].map((c) => c.value).join(', ') }}
                  </span>
                </dd>
              </template>
            </dl>
            <EnrichmentTab v-else-if="inspectorTab === 'enrichment'" :node="selected" :can-edit="canEdit" />
            <div v-else-if="inspectorTab === 'notes'" class="notes" data-testid="inspector-notes">
              <div v-for="n in selectedNotes" :key="n.id" class="note" data-testid="note">
                <p>{{ n.body }}</p>
                <div class="muted">
                  {{ n.author_email }} · {{ n.created_at ? formatTime(n.created_at) : '' }}
                  <button
                    v-if="canEdit && n.author_email === auth.email"
                    class="link-btn"
                    @click="run(() => store.deleteNote(n.id), 'Failed to delete note')"
                  >
                    delete
                  </button>
                </div>
              </div>
              <p v-if="!selectedNotes.length" class="muted">No notes on this entity yet.</p>
              <template v-if="canEdit">
                <textarea v-model="noteDraft" rows="3" placeholder="Add a note…" data-testid="note-input"></textarea>
                <button class="btn btn-primary btn-sm" :disabled="!noteDraft.trim()" data-testid="note-add" @click="addNote">
                  Add note
                </button>
              </template>
            </div>
            <div v-else class="origin" data-testid="inspector-origin">
              <div v-for="o in selected.__sources" :key="`${o.sourceId}:${o.nodeId}`" class="origin-row">
                <strong>{{ sourceTitle(o.sourceId) }}</strong>
                <span class="muted">
                  {{ o.sourceId.startsWith('expansion:') ? 'expansion · ' : '' }}{{ contextTitle(o.contextId) }} · id {{ o.nodeId }}
                </span>
              </div>
              <div v-for="(list, prop) in selected.__conflicts ?? {}" :key="prop" class="origin-row conflict">
                {{ prop }}: kept “{{ prop === 'node_type' ? selected.node_type : selected.properties?.[prop] }}”;
                also {{ list.map((c) => `“${c.value}” (${sourceTitle(c.sourceId)})`).join(', ') }}
              </div>
            </div>
          </template>
          <p v-else class="muted">Select a node to see its data and where it came from.</p>
        </aside>
      </div>

      <section v-if="showJournal" class="journal" data-testid="journal">
        <div v-for="e in journal" :key="e.id" class="journal-row" data-testid="journal-event">
          <span class="muted">{{ formatTime(e.at) }}</span>
          <strong v-if="e.actor_kind === 'agent'" data-testid="journal-agent">
            agent {{ e.agent_name }} on behalf of {{ e.actor_email }}
          </strong>
          <strong v-else>{{ e.actor_email }}</strong>
          <span>{{ describeEvent(e) }}</span>
        </div>
        <p v-if="!journal.length" class="muted">Nothing recorded yet.</p>
      </section>

      <footer class="status-bar" data-testid="workspace-status">
        <span>{{ graphStore.nodes.length }} nodes</span>
        <span>{{ graphStore.edges.length }} edges</span>
        <span>
          {{ readableSources.length }} {{ readableSources.length === 1 ? 'source' : 'sources' }}<template v-if="restrictedCount">
            + {{ restrictedCount }} restricted</template>
        </span>
        <button class="link-btn journal-btn" data-testid="journal-toggle" @click="showJournal = !showJournal">
          Journal ({{ store.events.length }}) {{ showJournal ? '▾' : '▴' }}
        </button>
      </footer>
    </template>

    <AddToInvestigationModal :open="showAdd" :investigation-id="id" @close="showAdd = false" />

    <div v-if="pickerOrigins" class="modal-overlay" @click.self="pick(null)">
      <div class="modal picker" data-testid="expand-context-picker">
        <div class="modal-header">
          <h2>Expand from which context?</h2>
          <button class="modal-close" aria-label="Close" @click="pick(null)">&times;</button>
        </div>
        <p class="muted">This entity exists in more than one context. Its neighbors come from the one you pick.</p>
        <button
          v-for="o in pickerOrigins"
          :key="o.contextId"
          class="btn btn-outline picker-option"
          :data-testid="`expand-context-${o.contextId}`"
          @click="pick(o)"
        >
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

.ws-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 10px 16px 4px;
}

.ws-header h1 {
  margin: 0;
  font-size: 18px;
}

.back,
.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.agents-link + .agents-link {
  margin-left: 0;
}

.agents-link {
  margin-left: auto;
  padding: 4px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  font-size: 13px;
  color: var(--text-color);
  text-decoration: none;
}

.status {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  background: var(--color-primary-subtle);
  color: var(--color-primary);
}

.status.urgent {
  background: #c2410c;
  color: #fff;
  font-weight: 600;
}

.tabs {
  display: flex;
  gap: 4px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  font: inherit;
  font-size: 14px;
  white-space: nowrap;
  cursor: pointer;
  color: var(--text-color);
}

.tab.active {
  font-weight: 600;
  border-bottom-color: var(--color-primary);
}

.tab .count {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  background: var(--border-color);
}

.tab.restricted {
  color: var(--text-muted);
  cursor: default;
}

.tab.add {
  color: var(--color-primary);
  font-weight: 600;
}

.dots {
  display: inline-flex;
  gap: 2px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.ws-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 250px 1fr 300px;
}

.ws-body.tracing {
  grid-template-columns: 270px 1fr 280px;
}

.center {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.trace-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--color-surface);
  font-size: 13px;
}

.trace-toggle {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: var(--radius-md);
  background: var(--color-bg-muted);
}

.trace-toggle button {
  padding: 4px 12px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  font: inherit;
  cursor: pointer;
}

.trace-toggle button.on {
  background: var(--color-secondary);
  color: #fff;
  font-weight: 600;
}

.chip-fill {
  padding: 4px 10px;
  border-radius: var(--radius-pill);
}

.chip-fill.seed {
  background: #eff6ff;
  color: #1e3a8a;
}

.chip-fill.exits {
  background: #f0fdfa;
  color: #115e59;
  font-weight: 600;
}

.chip-fill.retained {
  background: #fff7ed;
  color: #9a3412;
}

.trace-sub {
  flex-basis: 100%;
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

.ring {
  width: 10px;
  height: 10px;
  border: 2px solid;
  border-radius: 50%;
}

.layout-panel {
  position: absolute;
  bottom: 56px;
  left: 12px;
  z-index: 6;
}

.canvas-actions {
  position: absolute;
  bottom: 12px;
  left: 12px;
  z-index: 4;
  display: flex;
  gap: 8px;
}

.canvas-actions .on {
  border-color: #c2410c;
  color: #c2410c;
}

.inspector {
  padding: 14px;
  overflow-y: auto;
  border-left: 1px solid var(--border-color);
  background: var(--color-surface);
}

.entity {
  margin: 2px 0 8px;
  font-size: 16px;
  word-break: break-all;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  padding: 2px 8px;
  border: 1.5px solid;
  border-radius: var(--radius-pill);
  font-size: 12px;
}

.chip.linked {
  border-color: transparent;
  background: var(--color-primary-subtle);
  color: var(--color-primary);
}

.inspector-tabs {
  display: flex;
  gap: 12px;
  margin: 14px 0 8px;
  border-bottom: 1px solid var(--border-color);
}

.inspector-tabs button {
  padding: 6px 0;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.inspector-tabs button.active {
  font-weight: 600;
  border-bottom-color: var(--color-primary);
}

.props {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 13px;
}

.props dt {
  color: var(--text-muted);
}

.props dd {
  margin: 0;
  word-break: break-word;
}

.conflict {
  color: var(--color-warning);
  font-size: 12px;
}

.origin-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border-color);
}

.roles-title {
  margin-top: 10px;
}

.fill {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.role-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: 13px;
}

.role-row select {
  flex: 1;
}

.action-error {
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-error);
}

.notes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}

.note {
  padding: 6px 0;
  border-bottom: 1px solid var(--border-color);
}

.note p {
  margin: 0 0 2px;
  white-space: pre-wrap;
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

.journal {
  max-height: 200px;
  overflow-y: auto;
  padding: 8px 16px;
  border-top: 1px solid var(--border-color);
  background: var(--color-surface);
  font-size: 13px;
}

.journal-row {
  display: flex;
  gap: 10px;
  padding: 3px 0;
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
