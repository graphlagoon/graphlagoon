/**
 * Money trace of the open case (T5, F3.4): parameters, seed and result. Runs
 * `workers/traceWorker.ts` on the unified case graph of the investigation store.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { orientEdges, runTrace, toTraceEdges, type Allocation, type TraceEdge, type TraceParams, type TraceResult } from '@/utils/trace';
import { traceColumns, traceFlows } from '@/utils/traceView';
import type { TraceWorkerInput, TraceWorkerOutput } from '@/workers/traceWorker';

export type TraceDirection = TraceParams['direction'];

const HOUR = 3_600_000;
/** README Q4 defaults. */
export const TRACE_DEFAULTS = { maxHops: 3, dwellHours: 24, minAmount: 50 };
/** Node types checked as stops by default: cash-out, crypto, betting and out-of-case banks. */
const DEFAULT_STOP_TYPE = /saque|withdraw|atm|cash|exchange|cripto|crypto|aposta|bet|externo|external/i;

export const ALLOCATIONS: Record<TraceDirection, { id: Allocation; label: string; hint: string }[]> = {
  forward: [
    { id: 'fifo', label: 'FIFO', hint: 'first in, first out' },
    { id: 'proportional', label: 'Proportional', hint: 'splits by the balance mix' },
    { id: 'libr', label: 'LIBR', hint: 'lowest intermediate balance' },
    { id: 'total', label: 'Total contamination', hint: 'upper bound' },
  ],
  // FIFO and LIBR lose their meaning on reversed edges (utils/trace.ts traceBackward).
  backward: [
    { id: 'lifo', label: 'LIFO', hint: 'last in, first out' },
    { id: 'proportional', label: 'Proportional', hint: 'splits by the balance mix' },
    { id: 'total', label: 'Total contamination', hint: 'upper bound' },
  ],
};

function runInWorker(input: Omit<TraceWorkerInput, 'type'>): Promise<TraceResult> {
  // jsdom (unit tests) has no Worker: same core, on the main thread.
  if (typeof Worker === 'undefined') return Promise.resolve(runTrace(input.edges, input.nodeTypes, input.seed, input.params));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('@/workers/traceWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<TraceWorkerOutput>) => {
      worker.terminate();
      if (e.data.type === 'RESULT') resolve(e.data.result);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage({ type: 'RUN', ...input } as TraceWorkerInput);
  });
}

export const useTraceStore = defineStore('trace', () => {
  const investigation = useInvestigationStore();

  const seedEdgeIds = ref<string[]>([]);
  /** What the seed is, for the seed box ("edge …" or "outgoing edges of …"). */
  const seedLabel = ref('');
  const direction = ref<TraceDirection>('forward');
  const maxHops = ref(TRACE_DEFAULTS.maxHops);
  /** Δ in hours; null or 0 = no limit. */
  const dwellHours = ref<number | null>(TRACE_DEFAULTS.dwellHours);
  const minAmount = ref(TRACE_DEFAULTS.minAmount);
  const timeWindow = ref<[number, number] | null>(null);
  const allocation = ref<Allocation>('fifo');
  const stopTypes = ref<string[]>([]);

  const result = ref<TraceResult | null>(null);
  /** Same run under the proportional rule, for "proportional would give" on the exits. */
  const proportional = ref<TraceResult | null>(null);
  /** The edges the last run walked (reversed for a backward trace). */
  const walked = ref<TraceEdge[]>([]);
  const running = ref(false);
  const error = ref<string | null>(null);
  const view = ref<'layers' | 'sankey'>('layers');

  const edges = computed(() => toTraceEdges(investigation.unified.edges, null));
  const nodeTypes = computed<Record<string, string>>(() =>
    Object.fromEntries(investigation.unified.nodes.map((n) => [n.node_id, n.node_type])),
  );
  const names = computed(
    () => new Map(investigation.unified.nodes.map((n) => [n.node_id, String(n.properties?.nome ?? n.properties?.name ?? n.node_id.split('@')[0])])),
  );
  const nameOf = (id: string) => names.value.get(id) ?? id.split('@')[0];
  const allNodeTypes = computed(() => [...new Set(Object.values(nodeTypes.value))].sort());
  const flows = computed(() => (result.value ? traceFlows(result.value, walked.value) : []));
  const columns = computed(() => (result.value ? traceColumns(result.value, flows.value, result.value.method.direction) : null));

  function defaultWindow(): [number, number] | null {
    const seedTimes = edges.value.filter((e) => seedEdgeIds.value.includes(e.id)).map((e) => e.t);
    if (!seedTimes.length) return null;
    const span = (dwellHours.value || TRACE_DEFAULTS.dwellHours) * HOUR;
    return direction.value === 'forward'
      ? [Math.min(...seedTimes), Math.max(...seedTimes) + span]
      : [Math.min(...seedTimes) - span, Math.max(...seedTimes)];
  }

  function setDirection(d: TraceDirection) {
    direction.value = d;
    allocation.value = ALLOCATIONS[d][0].id;
    timeWindow.value = defaultWindow();
  }

  /**
   * Starts a trace from an edge, or from a node's outgoing (forward) or incoming
   * (backward) edges that carry an amount and a time. Returns false when there is none.
   */
  async function start(target: { type: 'node' | 'edge'; id: string }, d: TraceDirection): Promise<boolean> {
    const seeds =
      target.type === 'edge'
        ? edges.value.filter((e) => e.id === target.id)
        : edges.value.filter((e) => (d === 'forward' ? e.src : e.dst) === target.id);
    if (!seeds.length) return false;
    seedEdgeIds.value = seeds.map((e) => e.id);
    seedLabel.value =
      target.type === 'edge'
        ? `${nameOf(seeds[0].src)} → ${nameOf(seeds[0].dst)}`
        : `${d === 'forward' ? 'outgoing' : 'incoming'} edges of ${nameOf(target.id)}`;
    maxHops.value = TRACE_DEFAULTS.maxHops;
    dwellHours.value = TRACE_DEFAULTS.dwellHours;
    minAmount.value = TRACE_DEFAULTS.minAmount;
    stopTypes.value = allNodeTypes.value.filter((t) => DEFAULT_STOP_TYPE.test(t));
    view.value = 'layers';
    setDirection(d);
    await run();
    return true;
  }

  let token = 0;
  async function run() {
    if (!seedEdgeIds.value.length) return;
    const params: TraceParams = {
      direction: direction.value,
      maxHops: maxHops.value,
      maxDwellMs: dwellHours.value ? dwellHours.value * HOUR : null,
      minAmount: minAmount.value || 0,
      // Plain copies: a reactive proxy cannot be posted to the worker.
      window: timeWindow.value ? [timeWindow.value[0], timeWindow.value[1]] : null,
      allocation: allocation.value,
      stopTypes: [...stopTypes.value],
      stopNodes: [],
    };
    const input = { edges: edges.value, nodeTypes: nodeTypes.value, seed: { edgeIds: [...seedEdgeIds.value] } };
    const my = ++token;
    running.value = true;
    error.value = null;
    try {
      const [main, prop] = await Promise.all([
        runInWorker({ ...input, params }),
        params.allocation === 'proportional' || params.allocation === 'total'
          ? Promise.resolve(null)
          : runInWorker({ ...input, params: { ...params, allocation: 'proportional' } }),
      ]);
      if (my !== token) return;
      walked.value = orientEdges(input.edges, params.direction);
      result.value = main;
      proportional.value = prop;
    } catch (e) {
      if (my === token) error.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (my === token) running.value = false;
    }
  }

  function reset() {
    token++;
    seedEdgeIds.value = [];
    result.value = null;
    proportional.value = null;
    walked.value = [];
    running.value = false;
    error.value = null;
  }

  return {
    seedEdgeIds,
    seedLabel,
    direction,
    maxHops,
    dwellHours,
    minAmount,
    timeWindow,
    allocation,
    stopTypes,
    result,
    proportional,
    walked,
    running,
    error,
    view,
    edges,
    allNodeTypes,
    nameOf,
    flows,
    columns,
    setDirection,
    start,
    run,
    reset,
  };
});
