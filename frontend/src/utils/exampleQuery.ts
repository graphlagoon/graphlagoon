import type { GraphContext, Node } from '@/types/graph';

/**
 * Generate a sample BFS OpenCypher query for the query panel.
 *
 * Architectural contract (why this shape):
 * - The visualization backend REQUIRES `RETURN r` — it keys off the result
 *   column named `r`, extracts src/dst node ids from each returned edge, and
 *   fetches node attributes in a separate query. `RETURN p` / `RETURN nodes(p)`
 *   are rejected by validation and produce no renderable graph, so we always
 *   project the relationship `r`.
 * - The node-id property name comes from the context schema (`node_id_col`),
 *   never a hardcoded `node_id`.
 * - No node-type label is emitted. Matching by id alone works for any node
 *   type, so we avoid forcing a possibly-wrong label (a hardcoded/first-type
 *   label would silently filter out the substituted node if it is a different
 *   type).
 *
 * @param context The current graph context (schema source). May be null.
 * @param displayedNodes Nodes currently on screen; when non-empty a real id is
 *   used, otherwise a `{node_id_col}_value` placeholder is emitted for the user.
 */
export function generateBfsExampleQuery(
  context: GraphContext | null | undefined,
  displayedNodes: readonly Node[] = [],
): string {
  const nodeIdCol = context?.node_structure?.node_id_col || 'node_id';

  if (displayedNodes.length > 0) {
    const randomIndex = Math.floor(Math.random() * displayedNodes.length);
    const nodeIdValue = displayedNodes[randomIndex].node_id;

    return `MATCH (root { ${nodeIdCol}: "${nodeIdValue}" })
MATCH p = (root)-[*1..2]-()
UNWIND relationships(p) AS r
RETURN r`;
  }

  // Fallback: placeholder for the user to fill in. No hardcoded node-type label.
  return `MATCH (root { ${nodeIdCol}: "{${nodeIdCol}_value}" })
MATCH p = (root)-[*1..2]-()
UNWIND relationships(p) AS r
RETURN r`;
}
