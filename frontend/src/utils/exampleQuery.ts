import {
  capabilitiesFor,
  resolveDatasourceType,
} from '@/composables/useDatasourceCapabilities';
import type { GraphContext, Node } from '@/types/graph';

/** Edge cap for the seedless example query — matches loadSubgraph's default edge_limit. */
const SEEDLESS_EDGE_LIMIT = 1000;

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
 *   never a hardcoded `node_id`. On a native graph database there is no such
 *   column at all — identity is the built-in `id()`, so the seed is matched
 *   with `WHERE id(root) = ...` instead of a property pattern.
 * - No node-type label is emitted. Matching by id alone works for any node
 *   type, so we avoid forcing a possibly-wrong label (a hardcoded/first-type
 *   label would silently filter out the substituted node if it is a different
 *   type).
 *
 * Two shapes, because a BFS needs a seed node:
 * - With nodes on screen, we seed the BFS from a real id taken from one of them.
 * - With an empty graph — the default now that opening a context fetches nothing — there is
 *   no id to seed from, and no node on screen for the user to copy one from. Emitting a
 *   `{node_id_value}` placeholder would leave them with a query that cannot run, so we fall
 *   back to a seedless edge scan that executes as-is.
 *
 * @param context The current graph context (schema source). May be null.
 * @param displayedNodes Nodes currently on screen; when non-empty a real id seeds the BFS,
 *   otherwise a runnable seedless edge query is emitted.
 */
export function generateBfsExampleQuery(
  context: GraphContext | null | undefined,
  displayedNodes: readonly Node[] = [],
): string {
  const nodeIdCol = context?.node_structure?.node_id_col || 'node_id';
  // A native graph database stores identity outside the property map, so a
  // `{ node_id: "..." }` pattern would match nothing there.
  const idIsAProperty = capabilitiesFor(resolveDatasourceType(context)).supportsCatalog;

  if (displayedNodes.length > 0) {
    const randomIndex = Math.floor(Math.random() * displayedNodes.length);
    const nodeIdValue = displayedNodes[randomIndex].node_id;

    if (!idIsAProperty) {
      return `MATCH p = (root)-[*1..2]-()
WHERE id(root) = "${nodeIdValue}"
UNWIND relationships(p) AS r
RETURN r`;
    }

    return `MATCH (root { ${nodeIdCol}: "${nodeIdValue}" })
MATCH p = (root)-[*1..2]-()
UNWIND relationships(p) AS r
RETURN r`;
  }

  // Empty graph: no seed available, so scan edges directly. Still projects `r`, per the
  // contract above. Runnable as-is — the user can hit Run without editing anything.
  return `MATCH ()-[r]-()
RETURN r
LIMIT ${SEEDLESS_EDGE_LIMIT}`;
}
