<script setup lang="ts">
/**
 * The case screen (05 §3): one canvas fed by the case's graph items (checked
 * "on canvas" in the material list), an inspector with the entity's roles,
 * suggestions, notes and origin, and the journal. Everything that enters the
 * case is an item; roles, tags and matches are annotations.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { Banknote, Maximize2, Plus, Route } from 'lucide-vue-next';
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
import { caseNodeLabel, hiddenRawDocumentKeys, shortId } from '@/utils/caseLabels';
import { provenanceRingColors, roleColor, roleColorMap, ROLE_LABELS } from '@/utils/graphAppearance';
import { describeEvent } from '@/utils/investigationEvents';
import { getErrorMessage } from '@/utils/errorMessage';
import { baseSourceId, mergedEntityCounts, nodeSourceIds, type NodeOrigin, type UnifiedNode } from '@/utils/unifyGraph';
import GraphCanvas3D from '@/components/GraphCanvas3D.vue';
import LayoutPanel from '@/components/LayoutPanel.vue';
import CaseHeader from '@/components/investigation/CaseHeader.vue';
import CaseItemsPanel from '@/components/investigation/CaseItemsPanel.vue';
import AddToInvestigationModal from '@/components/investigation/AddToInvestigationModal.vue';
import FileImportWizard from '@/components/investigation/FileImportWizard.vue';
import EnrichmentTab from '@/components/investigation/EnrichmentTab.vue';
import TracePanel from '@/components/investigation/TracePanel.vue';
import TypologyBadgesPanel from '@/components/investigation/TypologyBadgesPanel.vue';
import TraceExits from '@/components/investigation/TraceExits.vue';
import TraceSankey from '@/components/investigation/TraceSankey.vue';
import SwimlaneTimeline from '@/components/investigation/SwimlaneTimeline.vue';
import PathBar from '@/components/investigation/PathBar.vue';
import type { GraphResponse } from '@/types/graph';
import type { CaseAnnotation, CaseItem } from '@/types/investigation';

const props = defineProps<{ id: string }>();

const store = useInvestigationStore();
const graphStore = useGraphStore();
const communityStore = useCommunityStore();
const similarityStore = useSimilarityStore();
const auth = useAuthStore();
const trace = useTraceStore();
const contextMenu = useContextMenu();
const toast = useToast();

const showAdd = ref(false);
const showWizard = ref(false);
const showLayout = ref(false);
/** The canvas or the money trace (T5). */
const view = ref<'graph' | 'trace'>('graph');
const inspectorTab = ref<'data' | 'enrichment' | 'notes' | 'origin'>('data');
const showJournal = ref(false);
/** Left column: the material or the typology badges (T9). */
const showTypologies = ref(false);
const noteDraft = ref('');
const actionError = ref<string | null>(null);
const activeItem = ref<CaseItem | null>(null);
const canvasRef = ref<InstanceType<typeof GraphCanvas3D> | null>(null);
const pathBar = ref<InstanceType<typeof PathBar> | null>(null);

const sourceTitle = (sourceId: string) => store.itemTitle(baseSourceId(sourceId));
const contextTitle = (contextId: string) => store.contexts[contextId]?.title ?? store.itemTitle(contextId);
const mergedCounts = computed(() => mergedEntityCounts(store.unified.nodes));

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
  if (view.value === 'trace') return renderTrace();
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
  // Small base nodes and thin rings read better on a unified graph (05 §3).
  graphStore.updateAesthetics({ nodeSize: Math.min(graphStore.aesthetics.nodeSize, CASE_NODE_SIZE) });
  zoomToFitSoon();
}

const CASE_NODE_SIZE = 5;

/** Frames the graph once the canvas has built the new scene. */
function zoomToFitSoon() {
  requestAnimationFrame(() => requestAnimationFrame(() => canvasRef.value?.zoomToFit?.()));
}

/** Readable name of a unified node (inspector, journal): label, else type · short id. */
const labelById = computed(() => new Map(store.unified.nodes.map((n) => [n.node_id, caseNodeLabel(n)])));
const nameOf = (id: string) => labelById.value.get(id) ?? shortId(id);

watch(
  () => props.id,
  async (id) => {
    savedCommunities = undefined;
    view.value = 'graph';
    activeItem.value = null;
    trace.reset();
    await store.openInvestigation(id);
    // The journal and the brief are secondary: a failure here must not block the graph.
    store.fetchEvents().catch(() => {});
    store.fetchBrief().catch(() => {});
    await loadWorkspace();
  },
  { immediate: true },
);

watch(() => store.graphItems.map((s) => `${s.id}:${s.current_version}:${s.mapping?.as ?? ''}`).join(','), loadWorkspace);
watch([() => store.unified, () => view.value === 'trace', () => trace.columns], render);

// --- money trace (T5) ---
/** The traced subgraph, laid out by layer (`trace-layers`). */
function renderTrace() {
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

// Role fills follow the confirmed role annotations, without reloading the graph.
watch(
  () => store.roles,
  (roles) => (graphStore.roleColors = roleColorMap(roles)),
  { immediate: true },
);
const legendRoles = computed(() => [...new Set(Object.values(store.roles))].sort());

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
const selectedProps = computed(() => {
  const props = selected.value?.properties ?? {};
  const hidden = hiddenRawDocumentKeys(props);
  return Object.entries(props).filter(([k]) => !hidden.has(k));
});

const canEdit = computed(() => !!store.current?.has_write_access && store.current.status !== 'decided');
const selectedRole = computed(() => (selected.value ? store.roles[selected.value.node_id] ?? '' : ''));
/** Role vocabulary: the preset suggestions plus every role already used in the case. */
const roleOptions = computed(() => {
  const used = new Set(Object.values(store.roles));
  for (const a of store.annotations) if (a.kind === 'role') used.add(String(a.value.role));
  return [...new Set([...Object.keys(ROLE_LABELS), ...used])];
});
const selectedNotes = computed(() => store.notes.filter((n) => n.anchor?.entity_ids?.includes(selected.value?.node_id ?? '')));
const selectedSuggestions = computed(() =>
  store.annotations.filter((a) => a.status === 'suggested' && selected.value && a.targets.includes(selected.value.node_id)),
);
const selectedAnnotations = computed(() =>
  store.annotations.filter(
    (a) => a.status === 'confirmed' && a.kind !== 'role' && selected.value && a.targets.includes(selected.value.node_id),
  ),
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

function onRoleChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  const id = selected.value?.node_id;
  if (id) run(() => store.setRole(id, value || null), 'Failed to set role');
}

function addNote() {
  const id = selected.value?.node_id;
  const body = noteDraft.value.trim();
  if (!id || !body) return;
  run(async () => {
    await store.addNote(id, body);
    noteDraft.value = '';
  }, 'Failed to add note');
}

function decideSuggestion(a: CaseAnnotation, status: 'confirmed' | 'rejected') {
  run(() => store.setAnnotationStatus(a.id, status), 'Failed to update the suggestion');
}

const describeAnnotation = (a: CaseAnnotation) => {
  const v = a.value;
  if (a.kind === 'role') return `role: ${v.role}`;
  if (a.kind === 'tag') return `tag: ${v.tag}`;
  if (a.kind === 'group') return `group: ${v.name}`;
  if (a.kind === 'same_as') return `same as ${nameOf(a.targets.find((t) => t !== selected.value?.node_id) ?? '')}`;
  if (a.kind === 'typology') return `typology ${v.norm_ref ?? v.typology}`;
  return a.kind;
};

/** Freezes what the canvas shows as a pinned graph item (evidence). */
function pinGraphEvidence() {
  const nodes = graphStore.nodes.map((n) => ({ node_id: n.node_id, node_type: n.node_type, properties: n.properties ?? {} }));
  const edges = graphStore.edges.map((e) => ({
    edge_id: e.edge_id, src: e.src, dst: e.dst, relationship_type: e.relationship_type, properties: e.properties ?? {},
  }));
  const ids = new Set(nodes.map((n) => n.node_id));
  store
    .pinEvidence({
      title: `Graph · ${nodes.length} nodes`,
      kind: 'graph_state',
      params: { nodes: nodes.length, edges: edges.length, selected: selected.value?.node_id ?? null },
      snapshot: { nodes, edges, roles: Object.fromEntries(Object.entries(store.roles).filter(([k]) => ids.has(k))) },
    })
    .then((row) => row && toast.success(`Evidence pinned · hash ${row.sha256.slice(0, 8)}`))
    .catch((e) => toast.error(getErrorMessage(e, 'Failed to pin evidence')));
}

function findMatches() {
  run(async () => {
    const n = await store.findMatches();
    toast.success(n ? `${n} new match suggestion${n === 1 ? '' : 's'} to review` : 'No new matches');
  }, 'Failed to run entity resolution');
}

function onWizardDone(items: CaseItem[]) {
  showWizard.value = false;
  store.fetchItems().catch(() => {});
  toast.success(`Added ${items.length} file${items.length === 1 ? '' : 's'} to the case`);
}

const formatTime = (iso: string) => new Date(iso).toLocaleString();
</script>

<template>
  <div class="workspace">
    <div v-if="store.loading && !store.current" class="loading"></div>
    <div v-else-if="store.error" class="error-message">{{ store.error }}</div>
    <template v-else-if="store.current">
      <CaseHeader :subtitle="view === 'trace' ? '› Follow the money' : null" />

      <nav class="tabs" data-testid="workspace-tabs">
        <button class="tab" :class="{ active: view === 'graph' }" data-testid="tab-unified" @click="view = 'graph'">
          <span class="dots">
            <span v-for="s in store.canvasItems" :key="s.id" class="dot" :style="{ background: store.sourceColors[s.id] }"></span>
          </span>
          Case
        </button>
        <button v-if="trace.result" class="tab" :class="{ active: view === 'trace' }" data-testid="tab-trace" @click="view = 'trace'">
          <Banknote :size="14" /> Follow the money
        </button>
        <button v-if="canEdit" class="tab add" data-testid="investigation-add-sources" @click="showAdd = true">
          <Plus :size="14" /> Add
        </button>
      </nav>

      <div class="ws-body" :class="{ tracing: view === 'trace' }">
        <TracePanel v-if="view === 'trace'" />
        <TypologyBadgesPanel v-else-if="showTypologies" :can-edit="canEdit" />
        <CaseItemsPanel
          v-else
          :can-edit="canEdit"
          :active-item="activeItem?.id"
          @add="showAdd = true"
          @upload="showWizard = true"
          @select="activeItem = $event"
        />

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
              {{ graphStore.loadingMessage || 'Loading the case…' }}
            </div>
            <div v-else-if="store.graphItems.length === 0" class="overlay empty-canvas" data-testid="canvas-empty">
              <p>Nothing on the canvas yet. Add a recent exploration, start a new one from a context, or upload a file with a mapping.</p>
              <button v-if="canEdit" class="btn btn-primary btn-sm" data-testid="canvas-empty-add" @click="showAdd = true">
                <Plus :size="14" /> Add exploration
              </button>
            </div>
            <div v-if="graphStore.queryError" class="error-banner">{{ graphStore.queryError.message }}</div>

            <TraceSankey
              v-if="view === 'trace' && trace.view === 'sankey' && trace.result && trace.columns"
              :flows="trace.flows"
              :columns="trace.columns"
              :name-of="trace.nameOf"
              :allocation="trace.result.method.allocation"
            />

            <div v-if="view === 'graph' && store.canvasItems.length" class="legend" data-testid="provenance-legend">
              <div class="legend-title">Provenance (ring)</div>
              <div v-for="s in store.canvasItems" :key="s.id" class="legend-row">
                <span class="ring" :style="{ borderColor: store.sourceColors[s.id] }"></span>
                {{ s.title }}
              </div>
              <template v-if="legendRoles.length">
                <div class="legend-title roles-title">Role (fill)</div>
                <div v-for="role in legendRoles" :key="role" class="legend-row">
                  <span class="fill" :style="{ background: roleColor(role) }"></span>
                  {{ ROLE_LABELS[role] ?? role }}
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
              <button class="btn btn-outline btn-sm" data-testid="workspace-layout-btn" @click="showLayout = !showLayout">Layout</button>
              <button class="btn btn-outline btn-sm" title="Fit the graph in the view" aria-label="Fit to view" data-testid="workspace-fit-btn" @click="canvasRef?.zoomToFit?.()">
                <Maximize2 :size="14" />
              </button>
              <button class="btn btn-outline btn-sm" :class="{ on: showTypologies }" data-testid="workspace-typologies-btn" @click="showTypologies = !showTypologies">
                Typology badges
              </button>
              <button v-if="canEdit && graphStore.nodes.length" class="btn btn-outline btn-sm" title="Suggest entities that are the same person (same_as)" data-testid="workspace-matches-btn" @click="findMatches">
                Find matches
              </button>
              <button
                v-if="canEdit && graphStore.nodes.length"
                class="btn btn-outline btn-sm"
                title="Freeze what the canvas shows as a pinned item (immutable, with a sha256)"
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
            <div class="muted">{{ selected.node_type }} · {{ shortId(selected.node_id) }}</div>
            <h3 class="entity" :title="selected.node_id" data-testid="inspector-title">{{ caseNodeLabel(selected) }}</h3>
            <div class="chips">
              <span v-for="sid in selectedSources" :key="sid" class="chip" :style="{ borderColor: store.sourceColors[sid], color: store.sourceColors[sid] }">
                {{ sourceTitle(sid) }}
              </span>
              <span v-if="selectedSources.length > 1" class="chip linked" data-testid="inspector-linked">in {{ selectedSources.length }} items</span>
              <span v-for="a in selectedAnnotations" :key="a.id" class="chip plain" :data-testid="`inspector-annotation-${a.id}`">{{ describeAnnotation(a) }}</span>
            </div>
            <label class="role-row">
              <span class="muted">Role</span>
              <select :value="selectedRole" :disabled="!canEdit" data-testid="inspector-role" @change="onRoleChange">
                <option value="">— none —</option>
                <option v-for="role in roleOptions" :key="role" :value="role">{{ ROLE_LABELS[role] ?? role }}</option>
              </select>
            </label>
            <div v-if="selectedSuggestions.length" class="suggestions" data-testid="inspector-suggestions">
              <div v-for="a in selectedSuggestions" :key="a.id" class="suggestion" :data-testid="`suggestion-${a.id}`">
                <span>
                  <strong>{{ describeAnnotation(a) }}</strong>
                  <span class="muted"> · suggested by {{ a.author_kind === 'agent' ? 'agent' : a.author_email }}</span>
                  <span v-if="a.reason" class="muted"> — {{ a.reason }}</span>
                </span>
                <span v-if="canEdit" class="row">
                  <button class="link-btn ok" :data-testid="`suggestion-confirm-${a.id}`" @click="decideSuggestion(a, 'confirmed')">✓ Confirm</button>
                  <button class="link-btn danger" :data-testid="`suggestion-reject-${a.id}`" @click="decideSuggestion(a, 'rejected')">✕ Reject</button>
                </span>
              </div>
            </div>
            <div v-if="actionError" class="action-error">{{ actionError }}</div>
            <div class="inspector-tabs">
              <button :class="{ active: inspectorTab === 'data' }" @click="inspectorTab = 'data'">Data</button>
              <button :class="{ active: inspectorTab === 'enrichment' }" data-testid="inspector-enrichment-tab" @click="inspectorTab = 'enrichment'">Enrichment</button>
              <button :class="{ active: inspectorTab === 'notes' }" data-testid="inspector-notes-tab" @click="inspectorTab = 'notes'">
                Notes<template v-if="selectedNotes.length"> ({{ selectedNotes.length }})</template>
              </button>
              <button :class="{ active: inspectorTab === 'origin' }" data-testid="inspector-origin-tab" @click="inspectorTab = 'origin'">Origin</button>
            </div>
            <dl v-if="inspectorTab === 'data'" class="props">
              <template v-for="[k, v] in selectedProps" :key="k">
                <dt>{{ k }}</dt>
                <dd>
                  {{ v }}
                  <span v-if="selected.__conflicts?.[k]" class="conflict" title="Other items disagree">
                    ≠ {{ selected.__conflicts[k].map((c) => c.value).join(', ') }}
                  </span>
                </dd>
              </template>
            </dl>
            <EnrichmentTab v-else-if="inspectorTab === 'enrichment'" :node="selected" :can-edit="canEdit" />
            <div v-else-if="inspectorTab === 'notes'" class="notes" data-testid="inspector-notes">
              <div v-for="n in selectedNotes" :key="n.id" class="note" data-testid="note">
                <p>{{ n.description ?? n.title }}</p>
                <div class="muted">
                  {{ n.author_kind === 'agent' ? 'agent · ' : '' }}{{ n.author_email }} · {{ n.created_at ? formatTime(n.created_at) : '' }}
                  <button v-if="canEdit && n.author_email === auth.email" class="link-btn" @click="run(() => store.removeItem(n.id), 'Failed to delete note')">delete</button>
                </div>
              </div>
              <p v-if="!selectedNotes.length" class="muted">No notes on this entity yet.</p>
              <template v-if="canEdit">
                <textarea v-model="noteDraft" rows="3" placeholder="Add a note…" data-testid="note-input"></textarea>
                <button class="btn btn-primary btn-sm" :disabled="!noteDraft.trim()" data-testid="note-add" @click="addNote">Add note</button>
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
          <template v-else-if="activeItem">
            <div class="muted">{{ activeItem.kind }} / {{ activeItem.subkind }}</div>
            <h3 class="entity" data-testid="inspector-item-title">{{ activeItem.title }}</h3>
            <p v-if="activeItem.description" class="muted">{{ activeItem.description }}</p>
            <dl class="props">
              <dt>Author</dt><dd>{{ activeItem.author_kind === 'agent' ? 'agent · ' : '' }}{{ activeItem.author_email }}</dd>
              <dt>Status</dt><dd>{{ activeItem.status }}</dd>
              <dt>Versions</dt><dd>{{ activeItem.current_version }}<template v-if="activeItem.pinned.length"> · {{ activeItem.pinned.length }} pinned</template></dd>
              <template v-if="activeItem.latest"><dt>Hash</dt><dd class="mono">{{ activeItem.latest.sha256.slice(0, 12) }}…</dd></template>
              <template v-if="activeItem.query"><dt>Query</dt><dd class="mono">{{ activeItem.query.text }}</dd></template>
              <template v-if="activeItem.mapping"><dt>Mapping</dt><dd>{{ activeItem.mapping.as }} · {{ (activeItem.mapping.spec as any)?.name ?? '' }}</dd></template>
            </dl>
          </template>
          <p v-else class="muted">Select a node to see its data and where it came from, or an item of the material.</p>
        </aside>
      </div>

      <section v-if="showJournal" class="journal" data-testid="journal">
        <div v-for="e in journal" :key="e.id" class="journal-row" data-testid="journal-event">
          <span class="muted">{{ formatTime(e.at) }}</span>
          <strong v-if="e.actor_kind === 'agent'" data-testid="journal-agent">agent {{ e.agent_name }} on behalf of {{ e.actor_email }}</strong>
          <strong v-else>{{ e.actor_email }}</strong>
          <span>{{ describeEvent(e, nameOf) }}</span>
        </div>
        <p v-if="!journal.length" class="muted">Nothing recorded yet.</p>
      </section>

      <footer class="status-bar" data-testid="workspace-status">
        <span>{{ graphStore.nodes.length }} nodes</span>
        <span>{{ graphStore.edges.length }} edges</span>
        <span>
          {{ store.canvasItems.length }} {{ store.canvasItems.length === 1 ? 'source' : 'sources' }}<template v-if="store.restrictedItems.length">
            + {{ store.restrictedItems.length }} restricted</template>
        </span>
        <span v-if="store.suggestions.length" data-testid="status-suggestions">● {{ store.suggestions.length }} suggestions</span>
        <button class="link-btn journal-btn" data-testid="journal-toggle" @click="showJournal = !showJournal">
          Journal ({{ store.events.length }}) {{ showJournal ? '▾' : '▴' }}
        </button>
      </footer>
    </template>

    <AddToInvestigationModal :open="showAdd" :investigation-id="id" @close="showAdd = false" />
    <FileImportWizard v-if="showWizard" :investigation-id="id" @close="showWizard = false" @done="onWizardDone" />

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

.back,
.muted {
  font-size: 12px;
  color: var(--text-muted);
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
  grid-template-columns: 290px 1fr 300px;
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

.chip.plain {
  border-color: var(--border-color);
  color: var(--text-color);
}

.suggestions {
  margin-top: 10px;
  padding: 8px;
  border: 1px dashed #b45309;
  border-radius: var(--radius-sm);
  background: #fffbeb;
  font-size: 13px;
}

.suggestion {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 0;
}

.suggestion .row {
  display: flex;
  gap: 10px;
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

.mono {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  white-space: pre-wrap;
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

.link-btn.ok {
  color: #15803d;
}

.link-btn.danger {
  color: var(--color-error);
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
