/**
 * In-process stand-in for `workers/clusterProgramWorker.ts` (happy-dom has no
 * module workers). Speaks the same protocol, asynchronously, and passes both
 * directions through `structuredClone` so a snapshot that a real worker could
 * not receive (e.g. a Vue proxy) fails here too. It does NOT harden the scope:
 * the sandbox itself is covered by customMetricSandbox.test.ts and the E2E run.
 */
import type {
  ClusterProgramWorkerCommand,
  ClusterProgramWorkerMessage,
} from '@/types/cluster'
import { evaluateClusterProgram } from '@/workers/clusterProgramEvaluate'

export class InlineClusterProgramWorker {
  onmessage: ((ev: MessageEvent<ClusterProgramWorkerMessage>) => void) | null = null
  onerror: ((ev: ErrorEvent) => void) | null = null
  terminated = false

  constructor() {
    queueMicrotask(() => this.emit({ type: 'READY' }))
  }

  postMessage(cmd: ClusterProgramWorkerCommand): void {
    const received = structuredClone(cmd)
    queueMicrotask(() => {
      if (received.type !== 'RUN') return
      let result: unknown
      try {
        result = evaluateClusterProgram(received.code, received.snapshot)
      } catch (e) {
        this.emit({ type: 'ERROR', runId: received.runId, error: e instanceof Error ? e.message : String(e) })
        return
      }
      try {
        this.emit({ type: 'RESULT', runId: received.runId, result: structuredClone(result) })
      } catch (e) {
        this.emit({
          type: 'ERROR',
          runId: received.runId,
          error: `Program result cannot be transferred: ${e instanceof Error ? e.message : String(e)}`,
        })
      }
    })
  }

  terminate(): void {
    this.terminated = true
  }

  private emit(msg: ClusterProgramWorkerMessage): void {
    if (this.terminated) return
    this.onmessage?.({ data: msg } as MessageEvent<ClusterProgramWorkerMessage>)
  }
}
