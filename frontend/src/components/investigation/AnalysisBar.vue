<script setup lang="ts">
/**
 * Analysis bar of the canvas (05 §3): visible buttons, each with a parameter
 * popover (never only a context menu). Every run comes back as an item of the
 * case (useCaseAnalyses) and the parent activates it. Filters / Table / Layout /
 * Fit / Advanced toggle the explorer's panels mounted in the case. "Detectors"
 * lists the case type's starter queries (06 §3c): analyses that are data, opened
 * in the inspector to run.
 */
import { computed, ref, watch } from 'vue';
import { Banknote, Filter, GitBranch, Layers, Link2, Maximize2, Radar, Route, Settings2, Sigma, Table2, Terminal, Users } from 'lucide-vue-next';
import { useInvestigationStore } from '@/stores/investigation';
import { useGraphStore } from '@/stores/graph';
import { useCaseFilters } from '@/stores/caseFilters';
import { useCaseAnalyses, ALLOCATIONS, type TraceDirection, type TraceRunParams } from '@/composables/useCaseAnalyses';
import { useToast } from '@/composables/useToast';
import { formatAmount } from '@/utils/edgeSemantics';
import { MAX_K, type PathMode, type PathParams } from '@/utils/paths';
import { formatTraceTime } from '@/utils/traceView';
import GroupsPanel from '@/components/investigation/GroupsPanel.vue';
import type { CaseItem } from '@/types/investigation';

export type CasePanel = 'filters' | 'table' | 'metrics' | 'layout' | 'advanced';
export type Popover = 'trace' | 'paths' | 'groups' | 'links' | 'enrich' | 'metrics' | 'detectors';

const props = defineProps<{
  canEdit: boolean;
  panels: Record<CasePanel, boolean>;
  paintByGroup: boolean;
  /** Re-run target: the active analysis item of this tool, if any. */
  activeItem: CaseItem | null;
}>();
const emit = defineEmits<{
  toggle: [panel: CasePanel];
  fit: [];
  settings: [];
  console: [];
  upload: [];
  activate: [item: CaseItem];
  'select-item': [item: CaseItem];
  'update:paintByGroup': [on: boolean];
}>();

const store = useInvestigationStore();
const graph = useGraphStore();
const filters = useCaseFilters();
const analyses = useCaseAnalyses();
const toast = useToast();

const open = ref<Popover | null>(null);
function toggle(p: Popover) {
  open.value = open.value === p ? null : p;
}

/** The case type's starter queries, copied into the case as query items. */
const detectors = computed(() =>
  store.items.filter((i) => i.kind === 'query' && !i.deleted_at && i.provenance?.tool === 'case_type'),
);
function openDetector(item: CaseItem) {
  open.value = null;
  emit('select-item', item);
}

const rerunTarget = (tool: string) => (props.activeItem?.provenance?.tool === tool ? props.activeItem.id : null);

async function finish(item: CaseItem | null, label: string) {
  if (!item) {
    if (analyses.error.value) toast.error(analyses.error.value);
    return;
  }
  toast.success(`${label} saved as ${item.title}`);
  emit('activate', item);
  open.value = null;
}

// --- Follow the money ----------------------------------------------------------
const seedTarget = computed<{ type: 'node' | 'edge'; id: string } | null>(() => {
  if (graph.selectedNodeIds.size === 1) return { type: 'node', id: [...graph.selectedNodeIds][0] };
  if (graph.selectedEdgeIds.size === 1) return { type: 'edge', id: [...graph.selectedEdgeIds][0] };
  return null;
});
const trace = ref<TraceRunParams | null>(null);
function resetTrace(direction: TraceDirection = 'forward') {
  trace.value = seedTarget.value ? analyses.defaultTraceParams(seedTarget.value, direction) : null;
  if (trace.value && filters.window) trace.value.window = filters.window;
}
watch([seedTarget, () => open.value === 'trace'], () => {
  if (open.value === 'trace') resetTrace(trace.value?.direction ?? 'forward');
});
const seedTotal = computed(() => analyses.traceEdges.value.filter((e) => trace.value?.seedEdgeIds.includes(e.id)).reduce((s, e) => s + e.amount, 0));
const seedTime = computed(() => {
  const ts = analyses.traceEdges.value.filter((e) => trace.value?.seedEdgeIds.includes(e.id)).map((e) => e.t);
  return ts.length ? formatTraceTime(Math.min(...ts)) : '';
});

function toLocalInput(t: number): string {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}
function setWindow(i: 0 | 1, value: string) {
  const t = Date.parse(value);
  if (Number.isNaN(t) || !trace.value?.window) return;
  const next: [number, number] = [...trace.value.window];
  next[i] = t;
  trace.value.window = next;
}
function toggleStop(type: string, on: boolean) {
  if (!trace.value) return;
  trace.value.stopTypes = on ? [...trace.value.stopTypes, type] : trace.value.stopTypes.filter((t) => t !== type);
}
async function runTrace() {
  if (!trace.value) return;
  await finish(await analyses.runTrace(trace.value, rerunTarget('trace')), 'Trace');
}

/** Context-menu / inspector entry: README defaults from a node or edge, no popover. */
async function traceFrom(target: { type: 'node' | 'edge'; id: string }, direction: TraceDirection): Promise<boolean> {
  const params = analyses.defaultTraceParams(target, direction);
  if (!params) return false;
  await finish(await analyses.runTrace(params), 'Trace');
  return true;
}

// --- Paths -------------------------------------------------------------------
const pathSource = ref<string | null>(null);
const pathTarget = ref<string | null>(null);
const picking = ref<'source' | 'target' | null>(null);
const pathMode = ref<PathMode>('shortest');
const pathWeight = ref<PathParams['weight']>('hops');
const pathK = ref(3);
const pathDirected = ref(true);
const PATH_MODES: { id: PathMode; label: string }[] = [
  { id: 'shortest', label: 'Fewest hops (BFS)' },
  { id: 'weighted', label: 'Lightest (Dijkstra)' },
  { id: 'k-shortest', label: 'k shortest (Yen)' },
  { id: 'earliest', label: 'Earliest arrival (respects time)' },
];
watch(
  () => graph.selectedNode?.node_id,
  (id) => {
    if (!id || !picking.value) return;
    if (picking.value === 'source') pathSource.value = id;
    else pathTarget.value = id;
    picking.value = null;
  },
);
function useSelection(side: 'source' | 'target') {
  const id = graph.selectedNode?.node_id;
  if (id) (side === 'source' ? pathSource : pathTarget).value = id;
  else picking.value = side;
}
async function runPaths() {
  if (!pathSource.value || !pathTarget.value) return;
  const params: PathParams = { mode: pathMode.value, directed: pathDirected.value, weight: pathWeight.value, k: Math.min(Math.max(1, pathK.value || 1), MAX_K), t0: null, maxDwellMs: null };
  await finish(await analyses.runPaths(pathSource.value, pathTarget.value, params, rerunTarget('paths')), 'Paths');
}
function startPath(sourceId: string) {
  pathSource.value = sourceId;
  pathTarget.value = null;
  picking.value = 'target';
  open.value = 'paths';
}
defineExpose({ traceFrom, startPath, show: (p: Popover) => (open.value = p), close: () => (open.value = null) });

// --- Links -------------------------------------------------------------------
const linkAttributes = computed(() => {
  const types = new Set(store.unified.nodes.map((n) => n.node_type));
  const props = new Set<string>();
  for (const n of store.unified.nodes) for (const k of Object.keys(n.properties ?? {})) props.add(k);
  const known = [...store.vocabulary.link_attributes, ...types, ...props];
  return [...new Set(known.map((a) => a))].filter((a) => types.has(a) || props.has(a) || store.vocabulary.link_attributes.includes(a));
});
const linkOn = ref<Record<string, boolean>>({});
watch(
  () => open.value === 'links',
  (on) => {
    if (on && !Object.keys(linkOn.value).length) linkOn.value = Object.fromEntries(store.vocabulary.link_attributes.map((a) => [a, true]));
  },
);
const minShared = ref(1);
const maxEntities = ref<number | null>(10);
async function runLinks() {
  const attributes = Object.entries(linkOn.value).filter(([, on]) => on).map(([a]) => a);
  if (!attributes.length) return;
  await finish(
    await analyses.runLinks({ attributes, minShared: minShared.value, maxEntities: maxEntities.value ?? undefined }, rerunTarget('links')),
    'Links',
  );
}

// --- Metrics -----------------------------------------------------------------
async function saveMetrics() {
  await finish(await analyses.saveMetricsTable(), 'Metrics');
}

const enrichmentSources = computed(() => [
  ...Object.values(store.contexts).flatMap((c) => (c.enrichment_tables ?? []).map((t) => `${c.title ?? c.id} · ${t.label ?? t.name}`)),
  ...store.items.filter((i) => i.kind === 'table' && i.mapping?.as === 'enrichment').map((i) => `case · ${i.title}`),
]);

const btn = (p: Popover) => ({ 'btn btn-outline btn-sm': true, on: open.value === p });
</script>

<template>
  <div class="analysis-bar" data-testid="analysis-bar" @keydown.esc="open = null">
    <div class="buttons">
      <button :class="btn('trace')" data-testid="analysis-trace" @click="toggle('trace')"><Banknote :size="14" /> Follow the money</button>
      <button :class="btn('paths')" data-testid="analysis-paths" @click="toggle('paths')"><Route :size="14" /> Paths</button>
      <button :class="btn('groups')" data-testid="analysis-groups" @click="toggle('groups')"><Users :size="14" /> Groups</button>
      <button :class="btn('links')" data-testid="analysis-links" @click="toggle('links')"><Link2 :size="14" /> Links</button>
      <button :class="btn('enrich')" data-testid="analysis-enrich" @click="toggle('enrich')"><GitBranch :size="14" /> Enrich</button>
      <button :class="btn('metrics')" data-testid="analysis-metrics" @click="toggle('metrics')"><Sigma :size="14" /> Metrics</button>
      <button v-if="detectors.length" :class="btn('detectors')" data-testid="analysis-detectors" @click="toggle('detectors')"><Radar :size="14" /> Detectors · {{ detectors.length }}</button>
      <button class="btn btn-outline btn-sm" data-testid="analysis-console" title="Query console of the case" @click="emit('console')"><Terminal :size="14" /> Console</button>
      <span class="sep"></span>
      <button class="btn btn-outline btn-sm" :class="{ on: panels.filters }" data-testid="workspace-filters-btn" @click="emit('toggle', 'filters')"><Filter :size="14" /> Filters</button>
      <button class="btn btn-outline btn-sm" :class="{ on: panels.table }" data-testid="workspace-table-btn" @click="emit('toggle', 'table')"><Table2 :size="14" /> Table</button>
      <button class="btn btn-outline btn-sm" :class="{ on: panels.layout }" data-testid="workspace-layout-btn" @click="emit('toggle', 'layout')"><Layers :size="14" /> Layout</button>
      <button class="btn btn-outline btn-sm" title="Fit the graph in the view" aria-label="Fit to view" data-testid="workspace-fit-btn" @click="emit('fit')"><Maximize2 :size="14" /></button>
      <button class="btn btn-outline btn-sm" :class="{ on: panels.advanced }" title="Cluster programs (JS)" data-testid="workspace-advanced-btn" @click="emit('toggle', 'advanced')"><Settings2 :size="14" /> Advanced</button>
    </div>

    <!-- Detectors: the case type's starter queries -->
    <div v-if="open === 'detectors'" class="popover" data-testid="popover-detectors">
      <p class="muted">Queries of the {{ store.caseType?.label ?? 'case' }} type, copied into the case. Open one to run it; its result is a table of the case.</p>
      <button v-for="d in detectors" :key="d.id" class="detector" :data-testid="`detector-${d.id}`" @click="openDetector(d)">
        <strong>{{ d.title }}</strong>
        <span class="muted">{{ d.subkind.toUpperCase() }}<template v-if="d.description"> · {{ d.description }}</template><template v-if="d.latest?.run"> · last run {{ d.latest.run.row_count ?? '?' }} rows</template></span>
      </button>
    </div>

    <!-- Follow the money -->
    <div v-if="open === 'trace'" class="popover" data-testid="popover-trace">
      <template v-if="!store.hasAmounts">
        <p>No edge carries an amount and a time. Set the value and time columns of the relationship types in the case settings.</p>
        <button class="btn btn-outline btn-sm" data-testid="trace-go-settings" @click="emit('settings')">Open settings ⚙</button>
      </template>
      <template v-else-if="!trace">
        <p data-testid="trace-no-seed">Select an account (its outgoing or incoming transfers are the seed) or a transfer on the canvas.</p>
      </template>
      <template v-else>
        <div class="seed" data-testid="trace-seed">
          <strong>Seed</strong> {{ trace.seedLabel }} · {{ formatAmount(seedTotal) }} · {{ seedTime }} · {{ trace.seedEdgeIds.length }} {{ trace.seedEdgeIds.length === 1 ? 'edge' : 'edges' }}
        </div>
        <div class="grid">
          <label class="field">
            <span>Direction</span>
            <span class="segmented">
              <button :class="{ on: trace.direction === 'forward' }" data-testid="trace-forward" @click="resetTrace('forward')">Forward</button>
              <button :class="{ on: trace.direction === 'backward' }" data-testid="trace-backward" @click="resetTrace('backward')">Backward</button>
            </span>
          </label>
          <label class="field"><span>Max layers</span><input v-model.number="trace.maxHops" type="number" min="1" max="20" data-testid="trace-max-hops" /></label>
          <label class="field"><span>Max dwell (h)</span><input v-model.number="trace.dwellHours" type="number" min="0" step="0.5" placeholder="no limit" data-testid="trace-dwell" /></label>
          <label class="field"><span>Min amount</span><input v-model.number="trace.minAmount" type="number" min="0" data-testid="trace-min-amount" /></label>
          <label v-if="trace.window" class="field">
            <span>Window</span>
            <input type="datetime-local" :value="toLocalInput(trace.window[0])" aria-label="Window start" @change="setWindow(0, ($event.target as HTMLInputElement).value)" />
            <input type="datetime-local" :value="toLocalInput(trace.window[1])" aria-label="Window end" @change="setWindow(1, ($event.target as HTMLInputElement).value)" />
          </label>
          <fieldset class="field">
            <legend>Allocation rule</legend>
            <label v-for="a in ALLOCATIONS[trace.direction]" :key="a.id" class="option">
              <input v-model="trace.allocation" type="radio" name="trace-allocation" :value="a.id" :data-testid="`trace-rule-${a.id}`" />
              <span><strong>{{ a.label }}</strong> · {{ a.hint }}</span>
            </label>
          </fieldset>
          <fieldset class="field">
            <legend>Stop at</legend>
            <label v-for="t in analyses.allNodeTypes.value" :key="t" class="option">
              <input type="checkbox" :checked="trace.stopTypes.includes(t)" :data-testid="`trace-stop-${t}`" @change="toggleStop(t, ($event.target as HTMLInputElement).checked)" />
              <span>{{ t }}</span>
            </label>
          </fieldset>
        </div>
        <div class="actions">
          <button class="btn btn-primary btn-sm" :disabled="!!analyses.running.value" data-testid="trace-run" @click="runTrace">
            {{ analyses.running.value === 'trace' ? 'Tracing…' : rerunTarget('trace') ? 'Trace again (new version)' : 'Trace' }}
          </button>
          <span class="muted" data-testid="trace-defaults">defaults{{ store.caseType?.analysis_defaults?.trace?.max_hops != null || store.caseType?.analysis_defaults?.trace?.max_dwell_hours != null ? ` of ${store.caseType!.label}` : '' }}: {{ analyses.traceDefaults.value.maxHops }} layers · Δ {{ analyses.traceDefaults.value.dwellHours ?? 'no limit' }}{{ analyses.traceDefaults.value.dwellHours != null ? ' h' : '' }} · min {{ analyses.traceDefaults.value.minAmount }}</span>
        </div>
      </template>
    </div>

    <!-- Paths -->
    <div v-if="open === 'paths'" class="popover" data-testid="popover-paths">
      <div class="grid">
        <div class="field">
          <span>From</span>
          <span class="pick">
            <b data-testid="path-source">{{ pathSource ? analyses.nameOf(pathSource) : '—' }}</b>
            <button class="link-btn" data-testid="path-pick-source" @click="useSelection('source')">{{ picking === 'source' ? 'click a node…' : 'use selection' }}</button>
          </span>
        </div>
        <div class="field">
          <span>To</span>
          <span class="pick">
            <b data-testid="path-target">{{ pathTarget ? analyses.nameOf(pathTarget) : '—' }}</b>
            <button class="link-btn" data-testid="path-pick-target" @click="useSelection('target')">{{ picking === 'target' ? 'click a node…' : 'use selection' }}</button>
          </span>
        </div>
        <label class="field"><span>Mode</span><select v-model="pathMode" data-testid="path-mode"><option v-for="m in PATH_MODES" :key="m.id" :value="m.id">{{ m.label }}</option></select></label>
        <label v-if="pathMode === 'weighted' || pathMode === 'k-shortest'" class="field"><span>Weight</span><select v-model="pathWeight" data-testid="path-weight"><option value="hops">1 per hop</option><option value="inverse-amount">1 / amount</option></select></label>
        <label v-if="pathMode === 'k-shortest'" class="field"><span>k</span><input v-model.number="pathK" type="number" min="1" :max="MAX_K" /></label>
        <label v-if="pathMode !== 'earliest'" class="option"><input v-model="pathDirected" type="checkbox" /> follow direction</label>
      </div>
      <p v-if="pathMode === 'earliest' && !store.hasTimes" class="muted">No timestamps on the edges: earliest arrival needs a time column (settings ⚙).</p>
      <div class="actions">
        <button class="btn btn-primary btn-sm" :disabled="!pathSource || !pathTarget || !!analyses.running.value" data-testid="path-run" @click="runPaths">Find paths</button>
      </div>
    </div>

    <!-- Groups -->
    <div v-if="open === 'groups'" class="popover wide" data-testid="popover-groups">
      <GroupsPanel :can-edit="canEdit" :paint-by-group="paintByGroup" @update:paint-by-group="emit('update:paintByGroup', $event)" />
    </div>

    <!-- Links -->
    <div v-if="open === 'links'" class="popover" data-testid="popover-links">
      <p class="muted">Link entities that share these attributes (a property or an attribute node they connect to). Too-common values (a carrier IP) are left out above the ceiling.</p>
      <div class="attrs">
        <label v-for="a in linkAttributes" :key="a" class="option"><input v-model="linkOn[a]" type="checkbox" :data-testid="`link-attr-${a}`" /> {{ a }}</label>
        <p v-if="!linkAttributes.length" class="muted">No attribute found on the canvas yet.</p>
      </div>
      <div class="grid">
        <label class="field"><span>Min shared attributes</span><input v-model.number="minShared" type="number" min="1" data-testid="link-min-shared" /></label>
        <label class="field"><span>Ignore values shared by more than</span><input v-model.number="maxEntities" type="number" min="2" placeholder="no ceiling" data-testid="link-max-entities" /></label>
      </div>
      <div class="actions">
        <button class="btn btn-primary btn-sm" :disabled="!canEdit || !!analyses.running.value" data-testid="links-run" @click="runLinks">
          {{ rerunTarget('links') ? 'Link again (new version)' : 'Link entities' }}
        </button>
      </div>
    </div>

    <!-- Enrich -->
    <div v-if="open === 'enrich'" class="popover" data-testid="popover-enrich">
      <p class="muted">Enrichment joins a table to the canvas's entities by key; the data shows in the inspector's Enrichment section of each entity.</p>
      <ul v-if="enrichmentSources.length" class="list"><li v-for="s in enrichmentSources" :key="s">{{ s }}</li></ul>
      <p v-else class="muted">No enrichment table yet.</p>
      <div class="actions">
        <button class="btn btn-outline btn-sm" :disabled="!canEdit" data-testid="enrich-upload" @click="emit('upload')">Add a file as enrichment…</button>
      </div>
    </div>

    <!-- Metrics -->
    <div v-if="open === 'metrics'" class="popover" data-testid="popover-metrics">
      <p class="muted">Compute node and edge metrics in the Metrics panel, map them to size and color, then keep them as a table of the case.</p>
      <div class="actions">
        <button class="btn btn-outline btn-sm" data-testid="metrics-open" @click="emit('toggle', 'metrics')">{{ panels.metrics ? 'Close the panel' : 'Open the Metrics panel' }}</button>
        <button class="btn btn-primary btn-sm" :disabled="!canEdit || !!analyses.running.value" data-testid="metrics-save" @click="saveMetrics">Save as a table of the case</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.analysis-bar {
  position: absolute;
  bottom: 12px;
  left: 12px;
  right: 12px;
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  pointer-events: auto;
}

.buttons .btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--color-surface);
}

.buttons .btn.on {
  border-color: var(--color-primary);
  color: var(--color-primary);
  font-weight: 600;
}

.sep {
  width: 1px;
  margin: 0 4px;
  background: var(--border-color);
}

.popover {
  order: -1;
  width: min(520px, 100%);
  max-height: 55vh;
  overflow-y: auto;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.12));
  font-size: 13px;
  pointer-events: auto;
}

.popover.wide {
  width: min(720px, 100%);
}

.popover p {
  margin: 0 0 8px;
}

.muted {
  color: var(--text-muted);
  font-size: 12px;
}

.seed {
  padding: 8px 10px;
  margin-bottom: 8px;
  border-radius: var(--radius-md);
  background: #eff6ff;
  color: #1e3a8a;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.field > span:first-child,
.field legend {
  font-weight: 600;
  padding: 0;
}

.field input,
.field select {
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  font: inherit;
}

.segmented {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: var(--radius-md);
  background: var(--color-bg-muted);
}

.segmented button {
  flex: 1;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  font: inherit;
  cursor: pointer;
}

.segmented button.on {
  background: var(--color-surface);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.option {
  display: flex;
  gap: 6px;
  align-items: center;
}

.pick {
  display: flex;
  gap: 8px;
  align-items: center;
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

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.attrs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-bottom: 8px;
}

.list {
  margin: 0 0 8px;
  padding-left: 18px;
}
.detector {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.detector + .detector {
  margin-top: 6px;
}
</style>
