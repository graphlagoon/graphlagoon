/**
 * Evaluation core for custom metrics — pure, no worker APIs.
 *
 * The worker (customMetricWorker.ts) is a thin shell around this module so
 * every example in the docs can run under vitest in Node, while the real
 * sandbox (scope hardening + terminate-on-timeout) is exercised by the e2e
 * suite in Chromium.
 *
 * User code is the body of `function(item, ctx)`. It is compiled once per
 * definition with `new Function` in strict mode and called once per item.
 * Indexes (adjacency, node map, metric maps, community map) are built once
 * per RUN and shared by every definition of that run.
 */
import type {
  CustomMetricContext,
  CustomMetricEdgeItem,
  CustomMetricEvaluation,
  CustomMetricGraphSummary,
  CustomMetricNodeItem,
  CustomMetricRunnable,
  CustomMetricSnapshot,
  CustomMetricTestSample,
} from '@/types/customMetrics';
import { CUSTOM_METRIC_PROGRESS_EVERY } from '@/types/customMetrics';
import type { MetricValue } from '@/types/metrics';
import { coerceMetricValue } from '@/utils/customMetricValue';

export interface CustomMetricIndexes {
  nodes: readonly CustomMetricNodeItem[];
  edges: readonly CustomMetricEdgeItem[];
  nodeMap: Map<string, CustomMetricNodeItem>;
  degreeMap: Map<string, number>;
  outNeighbors: Map<string, string[]>;
  inNeighbors: Map<string, string[]>;
  neighbors: Map<string, string[]>;
  edgesByNode: Map<string, CustomMetricEdgeItem[]>;
  /** "src dst" for every directed edge */
  edgeKeys: Set<string>;
  metricMaps: Map<string, Map<string, MetricValue>>;
  metricIdToName: Map<string, string>;
  metricsByAlgorithm: Map<string, string>;
  communityMap: Map<string, number>;
  summary: CustomMetricGraphSummary;
}

const EMPTY: readonly string[] = Object.freeze([]);
const NO_EDGES: readonly CustomMetricEdgeItem[] = Object.freeze([]);

function pushUnique(map: Map<string, string[]>, key: string, value: string, seen: Set<string>): void {
  const k = key + ' ' + value;
  if (seen.has(k)) return;
  seen.add(k);
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  list.push(value);
}

/**
 * Build the shared indexes for one run. Freezes every item (and its
 * properties) so a definition cannot mutate what the next one sees.
 */
export function buildIndexes(snapshot: CustomMetricSnapshot): CustomMetricIndexes {
  const nodeMap = new Map<string, CustomMetricNodeItem>();
  for (const n of snapshot.nodes) {
    if (!n.properties) (n as { properties: Record<string, unknown> }).properties = {};
    Object.freeze(n.properties);
    Object.freeze(n);
    nodeMap.set(n.id, n);
  }
  for (const e of snapshot.edges) {
    if (!e.properties) (e as { properties: Record<string, unknown> }).properties = {};
    Object.freeze(e.properties);
    Object.freeze(e);
  }
  const nodes = Object.freeze(snapshot.nodes.slice());
  const edges = Object.freeze(snapshot.edges.slice());

  const outNeighbors = new Map<string, string[]>();
  const inNeighbors = new Map<string, string[]>();
  const neighbors = new Map<string, string[]>();
  const edgesByNode = new Map<string, CustomMetricEdgeItem[]>();
  const edgeKeys = new Set<string>();
  const seenOut = new Set<string>();
  const seenIn = new Set<string>();
  const seenUnd = new Set<string>();
  for (const e of edges) {
    edgeKeys.add(e.src + ' ' + e.dst);
    pushUnique(outNeighbors, e.src, e.dst, seenOut);
    pushUnique(inNeighbors, e.dst, e.src, seenIn);
    pushUnique(neighbors, e.src, e.dst, seenUnd);
    pushUnique(neighbors, e.dst, e.src, seenUnd);
    let l = edgesByNode.get(e.src);
    if (!l) edgesByNode.set(e.src, (l = []));
    l.push(e);
    if (e.dst !== e.src) {
      let m = edgesByNode.get(e.dst);
      if (!m) edgesByNode.set(e.dst, (m = []));
      m.push(e);
    }
  }
  for (const list of outNeighbors.values()) Object.freeze(list);
  for (const list of inNeighbors.values()) Object.freeze(list);
  for (const list of neighbors.values()) Object.freeze(list);
  for (const list of edgesByNode.values()) Object.freeze(list);

  const degreeMap = new Map<string, number>(snapshot.degrees);
  const metricMaps = new Map<string, Map<string, MetricValue>>();
  for (const [name, entries] of Object.entries(snapshot.metrics || {})) {
    metricMaps.set(name, new Map(entries));
  }
  const summary = Object.freeze({ ...snapshot.summary });

  return {
    nodes,
    edges,
    nodeMap,
    degreeMap,
    outNeighbors,
    inNeighbors,
    neighbors,
    edgesByNode,
    edgeKeys,
    metricMaps,
    metricIdToName: new Map(Object.entries(snapshot.metricIdToName || {})),
    metricsByAlgorithm: new Map(Object.entries(snapshot.metricsByAlgorithm || {})),
    communityMap: new Map(snapshot.communities || []),
    summary,
  };
}

/** Compile the user code. Throws (SyntaxError) on a compile failure. */
export function compileDefinition(code: string): (item: unknown, ctx: CustomMetricContext) => unknown {
  return new Function('item', 'ctx', '"use strict";\n' + code) as (
    item: unknown,
    ctx: CustomMetricContext,
  ) => unknown;
}

/** The part of `ctx` that is identical for every item of a definition. */
function makeBaseContext(ix: CustomMetricIndexes, cache: Record<string, unknown>) {
  const resolveMetric = (ref: string): Map<string, MetricValue> | undefined =>
    ix.metricMaps.get(ref) ??
    ix.metricMaps.get(ix.metricsByAlgorithm.get(ref) ?? '') ??
    ix.metricMaps.get(ix.metricIdToName.get(ref) ?? '');
  const base = {
    degreeOf: (id: string): number => ix.degreeMap.get(id) ?? 0,
    neighbors: (id: string): string[] => (ix.neighbors.get(id) ?? EMPTY) as string[],
    outNeighbors: (id: string): string[] => (ix.outNeighbors.get(id) ?? EMPTY) as string[],
    inNeighbors: (id: string): string[] => (ix.inNeighbors.get(id) ?? EMPTY) as string[],
    edgesOf: (id: string): CustomMetricEdgeItem[] =>
      (ix.edgesByNode.get(id) ?? NO_EDGES) as CustomMetricEdgeItem[],
    hasEdge: (src: string, dst: string): boolean => ix.edgeKeys.has(src + ' ' + dst),
    isConnected: (a: string, b: string): boolean =>
      ix.edgeKeys.has(a + ' ' + b) || ix.edgeKeys.has(b + ' ' + a),
    node: (id: string): CustomMetricNodeItem | undefined => ix.nodeMap.get(id),
    community: (id: string): number | null => ix.communityMap.get(id) ?? null,
    graph: ix.summary,
    nodes: ix.nodes,
    edges: ix.edges,
    cache,
    // `metric(ref, id)` — id defaults to the current item (set per item below)
    metric(this: { __id: string }, ref: string, id?: string): MetricValue | undefined {
      return resolveMetric(ref)?.get(id ?? this.__id);
    },
  };
  return Object.freeze(base);
}

export interface EvaluateOptions {
  /** Evaluate only the first N items (Test button) */
  limit?: number;
  /** Collect `typeof raw` per item (Test button) */
  collectSamples?: boolean;
  /** Progress callback (every CUSTOM_METRIC_PROGRESS_EVERY items) */
  onProgress?: (done: number, total: number) => void;
  /** Clock, injectable for tests */
  now?: () => number;
}

export interface EvaluateResult extends CustomMetricEvaluation {
  samples?: CustomMetricTestSample[];
}

/**
 * Evaluate one definition over the whole population of its target.
 * Per-item exceptions are counted (value → null); a compile failure throws.
 */
export function evaluateDefinition(
  def: CustomMetricRunnable,
  ix: CustomMetricIndexes,
  opts: EvaluateOptions = {},
): EvaluateResult {
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const start = now();
  const fn = compileDefinition(def.code);
  const items: readonly (CustomMetricNodeItem | CustomMetricEdgeItem)[] =
    def.target === 'node' ? ix.nodes : ix.edges;
  const total = opts.limit !== undefined ? Math.min(opts.limit, items.length) : items.length;
  const cache: Record<string, unknown> = {};
  const base = makeBaseContext(ix, cache);
  const metricNames = Array.from(ix.metricMaps.keys());

  const values: [string, MetricValue][] = new Array(total);
  const samples: CustomMetricTestSample[] | undefined = opts.collectSamples ? [] : undefined;
  let errorCount = 0;
  let firstItemError: string | undefined;

  for (let i = 0; i < total; i++) {
    const item = items[i];
    // Per-item metric values by name (built-in + algorithm runs)
    const metrics: Record<string, MetricValue> = {};
    for (const name of metricNames) {
      const v = ix.metricMaps.get(name)!.get(item.id);
      if (v !== undefined) metrics[name] = v;
    }
    const ctx = Object.create(base) as CustomMetricContext & { __id: string };
    ctx.__id = item.id;
    ctx.metrics = metrics;
    ctx.degree = def.target === 'node' ? (ix.degreeMap.get(item.id) ?? 0) : undefined;

    let raw: unknown;
    let value: MetricValue = null;
    try {
      raw = fn(item, ctx);
      value = coerceMetricValue(raw, def.value_type);
    } catch (e) {
      errorCount++;
      if (firstItemError === undefined) {
        firstItemError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
      raw = undefined;
      value = null;
    }
    values[i] = [item.id, value];
    if (samples) samples.push({ id: item.id, value, rawType: raw === null ? 'null' : typeof raw });

    if (opts.onProgress && (i + 1) % CUSTOM_METRIC_PROGRESS_EVERY === 0) opts.onProgress(i + 1, total);
  }
  if (opts.onProgress) opts.onProgress(total, total);

  return { values, errorCount, firstItemError, elapsedMs: now() - start, samples };
}
