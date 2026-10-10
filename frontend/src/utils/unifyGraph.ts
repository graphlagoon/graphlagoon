/**
 * Unified case graph (investigations, 03 §5.1): N sources from different
 * contexts merged into one graph by the contexts' identity keys. Pure.
 */
import type { Edge, GraphContext, GraphSnapshot, Node } from '@/types/graph';
import { identityKeyOf } from '@/utils/identityKeys';
import { edgeValueTags } from '@/utils/edgeSemantics';

/** Where a unified node came from: one entry per (source, original node). */
export interface NodeOrigin {
  sourceId: string;
  contextId: string;
  nodeId: string;
}

export interface UnifiedNode extends Node {
  __sources: NodeOrigin[];
  /** Identity entity ("Pessoa") when the node was merged by key; absent for the fallback uid. */
  __entity?: string;
  /** Values that lost to the first one, per property (`node_type` for a type clash). */
  __conflicts?: Record<string, { value: unknown; sourceId: string }[]>;
}

export interface UnifiedEdge extends Edge {
  __source: string;
}

export interface UnifySource {
  id: string;
  contextId: string;
  nodes: Node[];
  edges: Edge[];
}

export interface UnifiedGraph {
  nodes: UnifiedNode[];
  edges: UnifiedEdge[];
}

/** A saved exploration snapshot in the store's Node/Edge shape. */
export function snapshotToGraph(snapshot: GraphSnapshot | null | undefined): {
  nodes: Node[];
  edges: Edge[];
} {
  return {
    nodes: (snapshot?.nodes ?? []).map((n) => ({
      node_id: n.id,
      node_type: n.type,
      properties: n.properties,
      x: n.x,
      y: n.y,
    })),
    edges: (snapshot?.edges ?? []).map((e) => ({
      edge_id: e.id,
      src: e.source,
      dst: e.target,
      relationship_type: e.type,
      properties: e.properties,
    })),
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b);
}

function addConflict(node: UnifiedNode, prop: string, value: unknown, sourceId: string) {
  const list = ((node.__conflicts ??= {})[prop] ??= []);
  if (!list.some((c) => sameValue(c.value, value))) list.push({ value, sourceId });
}

function mergeNode(
  into: Map<string, UnifiedNode>,
  uid: string,
  entity: string | undefined,
  n: Node,
  origin: NodeOrigin,
) {
  const existing = into.get(uid);
  if (!existing) {
    into.set(uid, {
      node_id: uid,
      node_type: n.node_type,
      properties: { ...(n.properties ?? {}) },
      x: n.x,
      y: n.y,
      __sources: [origin],
      ...(entity ? { __entity: entity } : {}),
    });
    return;
  }
  if (!existing.__sources.some((o) => o.sourceId === origin.sourceId && o.nodeId === origin.nodeId)) {
    existing.__sources.push(origin);
  }
  if (n.node_type !== existing.node_type) addConflict(existing, 'node_type', n.node_type, origin.sourceId);
  const props = existing.properties!;
  for (const [k, v] of Object.entries(n.properties ?? {})) {
    // A missing value is not a disagreement: the other source just fills it.
    if (props[k] === null || props[k] === undefined) props[k] = v;
    else if (v !== null && v !== undefined && !sameValue(props[k], v)) addConflict(existing, k, v, origin.sourceId);
  }
}

/**
 * Nodes merge by identity key (`"Pessoa:12345678901"`); a node without a usable key
 * stays per context (`"{node_id}@{contextId}"`, id first so the default label reads
 * the original id). Edges are never merged across sources; each carries its own
 * context's amount and time (`__amount`/`__t`).
 */
export function unifyGraph(
  sources: UnifySource[],
  contexts: Record<string, Pick<GraphContext, 'identity_keys' | 'edge_semantics'> | null | undefined>,
): UnifiedGraph {
  const nodes = new Map<string, UnifiedNode>();
  const edges = new Map<string, UnifiedEdge>();

  for (const s of sources) {
    const keys = new Map((contexts[s.contextId]?.identity_keys ?? []).map((k) => [k.node_type, k]));
    const semantics = contexts[s.contextId]?.edge_semantics;
    const uidOf = new Map<string, string>();
    for (const n of s.nodes) {
      const key = keys.get(n.node_type);
      const keyed = key ? identityKeyOf(key, { id: n.node_id, properties: n.properties }) : null;
      const uid = keyed ?? `${n.node_id}@${s.contextId}`;
      uidOf.set(n.node_id, uid);
      mergeNode(nodes, uid, keyed ? key!.entity : undefined, n, {
        sourceId: s.id,
        contextId: s.contextId,
        nodeId: n.node_id,
      });
    }
    for (const e of s.edges) {
      const src = uidOf.get(e.src);
      const dst = uidOf.get(e.dst);
      // An edge whose endpoint is not in its own source would dangle in the canvas.
      if (!src || !dst) continue;
      const id = `${s.id}:${e.edge_id}`;
      // Amount/time are tagged per edge: sources of different contexts name them differently.
      if (!edges.has(id)) edges.set(id, { ...e, ...edgeValueTags(e, semantics), edge_id: id, src, dst, __source: s.id });
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/**
 * Distinct real sources of a node: an expansion (`expansion:<id>`) or derived nodes
 * (`derived:<id>:<table>`, promoted from an enrichment table) count as their source.
 */
export function baseSourceId(sourceId: string): string {
  if (sourceId.startsWith('expansion:')) return sourceId.slice('expansion:'.length);
  if (sourceId.startsWith('derived:')) return sourceId.split(':')[1];
  return sourceId;
}

export function nodeSourceIds(node: UnifiedNode): string[] {
  return [...new Set(node.__sources.map((o) => baseSourceId(o.sourceId)))];
}

/** Nodes present in more than one source, merged by key, counted per entity. */
export function mergedEntityCounts(nodes: UnifiedNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of nodes) {
    if (n.__entity && nodeSourceIds(n).length > 1) counts[n.__entity] = (counts[n.__entity] ?? 0) + 1;
  }
  return counts;
}

/**
 * Accepted entity matches (F2.8): each `[keep, drop]` pair folds `drop` into `keep`
 * (sources, missing properties, conflicts) and re-points its edges. Chains resolve
 * transitively. Only a person's accepted match gets here; nothing merges by itself.
 */
export function applyAliases(graph: UnifiedGraph, pairs: [string, string][]): UnifiedGraph {
  if (pairs.length === 0) return graph;
  const parent = new Map<string, string>();
  const find = (u: string): string => {
    let r = u;
    while (parent.has(r)) r = parent.get(r)!;
    return r;
  };
  for (const [keep, drop] of pairs) {
    const k = find(keep);
    const d = find(drop);
    if (k !== d) parent.set(d, k);
  }
  const targets = new Set(pairs.map(([keep]) => find(keep)));
  const nodes = new Map<string, UnifiedNode>();
  const dropped: UnifiedNode[] = [];
  for (const n of graph.nodes) {
    if (find(n.node_id) !== n.node_id) dropped.push(n);
    else if (!targets.has(n.node_id)) nodes.set(n.node_id, n);
    else {
      // A copy: merging must not touch the cached unified graph.
      const conflicts = n.__conflicts && Object.fromEntries(Object.entries(n.__conflicts).map(([k, v]) => [k, [...v]]));
      nodes.set(n.node_id, { ...n, __sources: [...n.__sources], properties: { ...(n.properties ?? {}) }, __conflicts: conflicts });
    }
  }
  for (const n of dropped) {
    const into = nodes.get(find(n.node_id));
    if (!into) nodes.set(n.node_id, n); // the kept side is not loaded: show the node as is
    else for (const o of n.__sources) mergeNode(nodes, into.node_id, into.__entity, n, o);
  }
  const id = (u: string) => (nodes.has(find(u)) ? find(u) : u);
  return {
    nodes: [...nodes.values()],
    edges: graph.edges.map((e) => ({ ...e, src: id(e.src), dst: id(e.dst) })),
  };
}
