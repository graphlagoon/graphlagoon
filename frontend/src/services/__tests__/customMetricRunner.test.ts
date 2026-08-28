/**
 * Main-thread side of the sandbox: worker lifecycle, timeout → terminate +
 * respawn, protocol hygiene (forged / stale messages ignored), cancel, and
 * result sanitisation. Uses a FakeWorker driven by the test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import {
  runDefinitions,
  testDefinition,
  setWorkerFactory,
  buildComputedMetric,
  serializeGraphForCustomMetrics,
} from '@/services/customMetricRunner';
import type { CustomMetricDefinition, CustomMetricWorkerCommand, CustomMetricWorkerMessage } from '@/types/customMetrics';
import { CUSTOM_METRIC_TIMEOUT_MS } from '@/types/customMetrics';
import { makeCustomMetricSnapshot } from '@/__tests__/fixtures/customMetricGraph';
import { useGraphStore } from '@/stores/graph';
import { useMetricsStore } from '@/stores/metrics';
import { useCommunityStore } from '@/stores/community';
import { createComputedMetric } from '@/__tests__/fixtures/metrics';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((ev: MessageEvent<CustomMetricWorkerMessage>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  posted: CustomMetricWorkerCommand[] = [];
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(cmd: CustomMetricWorkerCommand) {
    this.posted.push(cmd);
  }
  /** Drive the protocol from the test. */
  emit(msg: CustomMetricWorkerMessage | Record<string, unknown>) {
    this.onmessage?.({ data: msg } as MessageEvent<CustomMetricWorkerMessage>);
  }
  ready() {
    this.emit({ type: 'READY' });
    return this.posted[this.posted.length - 1];
  }
  crash(message = 'boom') {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function def(id: string, overrides: Partial<CustomMetricDefinition> = {}): CustomMetricDefinition {
  return { id, name: `Metric ${id}`, target: 'node', value_type: 'number', code: 'return 1;', ...overrides };
}

const snapshot = makeCustomMetricSnapshot();

beforeEach(() => {
  setActivePinia(createPinia());
  FakeWorker.instances = [];
  setWorkerFactory(() => new FakeWorker() as unknown as Worker);
  vi.useFakeTimers();
});
afterEach(() => {
  setWorkerFactory(null);
  vi.useRealTimers();
});

describe('runDefinitions', () => {
  it('happy path: READY → RUN, results become ComputedMetrics with stable custom ids', async () => {
    const onResult = vi.fn();
    const onError = vi.fn();
    const handle = runDefinitions([def('a'), def('b', { value_type: 'string' })], snapshot, { onResult, onError });
    const w = FakeWorker.instances[0];
    const cmd = w.ready();
    expect(cmd.type).toBe('RUN');
    if (cmd.type !== 'RUN') throw new Error();
    expect(cmd.definitions.map((d) => d.id)).toEqual(['a', 'b']);
    expect(cmd.snapshot).toBe(snapshot);
    const runId = cmd.runId;

    w.emit({ type: 'DEFINITION_STARTED', runId, definitionId: 'a' });
    w.emit({ type: 'DEFINITION_RESULT', runId, definitionId: 'a', values: [['p1', 1], ['p2', 3]], errorCount: 0, elapsedMs: 4 });
    w.emit({ type: 'DEFINITION_STARTED', runId, definitionId: 'b' });
    w.emit({ type: 'DEFINITION_RESULT', runId, definitionId: 'b', values: [['p1', 'x'], ['p2', 5]], errorCount: 1, firstItemError: 'E', elapsedMs: 2 });
    w.emit({ type: 'RUN_COMPLETE', runId });
    await handle.done;

    expect(onError).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledTimes(2);
    const a = onResult.mock.calls[0][1];
    expect(a.id).toBe('custom:a');
    expect(a.algorithmId).toBe('custom');
    expect(a.valueType).toBe('number');
    expect(a.definitionId).toBe('a');
    expect(a.values.get('p2')).toBe(3);
    expect(a.min).toBe(1);
    expect(a.max).toBe(3);
    expect(a.mean).toBe(2);
    const b = onResult.mock.calls[1][1];
    expect(b.valueType).toBe('string');
    expect(b.values.get('p2')).toBe('5'); // re-coerced on the main thread
    expect(b.errorCount).toBe(1);
    expect(b.min).toBe(0); // no stats for non-numeric
    expect(w.terminate).toHaveBeenCalled(); // finished → worker released
  });

  it('D4 timeout: terminates the worker, reports the definition, re-runs the rest on a fresh worker', async () => {
    const onResult = vi.fn();
    const onError = vi.fn();
    const handle = runDefinitions([def('slow', { code: 'while(true){}' }), def('ok')], snapshot, { onResult, onError });
    const w1 = FakeWorker.instances[0];
    const cmd1 = w1.ready();
    if (cmd1.type !== 'RUN') throw new Error();
    w1.emit({ type: 'DEFINITION_STARTED', runId: cmd1.runId, definitionId: 'slow' });

    vi.advanceTimersByTime(CUSTOM_METRIC_TIMEOUT_MS + 1);

    expect(w1.terminate).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('slow', expect.stringMatching(/Timed out after 10s/));
    // A fresh worker only carries what is left.
    expect(FakeWorker.instances).toHaveLength(2);
    const w2 = FakeWorker.instances[1];
    const cmd2 = w2.ready();
    if (cmd2.type !== 'RUN') throw new Error();
    expect(cmd2.definitions.map((d) => d.id)).toEqual(['ok']);
    expect(cmd2.runId).not.toBe(cmd1.runId);

    // Late messages from the terminated worker are ignored.
    w1.emit({ type: 'DEFINITION_RESULT', runId: cmd1.runId, definitionId: 'slow', values: [['p1', 1]], errorCount: 0, elapsedMs: 1 });
    expect(onResult).not.toHaveBeenCalled();

    w2.emit({ type: 'DEFINITION_STARTED', runId: cmd2.runId, definitionId: 'ok' });
    w2.emit({ type: 'DEFINITION_RESULT', runId: cmd2.runId, definitionId: 'ok', values: [['p1', 1]], errorCount: 0, elapsedMs: 1 });
    w2.emit({ type: 'RUN_COMPLETE', runId: cmd2.runId });
    await handle.done;
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0]).toBe('ok');
  });

  it('the timeout timer is per definition (reset on each DEFINITION_STARTED)', async () => {
    const onError = vi.fn();
    const handle = runDefinitions([def('a'), def('b')], snapshot, { onResult: vi.fn(), onError });
    const w = FakeWorker.instances[0];
    const cmd = w.ready();
    if (cmd.type !== 'RUN') throw new Error();
    w.emit({ type: 'DEFINITION_STARTED', runId: cmd.runId, definitionId: 'a' });
    vi.advanceTimersByTime(CUSTOM_METRIC_TIMEOUT_MS - 10);
    w.emit({ type: 'DEFINITION_RESULT', runId: cmd.runId, definitionId: 'a', values: [], errorCount: 0, elapsedMs: 1 });
    w.emit({ type: 'DEFINITION_STARTED', runId: cmd.runId, definitionId: 'b' });
    vi.advanceTimersByTime(CUSTOM_METRIC_TIMEOUT_MS - 10);
    expect(onError).not.toHaveBeenCalled();
    w.emit({ type: 'DEFINITION_RESULT', runId: cmd.runId, definitionId: 'b', values: [], errorCount: 0, elapsedMs: 1 });
    w.emit({ type: 'RUN_COMPLETE', runId: cmd.runId });
    await handle.done;
    expect(w.terminate).toHaveBeenCalledTimes(1); // release on finish only
  });

  it('D7 compile error: DEFINITION_ERROR for that definition only; the others still run', async () => {
    const onResult = vi.fn();
    const onError = vi.fn();
    const handle = runDefinitions([def('bad'), def('good')], snapshot, { onResult, onError });
    const w = FakeWorker.instances[0];
    const cmd = w.ready();
    if (cmd.type !== 'RUN') throw new Error();
    w.emit({ type: 'DEFINITION_STARTED', runId: cmd.runId, definitionId: 'bad' });
    w.emit({ type: 'DEFINITION_ERROR', runId: cmd.runId, definitionId: 'bad', error: 'SyntaxError: Unexpected end of input' });
    w.emit({ type: 'DEFINITION_STARTED', runId: cmd.runId, definitionId: 'good' });
    w.emit({ type: 'DEFINITION_RESULT', runId: cmd.runId, definitionId: 'good', values: [['p1', 2]], errorCount: 0, elapsedMs: 1 });
    w.emit({ type: 'RUN_COMPLETE', runId: cmd.runId });
    await handle.done;
    expect(onError).toHaveBeenCalledWith('bad', 'SyntaxError: Unexpected end of input');
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('D3 forged / stale / malformed messages are ignored', async () => {
    const onResult = vi.fn();
    const onError = vi.fn();
    const handle = runDefinitions([def('a')], snapshot, { onResult, onError });
    const w = FakeWorker.instances[0];
    const cmd = w.ready();
    if (cmd.type !== 'RUN') throw new Error();
    w.emit({ type: 'RUN_COMPLETE', runId: 'not-this-run' }); // stale run id
    w.emit({ type: 'DEFINITION_RESULT', runId: 'other', definitionId: 'a', values: [['p1', 9]], errorCount: 0, elapsedMs: 1 });
    w.emit({ type: 'HELLO' }); // unknown type
    w.emit(null as unknown as Record<string, unknown>);
    w.emit({ type: 'DEFINITION_RESULT', runId: cmd.runId, definitionId: 'zzz', values: [], errorCount: 0, elapsedMs: 1 }); // unknown definition
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(w.terminate).not.toHaveBeenCalled();

    w.emit({ type: 'DEFINITION_RESULT', runId: cmd.runId, definitionId: 'a', values: [['p1', 1]], errorCount: 0, elapsedMs: 1 });
    w.emit({ type: 'RUN_COMPLETE', runId: cmd.runId });
    await handle.done;
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('RUN_COMPLETE without a result for a definition reports it as an error', async () => {
    const onError = vi.fn();
    const handle = runDefinitions([def('a')], snapshot, { onResult: vi.fn(), onError });
    const w = FakeWorker.instances[0];
    const cmd = w.ready();
    if (cmd.type !== 'RUN') throw new Error();
    w.emit({ type: 'RUN_COMPLETE', runId: cmd.runId });
    await handle.done;
    expect(onError).toHaveBeenCalledWith('a', 'Worker finished without a result');
  });

  it('a worker crash fails the in-flight definition and respawns for the rest', async () => {
    const onResult = vi.fn();
    const onError = vi.fn();
    const handle = runDefinitions([def('a'), def('b')], snapshot, { onResult, onError });
    const w1 = FakeWorker.instances[0];
    const cmd1 = w1.ready();
    if (cmd1.type !== 'RUN') throw new Error();
    w1.emit({ type: 'DEFINITION_STARTED', runId: cmd1.runId, definitionId: 'a' });
    w1.crash('out of memory');
    expect(w1.terminate).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('a', 'Worker error: out of memory');
    const w2 = FakeWorker.instances[1];
    const cmd2 = w2.ready();
    if (cmd2.type !== 'RUN') throw new Error();
    expect(cmd2.definitions.map((d) => d.id)).toEqual(['b']);
    w2.emit({ type: 'DEFINITION_RESULT', runId: cmd2.runId, definitionId: 'b', values: [], errorCount: 0, elapsedMs: 1 });
    w2.emit({ type: 'RUN_COMPLETE', runId: cmd2.runId });
    await handle.done;
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('cancel terminates the worker and rejects `done`', async () => {
    const handle = runDefinitions([def('a')], snapshot, { onResult: vi.fn(), onError: vi.fn() });
    const w = FakeWorker.instances[0];
    w.ready();
    handle.cancel();
    expect(w.terminate).toHaveBeenCalled();
    await expect(handle.done).rejects.toThrow('cancelled');
    // No respawn after cancel, even if the timer would have fired.
    vi.advanceTimersByTime(CUSTOM_METRIC_TIMEOUT_MS * 2);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('an empty definition list resolves immediately without a worker', async () => {
    const handle = runDefinitions([], snapshot, { onResult: vi.fn(), onError: vi.fn() });
    await handle.done;
    expect(FakeWorker.instances).toHaveLength(0);
  });
});

describe('testDefinition', () => {
  it('posts TEST and resolves with sanitised samples', async () => {
    const p = testDefinition(def('a', { value_type: 'string' }), snapshot, 3);
    const w = FakeWorker.instances[0];
    const cmd = w.ready();
    expect(cmd.type).toBe('TEST');
    if (cmd.type !== 'TEST') throw new Error();
    expect(cmd.sampleSize).toBe(3);
    w.emit({
      type: 'TEST_RESULT',
      runId: cmd.runId,
      definitionId: 'a',
      result: {
        samples: [
          { id: 'p1', value: 'x', rawType: 'string' },
          { id: 'p2', value: { hostile: 1 } as unknown as string, rawType: 'object' },
        ],
        errorCount: 0,
        elapsedMs: 3,
      },
    });
    const r = await p;
    expect(r.samples).toEqual([
      { id: 'p1', value: 'x', rawType: 'string' },
      { id: 'p2', value: null, rawType: 'object' },
    ]);
    expect(w.terminate).toHaveBeenCalled();
  });

  it('times out into result.error', async () => {
    const p = testDefinition(def('a'), snapshot);
    const w = FakeWorker.instances[0];
    w.ready();
    vi.advanceTimersByTime(CUSTOM_METRIC_TIMEOUT_MS + 1);
    const r = await p;
    expect(r.error).toMatch(/Timed out/);
    expect(r.samples).toEqual([]);
    expect(w.terminate).toHaveBeenCalled();
  });

  it('passes a compile error through', async () => {
    const p = testDefinition(def('a'), snapshot);
    const w = FakeWorker.instances[0];
    const cmd = w.ready();
    if (cmd.type !== 'TEST') throw new Error();
    w.emit({ type: 'TEST_RESULT', runId: cmd.runId, definitionId: 'a', result: { samples: [], errorCount: 0, error: 'SyntaxError: x', elapsedMs: 0 } });
    expect((await p).error).toBe('SyntaxError: x');
  });
});

describe('buildComputedMetric', () => {
  it('computes stats only for numeric metrics and skips nulls', () => {
    const m = buildComputedMetric(def('a'), [['x', 2], ['y', null], ['z', 4]], 7, 1);
    expect(m.min).toBe(2);
    expect(m.max).toBe(4);
    expect(m.mean).toBe(3);
    expect(m.values.get('y')).toBeNull();
    expect(m.elapsedMs).toBe(7);
    expect(m.errorCount).toBe(1);
    const s = buildComputedMetric(def('b', { value_type: 'boolean' }), [['x', true]], 1, 0);
    expect(s.min).toBe(0);
    expect(s.values.get('x')).toBe(true);
  });
});

describe('serializeGraphForCustomMetrics', () => {
  it('snapshots the filtered graph, degrees, non-custom metrics, communities and summary', () => {
    const graphStore = useGraphStore();
    graphStore.nodes = [
      { node_id: 'a', node_type: 'T', properties: { v: 1 } },
      { node_id: 'b', node_type: 'T' },
      { node_id: 'c', node_type: 'U', properties: { v: 3 } },
    ];
    graphStore.edges = [
      { edge_id: 'e1', src: 'a', dst: 'b', relationship_type: 'R', properties: { w: 1 } },
      { edge_id: 'e2', src: 'b', dst: 'c', relationship_type: 'R' },
    ];
    const metricsStore = useMetricsStore();
    metricsStore.completeComputation(createComputedMetric({ id: 'run-old', name: 'PageRank (1)', algorithmId: 'pagerank', computedAt: 1, values: new Map([['a', 0.1]]) }));
    metricsStore.completeComputation(createComputedMetric({ id: 'run-new', name: 'PageRank (2)', algorithmId: 'pagerank', computedAt: 2, values: new Map([['a', 0.2]]) }));
    metricsStore.upsertMetric(createComputedMetric({ id: 'custom:x', name: 'Mine', algorithmId: 'custom', values: new Map([['a', 9]]) }));
    useCommunityStore().communityMap = new Map([['a', 0], ['b', 0], ['c', 1]]);

    const s = serializeGraphForCustomMetrics();
    expect(s.nodes).toEqual([
      { id: 'a', type: 'T', properties: { v: 1 } },
      { id: 'b', type: 'T', properties: {} },
      { id: 'c', type: 'U', properties: { v: 3 } },
    ]);
    expect(s.edges[1]).toEqual({ id: 'e2', relationship_type: 'R', src: 'b', dst: 'c', properties: {} });
    expect(new Map(s.degrees).get('b')).toBe(2);
    expect(Object.keys(s.metrics).sort()).toEqual(['Degree', 'PageRank (1)', 'PageRank (2)']);
    expect(s.metrics['Mine']).toBeUndefined(); // custom metrics never feed other custom metrics
    expect(s.metricsByAlgorithm['pagerank']).toBe('PageRank (2)'); // latest run
    expect(s.metricsByAlgorithm['degree']).toBe('Degree');
    expect(s.metricIdToName['__builtin_degree']).toBe('Degree');
    expect(s.communities).toEqual([['a', 0], ['b', 0], ['c', 1]]);
    expect(s.summary).toEqual({ nodeCount: 3, edgeCount: 2, meanDegree: 4 / 3, density: 2 / 6 });
  });
});
