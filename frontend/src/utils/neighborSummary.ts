/**
 * What surrounds one node, from the loaded graph only (hubs-densos F2 and F1):
 * its neighbours per (relationship type, direction, neighbour type), which of
 * them are leaves (linked to nothing else) and which have another link — the
 * investigator's usual question about a hub with hundreds of neighbours.
 */
import type { Edge } from '@/types/graph';

export type NeighborDirection = 'in' | 'out';

export interface NeighborRow {
  key: string;
  relationshipType: string;
  /** 'in': the neighbour is the edge's source (→ node); 'out': node → neighbour. */
  direction: NeighborDirection;
  nodeType: string;
  /** Distinct neighbours in this row, sorted. One neighbour may be in several rows. */
  nodeIds: string[];
  /** Of nodeIds, those whose only neighbour is the node. */
  leafIds: string[];
}

export interface NeighborSummary {
  /** Edges touching the node (self-loops once). */
  edges: number;
  /** Distinct neighbours. */
  neighbors: number;
  rows: NeighborRow[];
  /** Neighbours linked to nothing else, sorted. */
  leafIds: string[];
  /** Neighbours with at least one other neighbour, sorted. */
  linkedIds: string[];
}

export function summarizeNeighbors(
  nodeId: string,
  edges: readonly Pick<Edge, 'src' | 'dst' | 'relationship_type'>[],
  nodeTypeOf: (id: string) => string,
): NeighborSummary {
  const rows = new Map<string, { row: NeighborRow; ids: Set<string> }>();
  const neighbors = new Set<string>();
  let touching = 0;
  for (const e of edges) {
    if (e.src !== nodeId && e.dst !== nodeId) continue;
    touching++;
    if (e.src === e.dst) continue;
    const direction: NeighborDirection = e.src === nodeId ? 'out' : 'in';
    const other = direction === 'out' ? e.dst : e.src;
    neighbors.add(other);
    const nodeType = nodeTypeOf(other);
    const key = `${e.relationship_type}\u0000${direction}\u0000${nodeType}`;
    let entry = rows.get(key);
    if (!entry) {
      entry = { row: { key, relationshipType: e.relationship_type, direction, nodeType, nodeIds: [], leafIds: [] }, ids: new Set() };
      rows.set(key, entry);
    }
    entry.ids.add(other);
  }

  // A neighbour is a leaf when every one of its edges goes to the node (or loops on itself).
  const linked = new Set<string>();
  if (neighbors.size) {
    for (const e of edges) {
      if (e.src === e.dst) continue;
      if (neighbors.has(e.src) && e.dst !== nodeId) linked.add(e.src);
      if (neighbors.has(e.dst) && e.src !== nodeId) linked.add(e.dst);
    }
  }

  const out = [...rows.values()].map(({ row, ids }) => {
    row.nodeIds = [...ids].sort();
    row.leafIds = row.nodeIds.filter((id) => !linked.has(id));
    return row;
  });
  out.sort(
    (a, b) =>
      b.nodeIds.length - a.nodeIds.length ||
      a.relationshipType.localeCompare(b.relationshipType) ||
      a.direction.localeCompare(b.direction) ||
      a.nodeType.localeCompare(b.nodeType),
  );
  const all = [...neighbors].sort();
  return {
    edges: touching,
    neighbors: neighbors.size,
    rows: out,
    leafIds: all.filter((id) => !linked.has(id)),
    linkedIds: all.filter((id) => linked.has(id)),
  };
}

/**
 * "SOCIO_DE <- Person" / "OWNS -> Company": the arrow points the way the edge
 * goes. ASCII arrows: collections use this as their name, drawn on the canvas,
 * and the label font has no arrow glyphs.
 */
export function neighborRowLabel(row: Pick<NeighborRow, 'relationshipType' | 'direction' | 'nodeType'>): string {
  return row.direction === 'in' ? `${row.relationshipType} <- ${row.nodeType}` : `${row.relationshipType} -> ${row.nodeType}`;
}

/** Leaf collections (F1): one per row with at least `min` leaves. */
export function leafCollections(summary: NeighborSummary, min = 5): NeighborRow[] {
  return summary.rows.filter((r) => r.leafIds.length >= min);
}

/**
 * Members of a collection that are no longer leaves of `hub` (they gained
 * another link, e.g. after an expand) or no longer touch it.
 */
export function membersNoLongerLeaves(
  hub: string,
  memberIds: readonly string[],
  edges: readonly Pick<Edge, 'src' | 'dst'>[],
): string[] {
  const members = new Set(memberIds);
  const touchesHub = new Set<string>();
  const elsewhere = new Set<string>();
  for (const e of edges) {
    if (e.src === e.dst) continue;
    for (const [a, b] of [[e.src, e.dst], [e.dst, e.src]] as const) {
      if (!members.has(a)) continue;
      if (b === hub) touchesHub.add(a);
      else elsewhere.add(a);
    }
  }
  return memberIds.filter((id) => elsewhere.has(id) || !touchesHub.has(id));
}

/**
 * Connector groups (Dunne & Shneiderman 2013, "connector motif"): neighbours of
 * the node that are linked to exactly the same set of other nodes besides it —
 * e.g. 8 partners of Aurora who are all partners of Holding 3 as well. Only
 * neighbours with another link qualify (leaves are the other answer), groups of
 * at least `min`, largest first.
 */
export interface ConnectorGroup {
  /** The nodes they all share, besides the node itself (sorted). */
  sharedIds: string[];
  /** The neighbours in the group (sorted). */
  memberIds: string[];
}

export function connectorGroups(
  nodeId: string,
  edges: readonly Pick<Edge, 'src' | 'dst'>[],
  min = 3,
): ConnectorGroup[] {
  const neighbours = new Set<string>();
  for (const e of edges) {
    if (e.src === e.dst) continue;
    if (e.src === nodeId) neighbours.add(e.dst);
    else if (e.dst === nodeId) neighbours.add(e.src);
  }
  const others = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.src === e.dst) continue;
    for (const [a, b] of [[e.src, e.dst], [e.dst, e.src]] as const) {
      if (!neighbours.has(a) || b === nodeId) continue;
      let set = others.get(a);
      if (!set) others.set(a, (set = new Set()));
      set.add(b);
    }
  }
  const groups = new Map<string, ConnectorGroup>();
  for (const [member, set] of others) {
    const shared = [...set].sort();
    const key = shared.join('\u0000');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { sharedIds: shared, memberIds: [] }));
    g.memberIds.push(member);
  }
  return [...groups.values()]
    .filter((g) => g.memberIds.length >= min)
    .map((g) => ({ ...g, memberIds: g.memberIds.sort() }))
    .sort((a, b) => b.memberIds.length - a.memberIds.length || a.sharedIds.join().localeCompare(b.sharedIds.join()));
}
