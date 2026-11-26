/**
 * What the enrichment of the graph on screen is doing, in words: the status-bar chip, its
 * popover and the Your data tab read it from the store's run records. Pure.
 */
import type { QueryEnrichmentRun } from '@/stores/graph';

export type EnrichmentState = 'running' | 'error' | 'done';

export interface EnrichmentSummary {
  state: EnrichmentState;
  /** Records known for this graph, and how many of them finished (done or failed). */
  total: number;
  finished: number;
  failed: number;
  text: string;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** "1.2s", "340ms". */
export function duration(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Nothing running nor waiting, and no call still planning its runs. */
export function enrichmentSettled(runs: Record<string, QueryEnrichmentRun>, inFlight: number): boolean {
  return inFlight === 0 && Object.values(runs).every((r) => r.status === 'done' || r.status === 'error');
}

/** Every enrichment that ran on this graph finished without an error (true when none ran). */
export function enrichmentSucceeded(runs: Record<string, QueryEnrichmentRun>): boolean {
  return Object.values(runs).every((r) => r.status === 'done');
}

/** The chip's state, or null when no enrichment ran on this graph. */
export function summarizeEnrichment(runs: Record<string, QueryEnrichmentRun>, inFlight = 0): EnrichmentSummary | null {
  const all = Object.values(runs);
  if (!all.length) return null;
  const failed = all.filter((r) => r.status === 'error').length;
  const finished = all.filter((r) => r.status === 'done' || r.status === 'error').length;
  if (!enrichmentSettled(runs, inFlight)) {
    return { state: 'running', total: all.length, finished, failed, text: `Enriching ${finished} of ${all.length}` };
  }
  if (failed) {
    return { state: 'error', total: all.length, finished, failed, text: `Enrichment: ${failed} failed` };
  }
  return { state: 'done', total: all.length, finished, failed, text: `Enriched · ${all.length}` };
}

/** One run in a sentence: progress, the outcome or the error, and when. */
export function describeRun(r: QueryEnrichmentRun): string {
  const started = `started ${clock(r.at)}`;
  const took = r.finishedAt ? `${duration(r.finishedAt - r.at)} at ${clock(r.at)}` : started;
  if (r.status === 'queued') return 'Waiting for the ones before it…';
  if (r.status === 'running') {
    const batches = (r.batchesTotal ?? 0) > 1 ? ` batch ${(r.batchesDone ?? 0) + 1} of ${r.batchesTotal}` : '';
    return `Running…${batches} · ${started}`;
  }
  if (r.status === 'error') {
    return [r.errorCode ? `${r.errorCode}: ${r.error ?? 'failed'}` : r.error ?? 'The enrichment failed', took].join(' · ');
  }
  const parts = [`${r.matched} of ${r.total} ${r.target} matched a row`, `${r.written} got new values`, took];
  if (r.truncated) parts.push(`the result hit the row limit, so some ${r.target} may be missing`);
  const params = Object.entries(r.params ?? {}).filter(([, v]) => v !== null && v !== undefined);
  if (params.length) parts.push(`with ${params.map(([k, v]) => `${k}=${String(v)}`).join(', ')}`);
  return parts.join(' · ');
}

/**
 * Why running `program` now would miss enrichment values, or null: it waits for enrichment
 * (`wait_for_enrichment`) and the enrichment of this graph is still running or failed.
 */
export function enrichmentHoldReason(
  program: { wait_for_enrichment?: boolean },
  runs: Record<string, QueryEnrichmentRun>,
  inFlight: number,
): string | null {
  if (!program.wait_for_enrichment) return null;
  if (!enrichmentSettled(runs, inFlight)) return 'The enrichment of this graph is still running: properties this program reads may not be there yet.';
  if (!enrichmentSucceeded(runs)) return 'An enrichment of this graph failed: properties this program reads may be missing. Retry it from the Enrichment chip under the graph.';
  return null;
}
