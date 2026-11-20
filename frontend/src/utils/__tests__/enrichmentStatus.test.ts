import { describe, expect, it } from 'vitest';
import type { QueryEnrichmentRun } from '@/stores/graph';
import { describeRun, enrichmentHoldReason, enrichmentSettled, enrichmentSucceeded, summarizeEnrichment } from '../enrichmentStatus';

const run = (over: Partial<QueryEnrichmentRun> = {}): QueryEnrichmentRun => ({
  status: 'done', label: 'Risk', target: 'edges', matched: 1, written: 1, total: 2,
  truncated: false, error: null, at: 0, finishedAt: 1200, batchesDone: 1, batchesTotal: 1, ...over,
});

describe('summarizeEnrichment', () => {
  it('is null when nothing ran', () => {
    expect(summarizeEnrichment({})).toBeNull();
  });

  it('counts finished runs while some still run or wait', () => {
    const s = summarizeEnrichment({ a: run(), b: run({ status: 'running' }), c: run({ status: 'queued' }) });
    expect(s).toMatchObject({ state: 'running', total: 3, finished: 1, text: 'Enriching 1 of 3' });
  });

  it('stays running while a call is still planning, even with every record finished', () => {
    expect(summarizeEnrichment({ a: run() }, 1)?.state).toBe('running');
  });

  it('says how many failed once settled, and done when none did', () => {
    expect(summarizeEnrichment({ a: run(), b: run({ status: 'error' }) })).toMatchObject({ state: 'error', text: 'Enrichment: 1 failed' });
    expect(summarizeEnrichment({ a: run(), b: run() })).toMatchObject({ state: 'done', text: 'Enriched · 2' });
  });
});

describe('settled and succeeded', () => {
  it('settles only with no call in flight and nothing queued or running', () => {
    expect(enrichmentSettled({ a: run(), b: run({ status: 'error' }) }, 0)).toBe(true);
    expect(enrichmentSettled({ a: run({ status: 'queued' }) }, 0)).toBe(false);
    expect(enrichmentSettled({}, 1)).toBe(false);
  });

  it('succeeds only when every run is done', () => {
    expect(enrichmentSucceeded({})).toBe(true);
    expect(enrichmentSucceeded({ a: run(), b: run({ status: 'error' }) })).toBe(false);
  });
});

describe('describeRun', () => {
  it('shows the code, the message and the duration of a failure', () => {
    const text = describeRun(run({ status: 'error', error: 'took too long', errorCode: 'ENRICHMENT_PROVIDER_TIMEOUT' }));
    expect(text).toContain('ENRICHMENT_PROVIDER_TIMEOUT: took too long');
    expect(text).toContain('1.2s');
  });

  it('shows batch progress of a long run', () => {
    expect(describeRun(run({ status: 'running', finishedAt: null, batchesDone: 1, batchesTotal: 3 }))).toContain('batch 2 of 3');
  });

  it('shows matches and truncation of a finished run', () => {
    const text = describeRun(run({ truncated: true }));
    expect(text).toContain('1 of 2 edges matched a row');
    expect(text).toContain('row limit');
  });
});

describe('enrichmentHoldReason', () => {
  it('holds only a program that waits, while enrichment runs or after it failed', () => {
    const gated = { wait_for_enrichment: true };
    expect(enrichmentHoldReason({}, { a: run({ status: 'error' }) }, 0)).toBeNull();
    expect(enrichmentHoldReason(gated, { a: run() }, 0)).toBeNull();
    expect(enrichmentHoldReason(gated, { a: run({ status: 'running' }) }, 0)).toMatch(/still running/);
    expect(enrichmentHoldReason(gated, { a: run({ status: 'error' }) }, 0)).toMatch(/failed/);
  });
});
