/**
 * "Show only" — a rule that keeps a subset of the nodes on the canvas and hides
 * the rest (visually; the layout stays). Saved as a rule, never as node ids, so
 * it re-applies when nodes or their properties load later and survives a
 * reload of the exploration or of a case's saved view.
 */
import type { Node } from '@/types/graph';
import type { MetricResolver } from '@/utils/labelFormatter';
import { parseMetricRef, resolveItemMetricValue, resolveItemValue } from '@/utils/labelFormatter';

export type IsolationRule =
  /** Communities of the current coloring (`communityStore.communityMap` ids). */
  | { kind: 'community'; ids: number[]; label: string }
  /** Clusters a program produced (`clusterStore.clusters[].cluster_id`). */
  | { kind: 'cluster'; ids: string[]; label: string }
  /**
   * Nodes whose `field` (a property, `node_type`, or `metric:<ref>`) equals
   * `value` (`mode: 'same'`) or is not empty (`mode: 'has'`).
   */
  | { kind: 'value'; field: string; value: string | null; mode: 'same' | 'has'; label: string };

export interface IsolationSources {
  nodes: Node[];
  communityMap: Map<string, number>;
  clusters: { cluster_id: string; node_ids: string[] }[];
  metrics?: MetricResolver;
}

/** The value of `field` on a node, as the labels show it ('' when missing). */
export function nodeFieldValue(node: Node, field: string, metrics?: MetricResolver): string {
  const ref = parseMetricRef(field);
  if (ref) return resolveItemMetricValue('node', node, ref, metrics);
  return resolveItemValue('node', node, field);
}

/**
 * The node ids a rule keeps, or null when the rule cannot apply yet: the
 * communities or clusters it names are not there (cleared, or not restored
 * yet). Null shows everything — a stale rule must never blank the canvas.
 */
export function resolveIsolation(rule: IsolationRule, src: IsolationSources): Set<string> | null {
  const keep = new Set<string>();
  if (rule.kind === 'community') {
    if (src.communityMap.size === 0) return null;
    const ids = new Set(rule.ids);
    for (const [nodeId, communityId] of src.communityMap) {
      if (ids.has(communityId)) keep.add(nodeId);
    }
  } else if (rule.kind === 'cluster') {
    const ids = new Set(rule.ids);
    if (!src.clusters.some((c) => ids.has(c.cluster_id))) return null;
    for (const c of src.clusters) {
      if (ids.has(c.cluster_id)) for (const id of c.node_ids) keep.add(id);
    }
  } else {
    for (const n of src.nodes) {
      const v = nodeFieldValue(n, rule.field, src.metrics);
      if (rule.mode === 'has' ? v !== '' : v === (rule.value ?? '')) keep.add(n.node_id);
    }
  }
  return keep;
}

/**
 * Add a rule to the current one: ids of the same kind are unioned (a second
 * community shown beside the first); anything else replaces it.
 */
export function mergeIsolation(current: IsolationRule | null, next: IsolationRule): IsolationRule {
  if (current?.kind === 'community' && next.kind === 'community') {
    const ids = [...new Set([...current.ids, ...next.ids])];
    return { kind: 'community', ids, label: `${ids.length} communities` };
  }
  if (current?.kind === 'cluster' && next.kind === 'cluster') {
    const ids = [...new Set([...current.ids, ...next.ids])];
    return { kind: 'cluster', ids, label: `${ids.length} clusters` };
  }
  return next;
}

/** Remove ids from a rule of the same kind; null when nothing is left. */
export function subtractIsolation(
  current: IsolationRule | null,
  kind: 'community' | 'cluster',
  id: number | string,
  labelOf: (id: number | string) => string,
): IsolationRule | null {
  if (!current || current.kind !== kind) return current;
  const ids = (current.ids as (number | string)[]).filter((x) => x !== id);
  if (ids.length === 0) return null;
  const label = ids.length === 1 ? labelOf(ids[0]) : `${ids.length} ${kind === 'community' ? 'communities' : 'clusters'}`;
  return kind === 'community'
    ? { kind, ids: ids as number[], label }
    : { kind, ids: ids as string[], label };
}

/** True when a stored value looks like a rule (saved states are untrusted). */
export function isIsolationRule(v: unknown): v is IsolationRule {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (typeof r.label !== 'string') return false;
  if (r.kind === 'community') return Array.isArray(r.ids) && r.ids.every((x) => typeof x === 'number');
  if (r.kind === 'cluster') return Array.isArray(r.ids) && r.ids.every((x) => typeof x === 'string');
  if (r.kind === 'value') {
    return typeof r.field === 'string' && (r.mode === 'same' || r.mode === 'has')
      && (r.value === null || typeof r.value === 'string');
  }
  return false;
}
