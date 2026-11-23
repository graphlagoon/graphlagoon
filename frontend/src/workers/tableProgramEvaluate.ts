/**
 * Table program evaluation (the `show-table` action's program source) — pure,
 * so it is unit-testable in Node. The worker (tableProgramWorker.ts) hardens
 * its scope first and only then calls `evaluateTableProgram`; the result is
 * normalized and capped on the main thread (utils/canvasTable.ts `toTable`).
 *
 * In scope for the user code: `item` (the clicked node or edge, canvas ids),
 * `params`, `nodes`, `edges`, `node(id)`, `neighbors(id, opts)`,
 * `hops(id, k, opts)`, `edgesOf(ids, opts)`, `metric(ref, id)`, `metrics`,
 * `selectedNodeIds`.
 */
import type { ClusterProgramMetricSnapshot } from '@/types/cluster';
import { programHelpers, type CanvasEdge, type CanvasItem, type CanvasNode } from '@/utils/canvasTable';
import { buildMetricLookup } from './clusterProgramEvaluate';

export const TABLE_PROGRAM_TIMEOUT_MS = 10_000;

export interface TableProgramSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  item: CanvasItem;
  params: Record<string, string>;
  selectedNodeIds: string[];
  metrics: ClusterProgramMetricSnapshot[];
}

export function evaluateTableProgram(code: string, snapshot: TableProgramSnapshot): unknown {
  const helpers = programHelpers(snapshot);
  const context = {
    item: snapshot.item,
    params: snapshot.params,
    nodes: snapshot.nodes,
    edges: snapshot.edges,
    selectedNodeIds: snapshot.selectedNodeIds,
    metric: buildMetricLookup(snapshot.metrics),
    metrics: snapshot.metrics.map(({ id, name, target, valueType }) => ({ id, name, target, valueType })),
    ...helpers,
  };
  const fn = new Function('context', `
    'use strict';
    const { item, params, nodes, edges, selectedNodeIds, metric, metrics, node, neighbors, hops, edgesOf } = context;

    // User code:
    ${code}
  `);
  return fn(context);
}
