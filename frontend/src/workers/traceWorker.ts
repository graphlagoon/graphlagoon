/** Temporal money trace off the main thread (investigations F3.3); logic in utils/trace.ts. */
import { traceForward, type TraceEdge, type TraceParams, type TraceResult } from '@/utils/trace';

export type TraceWorkerInput = {
  type: 'RUN';
  edges: TraceEdge[];
  nodeTypes: Record<string, string>;
  seed: { edgeIds: string[] };
  params: TraceParams;
};
export type TraceWorkerOutput = { type: 'RESULT'; result: TraceResult } | { type: 'ERROR'; error: string };

self.onmessage = (event: MessageEvent<TraceWorkerInput>) => {
  if (event.data.type !== 'RUN') return;
  const { edges, nodeTypes, seed, params } = event.data;
  try {
    postMessage({ type: 'RESULT', result: traceForward(edges, nodeTypes, seed, params) } as TraceWorkerOutput);
  } catch (e) {
    postMessage({ type: 'ERROR', error: e instanceof Error ? e.message : String(e) } as TraceWorkerOutput);
  }
};
