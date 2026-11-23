/**
 * Runs user code in a dedicated, sandboxed worker and always terminates it.
 *
 * The protocol every sandbox worker speaks (clusterProgramWorker,
 * tableProgramWorker): the worker posts READY once its scope is hardened, the
 * runner sends `{ type: 'RUN', runId, ...payload }`, and the worker answers
 * RESULT or ERROR with that runId. The timeout covers the whole run (worker
 * boot, clone and evaluation) and is enforced with `worker.terminate()`, so
 * user code cannot keep running in the background. `cancel()` does the same.
 *
 * Never rejects: compile errors, runtime errors, crashes, timeouts and cancels
 * all come back as `{ ok: false, error }`.
 */
export type SandboxRunOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string; canceled?: boolean };

type WorkerMessage =
  | { type: 'READY' }
  | { type: 'RESULT'; runId: string; result: unknown }
  | { type: 'ERROR'; runId: string; error: string };

export interface SandboxRun {
  outcome: Promise<SandboxRunOutcome>;
  /** Stop the worker now: the outcome settles as canceled. */
  cancel: () => void;
}

let runCounter = 0;

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function runInSandboxWorker(
  factory: () => Worker,
  payload: Record<string, unknown>,
  timeoutMs: number,
  what = 'program',
): SandboxRun {
  const runId = `sbx-${++runCounter}-${Date.now()}`;
  let settled = false;
  let worker: Worker | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveOutcome!: (o: SandboxRunOutcome) => void;
  const outcome = new Promise<SandboxRunOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  const finish = (o: SandboxRunOutcome) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    worker?.terminate();
    resolveOutcome(o);
  };

  timer = setTimeout(() => finish({ ok: false, error: `Timed out after ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);

  try {
    worker = factory();
  } catch (e) {
    finish({ ok: false, error: `Could not start the ${what} worker: ${describe(e)}` });
    return { outcome, cancel: () => {} };
  }
  const w = worker;
  w.onerror = (ev) => finish({ ok: false, error: `Worker error: ${(ev as ErrorEvent).message ?? 'unknown'}` });
  w.onmessage = (ev: MessageEvent<WorkerMessage>) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object' || settled) return;
    if (msg.type === 'READY') {
      try {
        w.postMessage({ ...payload, type: 'RUN', runId });
      } catch (e) {
        finish({ ok: false, error: `Could not send the graph to the ${what} worker: ${describe(e)}` });
      }
      return;
    }
    if (msg.type === 'RESULT' && msg.runId === runId) finish({ ok: true, result: msg.result });
    else if (msg.type === 'ERROR' && msg.runId === runId) finish({ ok: false, error: String(msg.error) });
    // anything else (stale / forged / unknown) is ignored
  };

  return { outcome, cancel: () => finish({ ok: false, error: 'Canceled', canceled: true }) };
}
