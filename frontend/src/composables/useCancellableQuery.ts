import { ref, computed } from 'vue';

/** Chunk download progress reported by the backend during result streaming. */
export interface ChunkProgress {
  done: number;
  total: number;
}

/**
 * Normalized outcome of a submit or a poll step. The caller's `submit`/`poll`
 * callbacks translate their endpoint-specific responses into this shape so the
 * state machine stays generic across the table and graph query flows.
 */
export interface StepResult {
  status: 'running' | 'succeeded' | 'canceled';
  /** Statement/job id — required to poll and cancel a running query. */
  statementId?: string;
  /** Incremental chunk-download progress, when the backend reports it. */
  chunkProgress?: ChunkProgress | null;
  /** Opaque result payload handed to `applyResult` on success. */
  result?: unknown;
  /**
   * A renderable intermediate result published while the job is still running.
   * Paired with `partialSeq` so the poller can tell a new partial from one it
   * has already applied — polls happen far more often than partials arrive.
   */
  partial?: unknown;
  partialSeq?: number;
}

export interface CancellableQueryOptions {
  /** Submit the query; resolve to running (+id) or a terminal result. */
  submit: () => Promise<StepResult>;
  /** Poll a running statement/job by id. */
  poll: (statementId: string) => Promise<StepResult>;
  /** Ask the backend to cancel a running statement/job (best-effort). */
  cancel: (statementId: string) => Promise<void>;
  /** Apply a succeeded result (build the grid / replace the graph). */
  applyResult: (result: unknown) => void;
  /**
   * Apply a partial result, if the backend publishes one. Called at most once
   * per distinct `partialSeq`, and never after `applyResult`.
   */
  applyPartial?: (partial: unknown) => void;
  /** Handle a thrown error from submit/poll. */
  onError: (e: unknown) => void;
  /** Called when the run is cancelled (by the user or the backend). */
  onCanceled?: () => void;
  /** Optional dev tracer. */
  onLog?: (step: string, data?: Record<string, unknown>) => void;
  firstPollMs?: number;
  pollIntervalMs?: number;
}

/**
 * Reusable submit → poll → cancel state machine shared by the Query Console
 * (table) and the graph query flow. Owns loading / statementId / canceled /
 * chunkProgress and a monotonic run token that lets a superseded or cancelled
 * run's poll loop exit without clobbering fresh state. The caller supplies the
 * endpoint-specific submit/poll/cancel and how to apply a result.
 */
export function useCancellableQuery(opts: CancellableQueryOptions) {
  const loading = ref(false);
  const statementId = ref<string | null>(null);
  const canceled = ref(false);
  const chunkProgress = ref<ChunkProgress | null>(null);

  // Each run()/cancelQuery() bumps this so a stale poll loop from a superseded
  // run exits instead of overwriting fresh state.
  let runToken = 0;

  const FIRST_POLL_MS = opts.firstPollMs ?? 300;
  const POLL_INTERVAL_MS = opts.pollIntervalMs ?? 1200;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  const log = (step: string, data?: Record<string, unknown>) =>
    opts.onLog?.(step, data);

  async function run(): Promise<void> {
    const token = ++runToken;
    loading.value = true;
    canceled.value = false;
    statementId.value = null;
    chunkProgress.value = null;
    log('▶ submit');
    try {
      const first = await opts.submit();
      // Superseded/cancelled while the submit was in flight — abandon, and if
      // the backend handed us a running statement, cancel it so it does not
      // keep burning compute orphaned.
      if (token !== runToken) {
        if (first.status === 'running' && first.statementId) {
          opts.cancel(first.statementId).catch(() => {});
        }
        return;
      }
      log('◀ submit response', {
        status: first.status,
        statementId: first.statementId,
      });
      if (first.chunkProgress) chunkProgress.value = first.chunkProgress;

      if (first.status === 'running' && first.statementId) {
        statementId.value = first.statementId;
        await pollUntilDone(first.statementId, token);
      } else if (first.status === 'canceled') {
        canceled.value = true;
        opts.onCanceled?.();
      } else {
        opts.applyResult(first.result);
      }
    } catch (e) {
      if (token !== runToken) return;
      opts.onError(e);
    } finally {
      if (token === runToken) {
        loading.value = false;
        statementId.value = null;
      }
    }
  }

  async function pollUntilDone(id: string, token: number): Promise<void> {
    let interval = FIRST_POLL_MS;
    let pollN = 0;
    let appliedPartialSeq = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await sleep(interval);
      interval = POLL_INTERVAL_MS;
      if (token !== runToken) return;

      pollN += 1;
      const s = await opts.poll(id);
      if (token !== runToken) return;

      if (s.chunkProgress) chunkProgress.value = s.chunkProgress;
      log(`… poll #${pollN}`, { status: s.status, chunks: s.chunkProgress });

      // Draw what the backend has so far. Guarded by the sequence number: the
      // same partial rides along on every subsequent poll, and re-applying it
      // would redo the graph rebuild for nothing.
      if (
        s.partial != null &&
        (s.partialSeq ?? 0) > appliedPartialSeq &&
        opts.applyPartial
      ) {
        appliedPartialSeq = s.partialSeq ?? 0;
        log(`◐ partial #${appliedPartialSeq}`);
        opts.applyPartial(s.partial);
      }

      if (s.status === 'running') continue;
      if (s.status === 'canceled') {
        canceled.value = true;
        opts.onCanceled?.();
        return;
      }
      opts.applyResult(s.result);
      return;
    }
  }

  async function cancelQuery(): Promise<void> {
    if (!loading.value) return;
    const id = statementId.value;
    log('✖ cancel requested', { statementId: id });
    // Invalidate the in-flight run/poll immediately and reflect cancellation in
    // the UI without waiting for the round-trip. If the submit is still in
    // flight (no id yet), run()'s post-submit guard cancels the orphan later.
    runToken++;
    canceled.value = true;
    loading.value = false;
    statementId.value = null;
    opts.onCanceled?.();
    if (!id) return;
    try {
      await opts.cancel(id);
    } catch {
      // best-effort: the statement may have already finished.
    }
  }

  function reset(): void {
    runToken++;
    loading.value = false;
    statementId.value = null;
    canceled.value = false;
    chunkProgress.value = null;
  }

  /** Cancel is offerable once we have an id for the running statement. */
  const canCancel = computed(() => loading.value && statementId.value !== null);

  return {
    loading,
    statementId,
    canceled,
    chunkProgress,
    canCancel,
    run,
    cancelQuery,
    reset,
  };
}
