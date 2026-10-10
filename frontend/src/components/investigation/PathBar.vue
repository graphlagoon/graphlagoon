<script setup lang="ts">
/**
 * "Path to…" (F3.6): after `start(source)`, the next node clicked on the canvas is the
 * target; the paths come from `workers/pathWorker.ts` and the one shown is
 * highlighted by selecting its nodes and edges.
 */
import { computed, ref, watch } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { edgeValue } from '@/utils/edgeSemantics';
import { findPaths, MAX_K, type Path, type PathMode, type PathParams } from '@/utils/paths';
import type { PathWorkerInput, PathWorkerOutput } from '@/workers/pathWorker';

const props = defineProps<{ nameOf: (id: string) => string }>();
const graphStore = useGraphStore();

const MODES: { id: PathMode; label: string }[] = [
  { id: 'shortest', label: 'Fewest hops (BFS)' },
  { id: 'weighted', label: 'Lightest (Dijkstra)' },
  { id: 'k-shortest', label: 'k shortest (Yen)' },
  { id: 'earliest', label: 'Earliest arrival' },
];

const source = ref<string | null>(null);
const target = ref<string | null>(null);
const mode = ref<PathMode>('shortest');
const weight = ref<PathParams['weight']>('hops');
const k = ref(3);
const directed = ref(true);
const paths = ref<Path[] | null>(null);
const index = ref(0);
const error = ref<string | null>(null);

const current = computed(() => paths.value?.[index.value] ?? null);

function runInWorker(input: Omit<PathWorkerInput, 'type'>): Promise<Path[]> {
  // jsdom (unit tests) has no Worker: same core, on the main thread.
  if (typeof Worker === 'undefined') return Promise.resolve(findPaths(input.edges, input.source, input.target, input.params));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('@/workers/pathWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<PathWorkerOutput>) => {
      worker.terminate();
      if (e.data.type === 'RESULT') resolve(e.data.paths);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage({ type: 'RUN', ...input } as PathWorkerInput);
  });
}

function highlight(p: Path | null) {
  graphStore.selectedNodeIds = new Set(p?.nodes ?? []);
  graphStore.selectedEdgeIds = new Set(p?.edges ?? []);
}

let token = 0;
async function run() {
  if (!source.value || !target.value) return;
  const mine = ++token;
  error.value = null;
  // shortcut: earliest arrival from any time, no dwell limit; t0 and Δ stay in the core until someone asks.
  const params: PathParams = { mode: mode.value, directed: directed.value, weight: weight.value, k: Math.min(Math.max(1, k.value || 1), MAX_K), t0: null, maxDwellMs: null };
  const edges = graphStore.filteredEdges.map((e) => ({ id: e.edge_id, src: e.src, dst: e.dst, ...edgeValue(e, null) }));
  try {
    const found = await runInWorker({ edges, source: source.value, target: target.value, params });
    if (mine !== token) return;
    paths.value = found;
    index.value = 0;
    highlight(found[0] ?? null);
  } catch (e) {
    if (mine === token) error.value = e instanceof Error ? e.message : String(e);
  }
}

function start(id: string | null) {
  token++;
  source.value = id;
  target.value = null;
  paths.value = null;
  error.value = null;
}

function close() {
  if (!source.value) return;
  start(null);
  graphStore.clearSelection();
}

function show(i: number) {
  index.value = i;
  highlight(current.value);
}

// The next node clicked (a single selection other than the source) is the target.
watch(
  () => graphStore.selectedNode?.node_id,
  (id) => {
    if (source.value && id && id !== source.value) {
      target.value = id;
      run();
    }
  },
);
watch([mode, weight, k, directed], run);

defineExpose({ start, close });
</script>

<template>
  <div v-if="source" class="path-bar" data-testid="path-bar">
    <span v-if="!target" data-testid="path-pick">Path from <b>{{ props.nameOf(source) }}</b>: click the target node</span>
    <template v-else>
      <span>
        <b>{{ props.nameOf(source) }}</b> → <b>{{ props.nameOf(target) }}</b>
      </span>
      <span v-if="error" class="error">{{ error }}</span>
      <span v-else-if="paths && !paths.length" data-testid="path-none">no path</span>
      <span v-else-if="current" data-testid="path-result">
        {{ current.nodes.map(props.nameOf).join(' → ') }} · {{ current.edges.length }} {{ current.edges.length === 1 ? 'hop' : 'hops' }}
        <template v-if="mode === 'earliest'"> · arrives {{ new Date(current.cost).toLocaleString() }}</template>
      </span>
      <span v-if="paths && paths.length > 1" class="pager">
        <button :disabled="index === 0" @click="show(index - 1)">‹</button>
        {{ index + 1 }} / {{ paths.length }}
        <button :disabled="index === paths.length - 1" @click="show(index + 1)">›</button>
      </span>
    </template>
    <select v-model="mode" data-testid="path-mode">
      <option v-for="m in MODES" :key="m.id" :value="m.id">{{ m.label }}</option>
    </select>
    <select v-if="mode === 'weighted' || mode === 'k-shortest'" v-model="weight" data-testid="path-weight">
      <option value="hops">1 per hop</option>
      <option value="inverse-amount">1 / amount</option>
    </select>
    <label v-if="mode === 'k-shortest'">k <input v-model.number="k" type="number" min="1" :max="MAX_K" /></label>
    <label v-if="mode !== 'earliest'"><input v-model="directed" type="checkbox" /> follow direction</label>
    <button data-testid="path-close" @click="close">✕</button>
  </div>
</template>

<style scoped>
.path-bar {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  max-width: calc(100% - 32px);
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--color-surface);
  font-size: 13px;
}

.path-bar input[type='number'] {
  width: 44px;
}

.path-bar button {
  border: none;
  background: none;
  cursor: pointer;
  color: inherit;
}

.error {
  color: var(--color-danger, #c0392b);
}
</style>
