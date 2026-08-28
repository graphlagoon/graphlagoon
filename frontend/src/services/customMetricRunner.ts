/**
 * Custom Metric Runner — main-thread side of the sandbox.
 *
 * Spawns a dedicated, non-pooled `customMetricWorker`, feeds it one snapshot
 * of the graph plus the definitions to evaluate, and enforces the timeout:
 * a definition that does not finish within `timeoutMs` gets its worker
 * `terminate()`d, is reported as an error, and the remaining definitions are
 * re-run on a fresh worker (the same snapshot object is re-cloned — a second
 * structured clone only on the failure path).
 *
 * Structured-clone cost: a 200k-node snapshot with wide properties is tens
 * of MB and is cloned ONCE per recompute cycle (not per definition); the
 * store debounces and coalesces recomputes. `toRaw` strips the Vue proxies so
 * the clone does not pay the get-trap tax (same lesson as DataTablePanel).
 */
import { toRaw } from 'vue';
import type {
  CustomMetricDefinition,
  CustomMetricRunnable,
  CustomMetricSnapshot,
  CustomMetricTestResult,
  CustomMetricWorkerCommand,
  CustomMetricWorkerMessage,
} from '@/types/customMetrics';
import {
  CUSTOM_ALGORITHM_ID,
  CUSTOM_METRIC_TEST_SAMPLE_SIZE,
  CUSTOM_METRIC_TIMEOUT_MS,
  customMetricId,
  isCustomMetricId,
} from '@/types/customMetrics';
import type { ComputedMetric, MetricValue } from '@/types/metrics';
import { calculateStats, numericValues } from '@/types/metrics';
import { sanitizeValues } from '@/utils/customMetricValue';
import { useGraphStore } from '@/stores/graph';
import { useMetricsStore } from '@/stores/metrics';
import { useCommunityStore } from '@/stores/community';

// ============================================================================
// Snapshot
// ============================================================================

/**
 * Serialize the current filtered graph (the same population the algorithm
 * metrics use) together with degrees, built-in + algorithm metric values,
 * and community membership. Custom metrics are never included: a definition
 * cannot depend on another custom metric (no ordering, no cycles).
 */
export function serializeGraphForCustomMetrics(): CustomMetricSnapshot {
  const graphStore = useGraphStore();
  const metricsStore = useMetricsStore();
  const communityStore = useCommunityStore();

  const nodes = graphStore.filteredNodes.map((n) => {
    const raw = toRaw(n);
    return { id: raw.node_id, type: raw.node_type, properties: toRaw(raw.properties) ?? {} };
  });
  const edges = graphStore.filteredEdges.map((e) => {
    const raw = toRaw(e);
    return {
      id: raw.edge_id,
      relationship_type: raw.relationship_type,
      src: raw.src,
      dst: raw.dst,
      properties: toRaw(raw.properties) ?? {},
    };
  });

  const metrics: Record<string, [string, MetricValue][]> = {};
  const metricIdToName: Record<string, string> = {};
  const metricsByAlgorithm: Record<string, string> = {};
  const all = [...metricsStore.nodeMetrics, ...metricsStore.edgeMetrics];
  // Latest run per algorithm wins: iterate in insertion order and overwrite.
  const latestByAlgorithm = new Map<string, ComputedMetric>();
  for (const m of all) {
    if (isCustomMetricId(m.id)) continue;
    if (!(m.name in metrics)) metrics[m.name] = Array.from(m.values.entries());
    metricIdToName[m.id] = m.name;
    const prev = latestByAlgorithm.get(m.algorithmId);
    if (!prev || m.computedAt >= prev.computedAt) latestByAlgorithm.set(m.algorithmId, m);
  }
  for (const [algorithmId, m] of latestByAlgorithm) metricsByAlgorithm[algorithmId] = m.name;
  // The built-in degree is also reachable as `degree`.
  if (metricsByAlgorithm['__builtin'] && !metricsByAlgorithm['degree']) {
    metricsByAlgorithm['degree'] = metricsByAlgorithm['__builtin'];
  }

  const n = nodes.length;
  const e = edges.length;
  return {
    nodes,
    edges,
    degrees: Array.from(graphStore.nodeDegrees.entries()),
    metrics,
    metricIdToName,
    metricsByAlgorithm,
    communities: Array.from(communityStore.communityMap.entries()),
    summary: {
      nodeCount: n,
      edgeCount: e,
      meanDegree: n > 0 ? (2 * e) / n : 0,
      density: n > 1 ? e / (n * (n - 1)) : 0,
    },
  };
}

// ============================================================================
// Worker lifecycle
// ============================================================================

/** Vite worker import — swapped by tests through `setWorkerFactory`. */
let workerFactory: () => Worker = () =>
  new Worker(new URL('../workers/customMetricWorker.ts', import.meta.url), { type: 'module' });

/** Test seam: replace how workers are created. Returns the previous factory. */
export function setWorkerFactory(factory: (() => Worker) | null): () => Worker {
  const prev = workerFactory;
  workerFactory = factory ?? (() =>
    new Worker(new URL('../workers/customMetricWorker.ts', import.meta.url), { type: 'module' }));
  return prev;
}

let runCounter = 0;
const nextRunId = () => `cm-run-${++runCounter}-${Date.now()}`;

function toRunnable(def: CustomMetricDefinition | CustomMetricRunnable): CustomMetricRunnable {
  return { id: def.id, target: def.target, value_type: def.value_type, code: def.code };
}

/** Turn a worker result into a store-ready ComputedMetric. */
export function buildComputedMetric(
  def: CustomMetricDefinition,
  values: unknown,
  elapsedMs: number,
  errorCount: number,
): ComputedMetric {
  const clean = sanitizeValues(values, def.value_type);
  const metric: ComputedMetric = {
    id: customMetricId(def.id),
    name: def.name,
    algorithmId: CUSTOM_ALGORITHM_ID,
    target: def.target,
    valueType: def.value_type,
    values: new Map(clean),
    min: 0,
    max: 0,
    mean: 0,
    stdDev: 0,
    computedAt: Date.now(),
    params: {},
    edgeTypeFilter: [],
    elapsedMs,
    definitionId: def.id,
    errorCount,
  };
  if (def.value_type === 'number') {
    const stats = calculateStats(numericValues(metric));
    metric.min = stats.min;
    metric.max = stats.max;
    metric.mean = stats.mean;
    metric.stdDev = stats.stdDev;
  }
  return metric;
}

export interface RunCallbacks {
  onStarted?(definitionId: string): void;
  onProgress?(definitionId: string, done: number, total: number): void;
  onResult(definitionId: string, metric: ComputedMetric): void;
  onError(definitionId: string, message: string): void;
}

export interface RunHandle {
  cancel(): void;
  done: Promise<void>;
}

export interface RunOptions {
  timeoutMs?: number;
}

/**
 * Evaluate `definitions` over `snapshot` in a sandboxed worker.
 * Resolves when every definition has produced a result or an error (never
 * rejects on user-code failures; rejects only when cancelled).
 */
export function runDefinitions(
  definitions: CustomMetricDefinition[],
  snapshot: CustomMetricSnapshot,
  callbacks: RunCallbacks,
  options: RunOptions = {},
): RunHandle {
  const timeoutMs = options.timeoutMs ?? CUSTOM_METRIC_TIMEOUT_MS;
  const byId = new Map(definitions.map((d) => [d.id, d]));
  let remaining = definitions.map((d) => d.id);
  let worker: Worker | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  let finished = false;
  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimer();
    worker?.terminate();
    worker = null;
    resolveDone();
  };

  const settle = (id: string) => {
    remaining = remaining.filter((r) => r !== id);
  };

  /** Spawn a worker for the ids still pending. */
  const spawn = () => {
    if (cancelled || finished) return;
    if (remaining.length === 0) {
      finish();
      return;
    }
    const runId = nextRunId();
    const w = workerFactory();
    worker = w;
    let currentId: string | null = null;

    const onTimeout = () => {
      if (worker !== w) return;
      const id = currentId ?? remaining[0];
      w.terminate();
      worker = null;
      clearTimer();
      if (id) {
        settle(id);
        callbacks.onError(id, `Timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      spawn(); // fresh worker for whatever is left
    };

    w.onerror = (ev) => {
      if (worker !== w) return;
      const id = currentId ?? remaining[0];
      w.terminate();
      worker = null;
      clearTimer();
      if (id) {
        settle(id);
        callbacks.onError(id, `Worker error: ${(ev as ErrorEvent).message ?? 'unknown'}`);
      }
      spawn();
    };

    w.onmessage = (ev: MessageEvent<CustomMetricWorkerMessage>) => {
      if (worker !== w) return;
      const msg = ev.data;
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'READY': {
          const cmd: CustomMetricWorkerCommand = {
            type: 'RUN',
            runId,
            definitions: remaining.map((id) => toRunnable(byId.get(id)!)),
            snapshot,
          };
          w.postMessage(cmd);
          return;
        }
        case 'DEFINITION_STARTED':
          if (msg.runId !== runId) return;
          currentId = msg.definitionId;
          callbacks.onStarted?.(msg.definitionId);
          clearTimer();
          timer = setTimeout(onTimeout, timeoutMs);
          return;
        case 'PROGRESS':
          if (msg.runId !== runId) return;
          callbacks.onProgress?.(msg.definitionId, msg.done, msg.total);
          return;
        case 'DEFINITION_RESULT': {
          if (msg.runId !== runId) return;
          clearTimer();
          const def = byId.get(msg.definitionId);
          if (def && remaining.includes(def.id)) {
            settle(def.id);
            callbacks.onResult(def.id, buildComputedMetric(def, msg.values, msg.elapsedMs, msg.errorCount));
          }
          currentId = null;
          return;
        }
        case 'DEFINITION_ERROR':
          if (msg.runId !== runId) return;
          clearTimer();
          if (remaining.includes(msg.definitionId)) {
            settle(msg.definitionId);
            callbacks.onError(msg.definitionId, String(msg.error));
          }
          currentId = null;
          return;
        case 'RUN_COMPLETE':
          if (msg.runId !== runId) return;
          // Anything the worker skipped without a message is an error.
          for (const id of remaining.slice()) {
            settle(id);
            callbacks.onError(id, 'Worker finished without a result');
          }
          finish();
          return;
        default:
          return; // forged / unknown messages are ignored
      }
    };
  };

  spawn();

  return {
    cancel() {
      if (finished) return;
      cancelled = true;
      finished = true;
      clearTimer();
      worker?.terminate();
      worker = null;
      rejectDone(new Error('cancelled'));
    },
    done,
  };
}

/**
 * Evaluate one definition over the first `sampleSize` items (Test button).
 * Never throws: compile errors and timeouts land in `result.error`.
 */
export function testDefinition(
  definition: CustomMetricDefinition | CustomMetricRunnable,
  snapshot: CustomMetricSnapshot,
  sampleSize = CUSTOM_METRIC_TEST_SAMPLE_SIZE,
  timeoutMs = CUSTOM_METRIC_TIMEOUT_MS,
): Promise<CustomMetricTestResult> {
  return new Promise((resolve) => {
    const runId = nextRunId();
    const w = workerFactory();
    let settled = false;
    const finish = (result: CustomMetricTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.terminate();
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish({
          samples: [],
          errorCount: 0,
          error: `Timed out after ${Math.round(timeoutMs / 1000)}s`,
          elapsedMs: timeoutMs,
        }),
      timeoutMs,
    );
    w.onerror = (ev) =>
      finish({
        samples: [],
        errorCount: 0,
        error: `Worker error: ${(ev as ErrorEvent).message ?? 'unknown'}`,
        elapsedMs: 0,
      });
    w.onmessage = (ev: MessageEvent<CustomMetricWorkerMessage>) => {
      const msg = ev.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'READY') {
        const cmd: CustomMetricWorkerCommand = {
          type: 'TEST',
          runId,
          definition: toRunnable(definition),
          snapshot,
          sampleSize,
        };
        w.postMessage(cmd);
      } else if (msg.type === 'TEST_RESULT' && msg.runId === runId) {
        const r = msg.result;
        finish({
          samples: sanitizeValues(
            (r.samples ?? []).map((s) => [s.id, s.value]),
            definition.value_type,
          ).map(([id, value], i) => ({ id, value, rawType: String(r.samples[i]?.rawType ?? 'undefined') })),
          errorCount: r.errorCount,
          firstItemError: r.firstItemError,
          error: r.error,
          elapsedMs: r.elapsedMs,
        });
      }
    };
  });
}
