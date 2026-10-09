/** Entity resolution off the main thread (investigations F2.8); logic in utils/entityResolution.ts. */
import { suggestMatches, type ErNode, type MatchSuggestion } from '@/utils/entityResolution';

export type ErWorkerInput = { type: 'RUN'; nodes: ErNode[] };
export type ErWorkerOutput = { type: 'RESULT'; matches: MatchSuggestion[] } | { type: 'ERROR'; error: string };

self.onmessage = (event: MessageEvent<ErWorkerInput>) => {
  if (event.data.type !== 'RUN') return;
  try {
    postMessage({ type: 'RESULT', matches: suggestMatches(event.data.nodes) } as ErWorkerOutput);
  } catch (e) {
    postMessage({ type: 'ERROR', error: e instanceof Error ? e.message : String(e) } as ErWorkerOutput);
  }
};
