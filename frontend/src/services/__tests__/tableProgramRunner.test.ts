import { describe, it, expect, afterEach, vi } from 'vitest';
import { runTableProgram, setTableProgramWorkerFactory } from '../tableProgramRunner';
import type { TableProgramSnapshot } from '@/workers/tableProgramEvaluate';

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminated = false;
  sent: unknown[] = [];
  constructor() {
    FakeWorker.last = this;
    queueMicrotask(() => this.onmessage?.({ data: { type: 'READY' } } as MessageEvent));
  }
  postMessage(msg: unknown) {
    this.sent.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  answer(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const snapshot = { nodes: [], edges: [], item: { type: 'node', node_id: 'a', node_type: 'T' }, params: {}, selectedNodeIds: [], metrics: [] } as TableProgramSnapshot;

afterEach(() => {
  setTableProgramWorkerFactory(null);
  vi.useRealTimers();
});

describe('runTableProgram', () => {
  it('sends the code once the worker is ready and terminates it on the result', async () => {
    setTableProgramWorkerFactory(() => new FakeWorker() as unknown as Worker);
    const run = runTableProgram('return []', snapshot);
    await Promise.resolve();
    const w = FakeWorker.last!;
    const cmd = w.sent[0] as { type: string; runId: string; code: string };
    expect(cmd).toMatchObject({ type: 'RUN', code: 'return []' });
    w.answer({ type: 'RESULT', runId: 'forged', result: [1] }); // ignored
    w.answer({ type: 'RESULT', runId: cmd.runId, result: [] });
    expect(await run.outcome).toEqual({ ok: true, result: [] });
    expect(w.terminated).toBe(true);
  });

  it('cancel and timeout stop the worker', async () => {
    setTableProgramWorkerFactory(() => new FakeWorker() as unknown as Worker);
    const run = runTableProgram('while(true){}', snapshot);
    run.cancel();
    expect(await run.outcome).toEqual({ ok: false, error: 'Canceled', canceled: true });
    expect(FakeWorker.last!.terminated).toBe(true);

    vi.useFakeTimers();
    const slow = runTableProgram('x', snapshot, 1000);
    vi.advanceTimersByTime(1001);
    expect(await slow.outcome).toEqual({ ok: false, error: 'Timed out after 1s' });
  });
});
