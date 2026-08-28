/**
 * Custom Metric Worker — sandboxed evaluation of writer-authored JavaScript.
 *
 * Thin shell around workers/customMetricEvaluate.ts:
 *   1. capture our own `postMessage` binding,
 *   2. strip network / storage / nested-worker / messaging globals
 *      (workers/customMetricSandbox.ts) BEFORE any user code can run,
 *   3. serve RUN / TEST commands.
 *
 * The main thread (services/customMetricRunner.ts) enforces the timeout by
 * calling `worker.terminate()` — nothing here needs to cooperate.
 *
 * Not part of the pooled metrics workers on purpose: terminating this one
 * must never disturb an algorithm computation in flight.
 */
import type {
  CustomMetricWorkerCommand,
  CustomMetricWorkerMessage,
} from '@/types/customMetrics';
import { hardenScope } from './customMetricSandbox';
import { buildIndexes, evaluateDefinition } from './customMetricEvaluate';

// 1. Capture before stripping — user code can never reach this binding.
const post: (msg: CustomMetricWorkerMessage) => void = self.postMessage.bind(self);

// 2. Harden. The prototypes are listed explicitly (hardenScope also walks
//    the chain) so a host that exposes a global only on the scope object
//    itself is covered too.
const g = globalThis as unknown as Record<string, { prototype?: object } | undefined>;
const protos: object[] = [];
for (const name of ['DedicatedWorkerGlobalScope', 'WorkerGlobalScope']) {
  const ctor = g[name];
  if (ctor?.prototype) protos.push(ctor.prototype);
}
const unstripped = hardenScope(self, protos);
if (unstripped.length > 0) {
  // Surfaced through the console only: the runner still enforces the timeout
  // and re-validates every value, and the definitions only ever run for
  // writers of the context.
  console.warn('[customMetricWorker] could not strip globals:', unstripped);
}

// 3. Serve. addEventListener (not `self.onmessage`) so user code assigning
//    `self.onmessage = null` cannot detach the handler.
self.addEventListener('message', (event: MessageEvent<CustomMetricWorkerCommand>) => {
  const cmd = event.data;
  if (!cmd || typeof cmd !== 'object') return;

  if (cmd.type === 'RUN') {
    const ix = buildIndexes(cmd.snapshot);
    for (const def of cmd.definitions) {
      post({ type: 'DEFINITION_STARTED', runId: cmd.runId, definitionId: def.id });
      try {
        const result = evaluateDefinition(def, ix, {
          onProgress: (done, total) =>
            post({ type: 'PROGRESS', runId: cmd.runId, definitionId: def.id, done, total }),
        });
        post({
          type: 'DEFINITION_RESULT',
          runId: cmd.runId,
          definitionId: def.id,
          values: result.values,
          errorCount: result.errorCount,
          firstItemError: result.firstItemError,
          elapsedMs: result.elapsedMs,
        });
      } catch (e) {
        // Compile failure (SyntaxError) — the other definitions still run.
        post({
          type: 'DEFINITION_ERROR',
          runId: cmd.runId,
          definitionId: def.id,
          error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        });
      }
    }
    post({ type: 'RUN_COMPLETE', runId: cmd.runId });
    return;
  }

  if (cmd.type === 'TEST') {
    const ix = buildIndexes(cmd.snapshot);
    const def = cmd.definition;
    try {
      const result = evaluateDefinition(def, ix, { limit: cmd.sampleSize, collectSamples: true });
      post({
        type: 'TEST_RESULT',
        runId: cmd.runId,
        definitionId: def.id,
        result: {
          samples: result.samples ?? [],
          errorCount: result.errorCount,
          firstItemError: result.firstItemError,
          elapsedMs: result.elapsedMs,
        },
      });
    } catch (e) {
      post({
        type: 'TEST_RESULT',
        runId: cmd.runId,
        definitionId: def.id,
        result: {
          samples: [],
          errorCount: 0,
          error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
          elapsedMs: 0,
        },
      });
    }
  }
});

post({ type: 'READY' });
