/**
 * Cluster program evaluation — pure, so it is unit-testable in Node.
 *
 * The worker (clusterProgramWorker.ts) is a thin shell around this module:
 * it hardens its global scope first (workers/customMetricSandbox.ts) and only
 * then calls `evaluateClusterProgram`. Output validation (cluster shape,
 * figure/state, node ids) stays on the main thread in the cluster store, so a
 * forged worker message can never inject an unvalidated cluster.
 */
import type {
  ClusterProgramContext,
  ClusterProgramMetricSnapshot,
  ClusterProgramSnapshot,
} from '@/types/cluster';

type MetricLookup = ClusterProgramContext['metric'];

/**
 * Rebuild the `metric(ref, id)` helper from the shipped metric values,
 * matching the main-thread semantics of `metricsStore.metricResolver`:
 * `ref` is an id (any target) or a name (first match within the target), and
 * a name shared by a node and an edge metric resolves node-first.
 */
export function buildMetricLookup(metrics: readonly ClusterProgramMetricSnapshot[]): MetricLookup {
  const byId = new Map<string, ClusterProgramMetricSnapshot>();
  const byName = { node: new Map<string, ClusterProgramMetricSnapshot>(), edge: new Map<string, ClusterProgramMetricSnapshot>() };
  for (const m of metrics) {
    if (!byId.has(m.id)) byId.set(m.id, m);
    const names = byName[m.target];
    if (names && !names.has(m.name)) names.set(m.name, m);
  }
  const valueMaps = new Map<ClusterProgramMetricSnapshot, Map<string, unknown>>();
  const valuesOf = (m: ClusterProgramMetricSnapshot) => {
    let map = valueMaps.get(m);
    if (!map) {
      map = new Map(m.values ?? []);
      valueMaps.set(m, map);
    }
    return map;
  };
  const resolve = (target: 'node' | 'edge', ref: string, id: string) => {
    const m = byId.get(ref) ?? byName[target].get(ref);
    if (!m || m.target !== target) return undefined;
    return valuesOf(m).get(id) as ReturnType<MetricLookup>;
  };
  return (ref, id) => {
    const nodeValue = resolve('node', String(ref), String(id));
    return nodeValue !== undefined ? nodeValue : resolve('edge', String(ref), String(id));
  };
}

/** Whether the program can reach `metric(...)` (decides if values are shipped). */
export function programUsesMetricLookup(code: string): boolean {
  return /\bmetric\b/.test(code);
}

/**
 * Compile and run a program over `snapshot`. Returns whatever the user code
 * returns (validated by the caller); throws what the user code throws.
 */
export function evaluateClusterProgram(code: string, snapshot: ClusterProgramSnapshot): unknown {
  const context: ClusterProgramContext = {
    nodes: snapshot.nodes,
    edges: snapshot.edges,
    selectedNodeIds: snapshot.selectedNodeIds,
    selectedEdgeIds: snapshot.selectedEdgeIds,
    params: snapshot.params,
    metric: buildMetricLookup(snapshot.metrics),
    metrics: snapshot.metrics.map(({ id, name, target, valueType }) => ({ id, name, target, valueType })),
  };

  // `metric`/`metrics` are in scope — a program declaring its own top-level
  // const with either name throws a redeclaration error.
  const fn = new Function('context', `
    'use strict';
    const { nodes, edges, selectedNodeIds, selectedEdgeIds, params, metric, metrics } = context;

    // User code:
    ${code}
  `);
  return fn(context);
}
