/**
 * Main-thread side of the cluster-program sandbox: protocol, timeout →
 * terminate, crashes, and stale/forged messages.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  runClusterProgramInWorker,
  setClusterProgramWorkerFactory,
} from '@/services/clusterProgramRunner'
import type {
  ClusterProgramSnapshot,
  ClusterProgramWorkerCommand,
  ClusterProgramWorkerMessage,
} from '@/types/cluster'
import { CLUSTER_PROGRAM_TIMEOUT_MS } from '@/types/cluster'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((ev: MessageEvent<ClusterProgramWorkerMessage>) => void) | null = null
  onerror: ((ev: ErrorEvent) => void) | null = null
  posted: ClusterProgramWorkerCommand[] = []
  terminate = vi.fn()
  constructor() {
    FakeWorker.instances.push(this)
  }
  postMessage(cmd: ClusterProgramWorkerCommand) {
    this.posted.push(cmd)
  }
  emit(msg: ClusterProgramWorkerMessage | Record<string, unknown>) {
    this.onmessage?.({ data: msg } as MessageEvent<ClusterProgramWorkerMessage>)
  }
}

const snapshot: ClusterProgramSnapshot = {
  nodes: [],
  edges: [],
  selectedNodeIds: [],
  selectedEdgeIds: [],
  params: {},
  metrics: [],
}

beforeEach(() => {
  FakeWorker.instances = []
  setClusterProgramWorkerFactory(() => new FakeWorker() as unknown as Worker)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('runClusterProgramInWorker', () => {
  it('sends RUN after READY and resolves with the result', async () => {
    const pending = runClusterProgramInWorker('return []', snapshot)
    const w = FakeWorker.instances[0]
    w.emit({ type: 'READY' })
    const cmd = w.posted[0]
    expect(cmd).toMatchObject({ type: 'RUN', code: 'return []', snapshot })

    w.emit({ type: 'RESULT', runId: cmd.runId, result: [1] })
    await expect(pending).resolves.toEqual({ ok: true, result: [1] })
    expect(w.terminate).toHaveBeenCalled()
  })

  it('times out, terminating the worker', async () => {
    const pending = runClusterProgramInWorker('while (true) {}', snapshot)
    const w = FakeWorker.instances[0]
    w.emit({ type: 'READY' })
    await vi.advanceTimersByTimeAsync(CLUSTER_PROGRAM_TIMEOUT_MS - 1)
    expect(w.terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toEqual({ ok: false, error: 'Timed out after 10s' })
    expect(w.terminate).toHaveBeenCalled()
  })

  it('a custom timeout is honoured, and late results are ignored', async () => {
    const pending = runClusterProgramInWorker('x', snapshot, 500)
    const w = FakeWorker.instances[0]
    w.emit({ type: 'READY' })
    await vi.advanceTimersByTimeAsync(500)
    w.emit({ type: 'RESULT', runId: w.posted[0].runId, result: [] })
    await expect(pending).resolves.toEqual({ ok: false, error: 'Timed out after 1s' })
  })

  it('user errors and worker crashes resolve as errors', async () => {
    const p1 = runClusterProgramInWorker('x', snapshot)
    const w1 = FakeWorker.instances[0]
    w1.emit({ type: 'READY' })
    w1.emit({ type: 'ERROR', runId: w1.posted[0].runId, error: 'boom' })
    await expect(p1).resolves.toEqual({ ok: false, error: 'boom' })

    const p2 = runClusterProgramInWorker('x', snapshot)
    const w2 = FakeWorker.instances[1]
    w2.onerror?.({ message: 'syntax' } as ErrorEvent)
    await expect(p2).resolves.toEqual({ ok: false, error: 'Worker error: syntax' })
    expect(w2.terminate).toHaveBeenCalled()
  })

  it('ignores messages for another run and unknown types', async () => {
    const pending = runClusterProgramInWorker('x', snapshot)
    const w = FakeWorker.instances[0]
    w.emit({ type: 'READY' })
    w.emit({ type: 'RESULT', runId: 'forged', result: ['bad'] })
    w.emit({ type: 'SOMETHING' })
    w.emit({ type: 'RESULT', runId: w.posted[0].runId, result: ['good'] })
    await expect(pending).resolves.toEqual({ ok: true, result: ['good'] })
  })
})
