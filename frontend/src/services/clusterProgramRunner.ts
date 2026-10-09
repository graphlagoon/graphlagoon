/**
 * Cluster Program Runner — main-thread side of the cluster-program sandbox
 * (tech debt #32).
 *
 * Each run spawns a dedicated, non-pooled `clusterProgramWorker`, sends it the
 * program code plus a structured-clone-safe snapshot, and enforces a hard
 * timeout with `worker.terminate()`. The worker is always terminated once the
 * run settles, so user code cannot keep running in the background.
 *
 * Never rejects: compile errors, runtime errors, crashes and timeouts all come
 * back as `{ ok: false, error }`.
 */
import type {
  ClusterProgramSnapshot,
  ClusterProgramWorkerCommand,
  ClusterProgramWorkerMessage,
} from '@/types/cluster';
import { CLUSTER_PROGRAM_TIMEOUT_MS } from '@/types/cluster';

export type ClusterProgramRunOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

const defaultFactory = (): Worker =>
  new Worker(new URL('../workers/clusterProgramWorker.ts', import.meta.url), { type: 'module' });

/** Vite worker import — swapped by tests through `setClusterProgramWorkerFactory`. */
let workerFactory: () => Worker = defaultFactory;

/** Test seam: replace how workers are created. Returns the previous factory. */
export function setClusterProgramWorkerFactory(factory: (() => Worker) | null): () => Worker {
  const prev = workerFactory;
  workerFactory = factory ?? defaultFactory;
  return prev;
}

let runCounter = 0;
const nextRunId = () => `cp-run-${++runCounter}-${Date.now()}`;

/**
 * Run `code` over `snapshot` in a sandboxed worker. The timeout covers the
 * whole run (worker boot, clone and evaluation).
 */
export function runClusterProgramInWorker(
  code: string,
  snapshot: ClusterProgramSnapshot,
  timeoutMs: number = CLUSTER_PROGRAM_TIMEOUT_MS,
): Promise<ClusterProgramRunOutcome> {
  return new Promise((resolve) => {
    const runId = nextRunId();
    let settled = false;
    let worker: Worker | null = null;

    const finish = (outcome: ClusterProgramRunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker?.terminate();
      resolve(outcome);
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: `Timed out after ${Math.round(timeoutMs / 1000)}s` }),
      timeoutMs,
    );

    let w: Worker;
    try {
      w = workerFactory();
      worker = w;
    } catch (e) {
      finish({ ok: false, error: `Could not start the program worker: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }

    w.onerror = (ev) =>
      finish({ ok: false, error: `Worker error: ${(ev as ErrorEvent).message ?? 'unknown'}` });

    w.onmessage = (ev: MessageEvent<ClusterProgramWorkerMessage>) => {
      const msg = ev.data;
      if (!msg || typeof msg !== 'object' || settled) return;
      if (msg.type === 'READY') {
        const cmd: ClusterProgramWorkerCommand = { type: 'RUN', runId, code, snapshot };
        try {
          w.postMessage(cmd);
        } catch (e) {
          finish({ ok: false, error: `Could not send the graph to the program worker: ${e instanceof Error ? e.message : String(e)}` });
        }
        return;
      }
      if (msg.type === 'RESULT' && msg.runId === runId) {
        finish({ ok: true, result: msg.result });
      } else if (msg.type === 'ERROR' && msg.runId === runId) {
        finish({ ok: false, error: String(msg.error) });
      }
      // anything else (stale / forged / unknown) is ignored
    };
  });
}
