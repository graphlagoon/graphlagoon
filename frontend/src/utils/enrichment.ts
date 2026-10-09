/**
 * Enrichment tables in the investigation workspace (F2.2, 03 §2.1). Pure: which of a
 * context's side tables apply to a node, the lookup key, and "promote to nodes".
 */
import type { EnrichmentTable, GraphContext } from '@/types/graph';
import { baseSourceId, type UnifiedNode, type UnifySource } from '@/utils/unifyGraph';

/** One table that applies to nodes of a source's context. */
export interface EnrichmentTarget {
  sourceId: string;
  contextId: string;
  table: EnrichmentTable;
}

type Row = Record<string, string | null>;

const targetId = (t: EnrichmentTarget) => `${t.contextId}:${t.table.name}`;

/** The lookup key of `node` for `target`, or null when the node does not match it. */
export function enrichmentKey(node: UnifiedNode, target: EnrichmentTarget): string | null {
  if (!target.table.match_node_types.includes(node.node_type)) return null;
  const origin = node.__sources.find((o) => o.contextId === target.contextId);
  if (!origin) return null;
  const src = target.table.match_source;
  const raw = src === 'node_id' ? origin.nodeId : node.properties?.[src.name];
  return raw === null || raw === undefined || raw === '' ? null : String(raw);
}

/** Tables of the node's contexts that apply to its type, one per context and name. */
export function enrichmentTargets(
  node: UnifiedNode,
  contexts: Record<string, Pick<GraphContext, 'enrichment_tables'> | undefined>,
): EnrichmentTarget[] {
  const seen = new Map<string, EnrichmentTarget>();
  for (const o of node.__sources) {
    for (const table of contexts[o.contextId]?.enrichment_tables ?? []) {
      const target = { sourceId: baseSourceId(o.sourceId), contextId: o.contextId, table };
      if (!seen.has(targetId(target)) && enrichmentKey(node, target) !== null) seen.set(targetId(target), target);
    }
  }
  return [...seen.values()];
}

/** Every node of the graph the target applies to, with its key. */
export function keyedNodes(nodes: UnifiedNode[], target: EnrichmentTarget): { node: UnifiedNode; key: string }[] {
  const out: { node: UnifiedNode; key: string }[] = [];
  for (const node of nodes) {
    const key = enrichmentKey(node, target);
    if (key !== null) out.push({ node, key });
  }
  return out;
}

/**
 * "Promote to nodes": each distinct `promote.id_column` value becomes a node of
 * `promote.node_type`, linked from every node whose rows hold it. Returned as a
 * derived source (`derived:<sourceId>:<table>`) so it unifies like any source;
 * nodes and edges carry `__derived` in their properties.
 */
export function promoteToNodes(
  target: EnrichmentTarget,
  keyed: { node: UnifiedNode; key: string }[],
  rows: Record<string, Row[]>,
): UnifySource {
  const promote = target.table.promote!;
  const derived = `enrichment:${target.table.name}`;
  const source: UnifySource = { id: `derived:${target.sourceId}:${target.table.name}`, contextId: target.contextId, nodes: [], edges: [] };
  const promoted = new Set<string>();
  for (const { node, key } of keyed) {
    const values = new Set((rows[key] ?? []).map((r) => r[promote.id_column]).filter((v): v is string => !!v));
    if (!values.size) continue;
    const origin = node.__sources.find((o) => o.contextId === target.contextId)!;
    // The node itself, under its id in the context, so the edge unifies onto it.
    source.nodes.push({ node_id: origin.nodeId, node_type: node.node_type, properties: node.properties });
    for (const value of values) {
      const id = `${promote.node_type}:${value}`;
      if (!promoted.has(id)) {
        promoted.add(id);
        source.nodes.push({ node_id: id, node_type: promote.node_type, properties: { [promote.id_column]: value, __derived: derived } });
      }
      source.edges.push({
        edge_id: `${origin.nodeId}->${id}`,
        src: origin.nodeId,
        dst: id,
        relationship_type: promote.edge_type,
        properties: { __derived: derived },
      });
    }
  }
  return source;
}
