/** Paths between two nodes off the main thread (investigations F3.6); logic in utils/paths.ts. */
import { findPaths, type Path, type PathEdge, type PathParams } from '@/utils/paths';

export type PathWorkerInput = { type: 'RUN'; edges: PathEdge[]; source: string; target: string; params: PathParams };
export type PathWorkerOutput = { type: 'RESULT'; paths: Path[] } | { type: 'ERROR'; error: string };

self.onmessage = (event: MessageEvent<PathWorkerInput>) => {
  if (event.data.type !== 'RUN') return;
  const { edges, source, target, params } = event.data;
  try {
    postMessage({ type: 'RESULT', paths: findPaths(edges, source, target, params) } as PathWorkerOutput);
  } catch (e) {
    postMessage({ type: 'ERROR', error: e instanceof Error ? e.message : String(e) } as PathWorkerOutput);
  }
};
