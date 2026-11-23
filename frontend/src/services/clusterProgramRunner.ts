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
import type { ClusterProgramSnapshot } from '@/types/cluster';
import { runInSandboxWorker } from './sandboxRunner';
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

/**
 * Run `code` over `snapshot` in a sandboxed worker. The timeout covers the
 * whole run (worker boot, clone and evaluation).
 */
export function runClusterProgramInWorker(
  code: string,
  snapshot: ClusterProgramSnapshot,
  timeoutMs: number = CLUSTER_PROGRAM_TIMEOUT_MS,
): Promise<ClusterProgramRunOutcome> {
  return runInSandboxWorker(workerFactory, { code, snapshot }, timeoutMs).outcome.then((o) =>
    o.ok ? o : { ok: false, error: o.error },
  );
}
