/**
 * Display-only sum of parallel edges (investigations F3.2): edges with the same
 * (source, target, type) collapse into one drawn edge carrying the count, the
 * amount sum and the first and last time. The store's edges are never touched.
 */
import type { Edge, ParallelAggregate } from '@/types/graph';
import type { EdgeValue } from '@/utils/edgeSemantics';

/**
 * One edge per (src, dst, type), in first-seen order. A group of one passes through
 * as is; a larger group is its first edge (a real id, so selection and the inspector
 * still work) plus `__agg`.
 */
export function aggregateParallelEdges(edges: Edge[], valueOf: (e: Edge) => EdgeValue): Edge[] {
  const groups = new Map<string, Edge[]>();
  for (const e of edges) {
    const key = `${e.src}\u0000${e.dst}\u0000${e.relationship_type}`;
    const group = groups.get(key);
    if (group) group.push(e);
    else groups.set(key, [e]);
  }
  const out: Edge[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const agg: ParallelAggregate = { count: group.length, sum: null, first: null, last: null, edgeIds: [] };
    for (const e of group) {
      const { amount, t } = valueOf(e);
      agg.edgeIds.push(e.edge_id);
      if (amount !== null) agg.sum = (agg.sum ?? 0) + amount;
      if (t !== null) {
        agg.first = agg.first === null ? t : Math.min(agg.first, t);
        agg.last = agg.last === null ? t : Math.max(agg.last, t);
      }
    }
    out.push({ ...group[0], __agg: agg });
  }
  return out;
}

/** The amount a drawn edge stands for: its group's sum, or its own amount. */
export function drawnAmount(edge: Edge, valueOf: (e: Edge) => EdgeValue): number | null {
  return edge.__agg ? edge.__agg.sum : valueOf(edge).amount;
}
