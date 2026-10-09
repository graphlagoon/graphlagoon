<script setup lang="ts">
/**
 * Investigation workspace (T2): a tab per exploration plus the unified view, all
 * rendered by the regular graph store and canvas in investigation mode. Node ids
 * are unified ids in every tab, so the selection follows the entity across tabs.
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { Lock, Plus } from 'lucide-vue-next';
import { useInvestigationStore } from '@/stores/investigation';
import { useGraphStore, type InvestigationGraphMode } from '@/stores/graph';
import { useCommunityStore } from '@/stores/community';
import { useSimilarityStore } from '@/stores/similarity';
import { useAuthStore } from '@/stores/auth';
import { resetMetricsCalculator } from '@/services/metricsCalculator';
import { STATUS_LABELS } from '@/utils/investigationStatus';
import { provenanceRingColors, roleColorMap, ROLE_COLORS, ROLE_LABELS } from '@/utils/graphAppearance';
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
import type { GraphResponse } from '@/types/graph';
import type { InvestigationEvent, InvestigationRole } from '@/types/investigation';

const props = defineProps<{ id: string }>();

const UNIFIED = 'unified';

const store = useInvestigationStore();
const graphStore = useGraphStore();
const communityStore = useCommunityStore();
const similarityStore = useSimilarityStore();
const auth = useAuthStore();

const showAdd = ref(false);
const showLayout = ref(false);
const activeTab = ref(UNIFIED);
const inspectorTab = ref<'data' | 'notes' | 'origin'>('data');
const showJournal = ref(false);
const noteDraft = ref('');
const actionError = ref<string | null>(null);
const canvasRef = ref<InstanceType<typeof GraphCanvas3D> | null>(null);

const readableSources = computed(() => store.sources.filter((s) => s.accessible));
const restrictedCount = computed(() => store.sources.length - readableSources.value.length);
const sourceTitle = (sourceId: string) =>
  store.sources.find((s) => s.id === baseSourceId(sourceId))?.title_snapshot ?? sourceId;
const contextTitle = (contextId: string) => store.contexts[contextId]?.title ?? contextId;
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

// --- loading a tab into the graph store ---
// The community store clears its results whenever `nodes` changes; keep each tab's
// communities and put them back after the swap (same timing as loadExploration).
const communityByTab = new Map<string, Record<string, unknown> | undefined>();
let renderedTab: string | null = null;

async function render() {
  const tab = activeTab.value;
  if (renderedTab !== null) communityByTab.set(renderedTab, communityStore.getState());

  const { nodes, edges } = store.unified;
  const tabNodes = tab === UNIFIED ? nodes : nodes.filter((n) => nodeSourceIds(n).includes(tab));
  const tabEdges = tab === UNIFIED ? edges : edges.filter((e) => baseSourceId(e.__source) === tab);

  const mode: InvestigationGraphMode = {
    origins: new Map(nodes.map((n) => [n.node_id, n.__sources])),
    // Rings tell sources apart, so only the unified view draws them.
    rings: new Map(
      tab === UNIFIED
        ? nodes.map((n) => [n.node_id, provenanceRingColors(nodeSourceIds(n), store.sourceColors)])
        : [],
    ),
    chooseOrigin,
    applyExpansion,
  };
  graphStore.loadInvestigationGraph(mode, tabNodes, tabEdges);
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
    await store.openInvestigation(id);
    // The journal and notes are secondary: a failure here must not block the graph.
    store.fetchNotes().catch(() => {});
    store.fetchEvents().catch(() => {});
    await loadWorkspace();
  },
  { immediate: true },
);

watch(() => store.sources.map((s) => s.id).join(','), loadWorkspace);

watch([() => store.unified, activeTab], render);

// Role fills follow the case state, without reloading the graph.
watch(
  () => store.roles,
  (roles) => (graphStore.roleColors = roleColorMap(roles)),
  { immediate: true },
);

onUnmounted(() => {
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

/** One line per journal event; unknown kinds fall back to the raw kind. */
function describeEvent(e: InvestigationEvent): string {
  const p = e.payload as Record<string, any>;
  switch (e.kind) {
    case 'case.created': return `created the case “${p.title ?? ''}”`;
    case 'case.updated': return `updated ${Object.keys(p).join(', ') || 'the case'}`;
    case 'case.shared': return `shared with ${p.with} (${p.permission})`;
    case 'case.unshared': return `stopped sharing with ${p.with}`;
    case 'source.added': return `added source “${p.title}” (${p.mode})`;
    case 'source.removed': return `removed source “${p.title}”`;
    case 'role.changed': return `marked ${p.entity} as ${p.to ? ROLE_LABELS[p.to] ?? p.to : 'no role'}`;
    case 'pin.changed': return `${p.pinned ? 'pinned' : 'unpinned'} ${p.entity}`;
    case 'note.created': return `noted on ${p.anchor?.id ?? 'the case'}: “${p.body}”`;
    case 'note.updated': return 'edited a note';
    case 'note.deleted': return 'deleted a note';
    default: return e.kind;
  }
}

const formatTime = (iso: string) => new Date(iso).toLocaleString();
</script>

<template>
  <div class="workspace">
    <div v-if="store.loading && !store.current" class="loading"></div>
    <div v-else-if="store.error" class="error-message">{{ store.error }}</div>
    <template v-else-if="store.current">
      <header class="ws-header">
        <RouterLink to="/investigations" class="back">← Investigations</RouterLink>
        <h1 data-testid="investigation-title">{{ store.current.title }}</h1>
        <span class="status">{{ STATUS_LABELS[store.current.status] ?? store.current.status }}</span>
        <span v-if="store.current.typology" class="muted">{{ store.current.typology }}</span>
      </header>

      <nav class="tabs" data-testid="workspace-tabs">
        <button
          class="tab"
          :class="{ active: activeTab === UNIFIED }"
          data-testid="tab-unified"
          @click="activeTab = UNIFIED"
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
            :class="{ active: activeTab === s.id }"
            :data-testid="`tab-${s.id}`"
            @click="activeTab = s.id"
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
      </nav>

      <div class="ws-body">
        <SourcesPanel
          :sources="store.sources"
          :graphs="store.sourceGraphs"
          :contexts="store.contexts"
          :colors="store.sourceColors"
          :merged-counts="mergedCounts"
          :active-tab="activeTab"
          @select="activeTab = $event"
        />

        <section class="canvas-area" data-testid="graph-container">
          <div v-if="store.graphLoading || graphStore.loading" class="overlay">
            {{ graphStore.loadingMessage || 'Loading sources…' }}
          </div>
          <div v-else-if="store.sources.length === 0" class="overlay">
            No sources yet. Add explorations from any context you can read.
          </div>
          <div v-if="graphStore.queryError" class="error-banner">{{ graphStore.queryError.message }}</div>

          <div v-if="activeTab === UNIFIED && readableSources.length" class="legend" data-testid="provenance-legend">
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

          <div class="canvas-actions">
            <button class="btn btn-outline btn-sm" data-testid="workspace-layout-btn" @click="showLayout = !showLayout">
              Layout
            </button>
          </div>
        </section>

        <aside class="inspector" data-testid="workspace-inspector">
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
          <strong>{{ e.actor_email }}</strong>
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

.status {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  background: var(--color-primary-subtle);
  color: var(--color-primary);
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

.canvas-area {
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
