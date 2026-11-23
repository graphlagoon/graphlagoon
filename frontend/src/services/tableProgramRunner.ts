/**
 * Main-thread side of the table-program sandbox: one dedicated worker per run
 * (services/sandboxRunner.ts), terminated when the run settles or is canceled.
 */
import { runInSandboxWorker, type SandboxRun } from './sandboxRunner';
import { TABLE_PROGRAM_TIMEOUT_MS, type TableProgramSnapshot } from '@/workers/tableProgramEvaluate';

const defaultFactory = (): Worker =>
  new Worker(new URL('../workers/tableProgramWorker.ts', import.meta.url), { type: 'module' });

let workerFactory: () => Worker = defaultFactory;

/** Test seam: replace how workers are created. Returns the previous factory. */
export function setTableProgramWorkerFactory(factory: (() => Worker) | null): () => Worker {
  const prev = workerFactory;
  workerFactory = factory ?? defaultFactory;
  return prev;
}

export function runTableProgram(
  code: string,
  snapshot: TableProgramSnapshot,
  timeoutMs: number = TABLE_PROGRAM_TIMEOUT_MS,
): SandboxRun {
  return runInSandboxWorker(workerFactory, { code, snapshot }, timeoutMs, 'table program');
}
