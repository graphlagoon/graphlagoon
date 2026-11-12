/**
 * Enrichment queries from a context's authorized Databricks tables. A context entry with a
 * `query` runs the author's SQL over the loaded graph and gets back, per edge id (target
 * `edges`) or node id (target `nodes`), columns that become properties. The graph travels in
 * batches of its targets plus what is around them. Pure: the graph store owns the requests.
 */
import type { Edge, EnrichmentRunResult, EnrichmentTable, GraphContext, Node } from '@/types/graph';

/** Targets per request: the server's default `enrichment_max_keys`. */
export const RUN_BATCH = 500;

export type EnrichmentTarget = 'edges' | 'nodes';

export interface RunPayload {
  edges: Edge[];
  nodes: Pick<Node, 'node_id' | 'node_type' | 'properties'>[];
}

/** Which keys of an edge (or node) each query wrote: id → query label → keys. */
export type EnrichmentProvenance = Map<string, Map<string, string[]>>;

export const targetOf = (entry: EnrichmentTable): EnrichmentTarget => entry.query?.target ?? 'edges';

/** The context's entries that carry a query; `run` keeps only auto or manual ones. */
export function queryEntries(
  context: Pick<GraphContext, 'enrichment_tables'> | null | undefined,
  run?: 'auto' | 'manual',
): EnrichmentTable[] {
  return (context?.enrichment_tables ?? []).filter(
    (t) => !!t.query?.sql && (!run || (t.query.run ?? 'manual') === run),
  );
}

/** The tables a query can read: every table the context authorizes. */
export function authorizedTables(context: Pick<GraphContext, 'enrichment_tables'> | null | undefined): string[] {
  return [...new Set((context?.enrichment_tables ?? []).map((t) => t.table))];
}

const plainEdge = (e: Edge): Edge => ({
  edge_id: e.edge_id,
  src: e.src,
  dst: e.dst,
  relationship_type: e.relationship_type,
  properties: e.properties ?? {},
});

/**
 * The batches for one query. Target `edges`: edges, each batch with its endpoint nodes.
 * Target `nodes`: nodes (`only` narrows them), each batch with the edges that touch it.
 * Node properties travel only when the query asks for them.
 */
export function runPayloads(
  nodes: Node[],
  edges: Edge[],
  entry: EnrichmentTable,
  batch = RUN_BATCH,
  only?: { edges?: Set<string>; nodes?: Set<string> },
): RunPayload[] {
  const withProps = !!entry.query?.node_props;
  const plainNode = (n: Node) => ({ node_id: n.node_id, node_type: n.node_type, properties: withProps ? n.properties ?? {} : {} });
  const out: RunPayload[] = [];
  if (targetOf(entry) === 'nodes') {
    const targets = only?.nodes ? nodes.filter((n) => only.nodes!.has(n.node_id)) : nodes;
    for (let i = 0; i < targets.length; i += batch) {
      const slice = targets.slice(i, i + batch);
      const ids = new Set(slice.map((n) => n.node_id));
      out.push({
        nodes: slice.map(plainNode),
        edges: edges.filter((e) => ids.has(e.src) || ids.has(e.dst)).map(plainEdge),
      });
    }
    return out;
  }
  const byId = new Map(nodes.map((n) => [n.node_id, n]));
  const targets = only?.edges ? edges.filter((e) => only.edges!.has(e.edge_id)) : edges;
  for (let i = 0; i < targets.length; i += batch) {
    const slice = targets.slice(i, i + batch).map(plainEdge);
    const ends = new Set(slice.flatMap((e) => [e.src, e.dst]));
    const batchNodes = [...ends].flatMap((id) => {
      const n = byId.get(id);
      return n ? [plainNode(n)] : [];
    });
    out.push({ edges: slice, nodes: batchNodes });
  }
  return out;
}

/**
 * The new properties of each item a result reaches: returned columns, null values left out,
 * a value the item already has kept unless `overwrite`. Returns the patch and the keys written.
 */
export function runPatch<T extends { properties?: Record<string, unknown> }>(
  items: T[],
  idOf: (item: T) => string,
  result: Pick<EnrichmentRunResult, 'rows'>,
  overwrite: boolean,
): { patch: Map<string, Record<string, unknown>>; written: Map<string, string[]>; matched: number } {
  const patch = new Map<string, Record<string, unknown>>();
  const written = new Map<string, string[]>();
  let matched = 0;
  for (const item of items) {
    const id = idOf(item);
    const row = result.rows[id];
    if (!row) continue;
    matched++;
    const props = { ...(item.properties ?? {}) };
    const keys: string[] = [];
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined) continue;
      if (!overwrite && props[k] !== undefined && props[k] !== null) continue;
      props[k] = v;
      keys.push(k);
    }
    if (keys.length) {
      patch.set(id, props);
      written.set(id, keys);
    }
  }
  return { patch, written, matched };
}

/** Records which query wrote which keys of which edge or node. */
export function recordProvenance(prov: EnrichmentProvenance, label: string, written: Map<string, string[]>): void {
  for (const [id, keys] of written) {
    const byLabel = prov.get(id) ?? new Map<string, string[]>();
    byLabel.set(label, [...new Set([...(byLabel.get(label) ?? []), ...keys])]);
    prov.set(id, byLabel);
  }
}

/** key → query label for one edge or node, for the details panel. */
export function enrichedKeys(prov: EnrichmentProvenance, id: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [label, keys] of prov.get(id) ?? []) for (const k of keys) out.set(k, label);
  return out;
}

/** Items without the properties a query wrote: what a saved snapshot keeps. */
export function stripEnriched<T extends { properties?: Record<string, unknown> }>(
  items: T[],
  idOf: (item: T) => string,
  prov: EnrichmentProvenance,
): T[] {
  if (!prov.size) return items;
  return items.map((item) => {
    const keys = enrichedKeys(prov, idOf(item));
    if (!keys.size || !item.properties) return item;
    const properties = Object.fromEntries(Object.entries(item.properties).filter(([k]) => !keys.has(k)));
    return { ...item, properties };
  });
}
