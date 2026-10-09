/**
 * Cluster Program Worker — sandboxed evaluation of user-authored cluster
 * programs (tech debt #32).
 *
 * Same shell as customMetricWorker.ts:
 *   1. capture our own `postMessage` binding,
 *   2. strip network / storage / nested-worker / messaging globals
 *      (workers/customMetricSandbox.ts) BEFORE any user code can run,
 *   3. serve one RUN command per worker.
 *
 * The main thread (services/clusterProgramRunner.ts) enforces the timeout by
 * calling `worker.terminate()` and re-validates the returned clusters.
 */
import type {
  ClusterProgramWorkerCommand,
  ClusterProgramWorkerMessage,
} from '@/types/cluster';
import { hardenScope } from './customMetricSandbox';
import { evaluateClusterProgram } from './clusterProgramEvaluate';

// 1. Capture before stripping — user code can never reach this binding.
const post: (msg: ClusterProgramWorkerMessage) => void = self.postMessage.bind(self);

// 2. Harden.
const g = globalThis as unknown as Record<string, { prototype?: object } | undefined>;
const protos: object[] = [];
for (const name of ['DedicatedWorkerGlobalScope', 'WorkerGlobalScope']) {
  const ctor = g[name];
  if (ctor?.prototype) protos.push(ctor.prototype);
}
const unstripped = hardenScope(self, protos);
if (unstripped.length > 0) {
  console.warn('[clusterProgramWorker] could not strip globals:', unstripped);
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

// 3. Serve. addEventListener so user code cannot detach the handler.
self.addEventListener('message', (event: MessageEvent<ClusterProgramWorkerCommand>) => {
  const cmd = event.data;
  if (!cmd || typeof cmd !== 'object' || cmd.type !== 'RUN') return;

  let result: unknown;
  try {
    result = evaluateClusterProgram(cmd.code, cmd.snapshot);
  } catch (e) {
    post({ type: 'ERROR', runId: cmd.runId, error: describe(e) });
    return;
  }
  try {
    post({ type: 'RESULT', runId: cmd.runId, result });
  } catch (e) {
    // e.g. DataCloneError: the program returned functions or other
    // non-cloneable values.
    post({ type: 'ERROR', runId: cmd.runId, error: `Program result cannot be transferred: ${describe(e)}` });
  }
});

post({ type: 'READY' });
