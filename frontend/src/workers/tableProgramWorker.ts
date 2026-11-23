/**
 * Table Program Worker — sandboxed evaluation of a `show-table` action's
 * program. Same shell as clusterProgramWorker.ts: capture our own
 * `postMessage`, strip network / storage / nested-worker / messaging globals
 * before any user code runs, serve one RUN. The main thread
 * (services/sandboxRunner.ts) enforces the timeout with `terminate()`.
 */
import { hardenScope } from './customMetricSandbox';
import { evaluateTableProgram, type TableProgramSnapshot } from './tableProgramEvaluate';

type Message =
  | { type: 'READY' }
  | { type: 'RESULT'; runId: string; result: unknown }
  | { type: 'ERROR'; runId: string; error: string };

const post: (msg: Message) => void = self.postMessage.bind(self);

const g = globalThis as unknown as Record<string, { prototype?: object } | undefined>;
const protos: object[] = [];
for (const name of ['DedicatedWorkerGlobalScope', 'WorkerGlobalScope']) {
  const ctor = g[name];
  if (ctor?.prototype) protos.push(ctor.prototype);
}
const unstripped = hardenScope(self, protos);
if (unstripped.length > 0) {
  console.warn('[tableProgramWorker] could not strip globals:', unstripped);
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

self.addEventListener('message', (event: MessageEvent<{ type: string; runId: string; code: string; snapshot: TableProgramSnapshot }>) => {
  const cmd = event.data;
  if (!cmd || typeof cmd !== 'object' || cmd.type !== 'RUN') return;
  let result: unknown;
  try {
    result = evaluateTableProgram(cmd.code, cmd.snapshot);
  } catch (e) {
    post({ type: 'ERROR', runId: cmd.runId, error: describe(e) });
    return;
  }
  try {
    post({ type: 'RESULT', runId: cmd.runId, result });
  } catch (e) {
    post({ type: 'ERROR', runId: cmd.runId, error: `The program's result cannot be transferred: ${describe(e)}` });
  }
});

post({ type: 'READY' });
