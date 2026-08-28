/**
 * Robustness of the evaluation core: the things that must fail safely.
 * (Network/storage stripping is covered by customMetricSandbox.test.ts and
 * the timeout/terminate path by customMetricRunner.test.ts.)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildIndexes, evaluateDefinition, compileDefinition } from '@/workers/customMetricEvaluate';
import type { CustomMetricIndexes } from '@/workers/customMetricEvaluate';
import type { CustomMetricRunnable, MetricValueType } from '@/types/customMetrics';
import { CUSTOM_METRIC_MAX_STRING_LENGTH, CUSTOM_METRIC_PROGRESS_EVERY } from '@/types/customMetrics';
import { makeCustomMetricSnapshot } from '@/__tests__/fixtures/customMetricGraph';

let ix: CustomMetricIndexes;

function run(code: string, value_type: MetricValueType = 'number', target: 'node' | 'edge' = 'node') {
  const def: CustomMetricRunnable = { id: 'd', target, value_type, code };
  const r = evaluateDefinition(def, ix);
  return { map: new Map(r.values), ...r };
}

beforeEach(() => {
  ix = buildIndexes(makeCustomMetricSnapshot());
});

describe('D. must fail safely', () => {
  it('D1 a value that is a Promise/object (what fetch would return) becomes null, not a string', () => {
    const { map, errorCount } = run(`return Promise.resolve(1);`, 'string');
    expect(errorCount).toBe(0);
    expect(map.get('p1')).toBeNull();
  });

  it('D5 mutating item.properties throws (frozen, strict mode) and is counted as an item error', () => {
    const { map, errorCount, firstItemError } = run(`item.properties.x = 1; return 1;`);
    expect(errorCount).toBe(ix.nodes.length);
    expect(firstItemError).toMatch(/TypeError/);
    expect(map.get('p1')).toBeNull();
    // The data seen by the next definition is untouched.
    expect((ix.nodeMap.get('p1')!.properties as Record<string, unknown>).x).toBeUndefined();
  });

  it('D5b mutating ctx.nodes / ctx.graph / a neighbour list throws', () => {
    expect(run(`ctx.nodes.push({}); return 1;`).errorCount).toBe(ix.nodes.length);
    expect(run(`ctx.graph.nodeCount = 0; return 1;`).errorCount).toBe(ix.nodes.length);
    expect(run(`ctx.neighbors('hub').push('x'); return 1;`).errorCount).toBe(ix.nodes.length);
    expect(ix.summary.nodeCount).toBe(8);
    expect(ix.neighbors.get('hub')!.length).toBe(6);
  });

  it('D5c reassigning a ctx method throws (inherited from the frozen base) and the base is intact', () => {
    const { errorCount, firstItemError } = run(`ctx.degreeOf = () => 0; return 1;`);
    expect(errorCount).toBe(ix.nodes.length);
    expect(firstItemError).toMatch(/TypeError/);
    const after = run(`return ctx.degreeOf('hub');`);
    expect(after.errorCount).toBe(0);
    expect(after.map.get('p1')).toBe(6);
  });

  it('D6 coercion by value_type', () => {
    expect(run(`return {a:1};`).map.get('p1')).toBeNull();
    expect(run(`return 123;`, 'string').map.get('p1')).toBe('123');
    expect(run(`return true;`, 'string').map.get('p1')).toBe('true');
    expect(run(`return 'x'.repeat(10000);`, 'string').map.get('p1')).toHaveLength(CUSTOM_METRIC_MAX_STRING_LENGTH);
    expect(run(`return NaN;`).map.get('p1')).toBeNull();
    expect(run(`return 1/0;`).map.get('p1')).toBeNull();
    expect(run(`return undefined;`).map.get('p1')).toBeNull();
    expect(run(`return;`, 'boolean').map.get('p1')).toBeNull();
    expect(run(`return 'yes';`, 'boolean').map.get('p1')).toBeNull();
    expect(run(`return 1;`, 'boolean').map.get('p1')).toBeNull();
    expect(run(`return '7';`).map.get('p1')).toBeNull(); // no implicit string→number
  });

  it('D7 a syntax error throws at compile time (DEFINITION_ERROR in the worker)', () => {
    expect(() => compileDefinition(`return item.properties.`)).toThrow(SyntaxError);
    expect(() => run(`return item.properties.`)).toThrow(SyntaxError);
  });

  it('D8 an exception on some items only: errorCount, firstItemError, other values present', () => {
    const { map, errorCount, firstItemError } = run(
      `if (item.type === 'Company') throw new Error('no companies'); return ctx.degree;`,
    );
    expect(errorCount).toBe(3);
    expect(firstItemError).toBe('Error: no companies');
    expect(map.get('c1')).toBeNull();
    expect(map.get('p1')).toBe(4);
  });

  it('D8b throwing a non-Error value is stringified', () => {
    expect(run(`throw 'boom';`).firstItemError).toBe('boom');
  });

  it('D9 200k synthetic nodes × trivial expression stays fast', () => {
    const nodes = Array.from({ length: 200_000 }, (_, i) => ({
      id: `n${i}`,
      type: 'T',
      properties: { v: i },
    }));
    const big = buildIndexes({
      nodes,
      edges: [],
      degrees: [],
      metrics: {},
      metricIdToName: {},
      metricsByAlgorithm: {},
      communities: [],
      summary: { nodeCount: nodes.length, edgeCount: 0, meanDegree: 0, density: 0 },
    });
    const progress: number[] = [];
    const start = performance.now();
    const r = evaluateDefinition(
      { id: 'd', target: 'node', value_type: 'number', code: `return item.properties.v * 2;` },
      big,
      { onProgress: (done) => progress.push(done) },
    );
    const elapsed = performance.now() - start;
    expect(r.values.length).toBe(200_000);
    expect(r.values[199_999]).toEqual(['n199999', 399_998]);
    expect(elapsed).toBeLessThan(2000);
    // Progress every CUSTOM_METRIC_PROGRESS_EVERY items plus a final tick.
    expect(progress[0]).toBe(CUSTOM_METRIC_PROGRESS_EVERY);
    expect(progress[progress.length - 1]).toBe(200_000);
  });

  it('limit (Test button) evaluates only the first N items and reports raw types', () => {
    const r = evaluateDefinition(
      { id: 'd', target: 'node', value_type: 'string', code: `return item.id === 'p2' ? 7 : {};` },
      ix,
      { limit: 3, collectSamples: true },
    );
    expect(r.values).toHaveLength(3);
    expect(r.samples).toEqual([
      { id: 'p1', value: null, rawType: 'object' },
      { id: 'p2', value: '7', rawType: 'number' },
      { id: 'p3', value: null, rawType: 'object' },
    ]);
  });

  it('edges: ctx.degree is undefined and ctx.nodes/edges are still reachable', () => {
    const { map, errorCount } = run(`return typeof ctx.degree + ':' + ctx.nodes.length + ':' + ctx.edges.length;`, 'string', 'edge');
    expect(errorCount).toBe(0);
    expect(map.get('e1')).toBe('undefined:8:11');
  });

  it('elapsedMs uses the injected clock', () => {
    let t = 0;
    const r = evaluateDefinition(
      { id: 'd', target: 'node', value_type: 'number', code: `return 1;` },
      ix,
      { now: () => (t += 5) },
    );
    expect(r.elapsedMs).toBe(5);
  });
});
