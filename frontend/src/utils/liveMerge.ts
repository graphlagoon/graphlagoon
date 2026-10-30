/**
 * Live refresh of an open exploration: a three-way merge of what the server now
 * saves (an agent edited it, another tab saved) into what is on the canvas.
 *
 * `base` is what the page last knew the server had (fingerprints of the saved
 * snapshot, taken on load, on every own save and on every merge). Only what
 * moved between `base` and the remote snapshot is touched: added, removed and
 * changed nodes and edges. Everything else on the canvas — node objects and
 * their positions, nodes the person expanded and has not saved — stays as is.
 */
import type { Edge, ExplorationLastChange, GraphSnapshot, Node } from '@/types/graph';

export interface Fingerprints {
  nodes: Map<string, string>;
  edges: Map<string, string>;
}

export interface SnapshotDiff {
  addedNodes: Node[];
  /** Nodes whose type or properties moved: the remote copy. */
  changedNodes: Node[];
  removedNodeIds: Set<string>;
  addedEdges: Edge[];
  changedEdges: Edge[];
  removedEdgeIds: Set<string>;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`;
}

export function emptyFingerprints(): Fingerprints {
  return { nodes: new Map(), edges: new Map() };
}

/** What identifies the content of each node and edge of a saved snapshot (positions excluded). */
export function fingerprints(snapshot: Pick<GraphSnapshot, 'nodes' | 'edges'> | null | undefined): Fingerprints {
  const out = emptyFingerprints();
  for (const n of snapshot?.nodes ?? []) out.nodes.set(n.id, stable([n.type, n.properties ?? {}]));
  for (const e of snapshot?.edges ?? []) out.edges.set(e.id, stable([e.source, e.target, e.type, e.properties ?? {}]));
  return out;
}

export function diffSnapshot(base: Fingerprints, remote: Pick<GraphSnapshot, 'nodes' | 'edges'>): SnapshotDiff {
  const now = fingerprints(remote);
  const diff: SnapshotDiff = {
    addedNodes: [],
    changedNodes: [],
    removedNodeIds: new Set([...base.nodes.keys()].filter((id) => !now.nodes.has(id))),
    addedEdges: [],
    changedEdges: [],
    removedEdgeIds: new Set([...base.edges.keys()].filter((id) => !now.edges.has(id))),
  };
  for (const n of remote.nodes) {
    const node: Node = { node_id: n.id, node_type: n.type, properties: { ...(n.properties ?? {}) } };
    if (typeof n.x === 'number') node.x = n.x;
    if (typeof n.y === 'number') node.y = n.y;
    const before = base.nodes.get(n.id);
    if (before === undefined) diff.addedNodes.push(node);
    else if (before !== now.nodes.get(n.id)) diff.changedNodes.push(node);
  }
  for (const e of remote.edges) {
    const edge: Edge = { edge_id: e.id, src: e.source, dst: e.target, relationship_type: e.type, properties: { ...(e.properties ?? {}) } };
    const before = base.edges.get(e.id);
    if (before === undefined) diff.addedEdges.push(edge);
    else if (before !== now.edges.get(e.id)) diff.changedEdges.push(edge);
  }
  return diff;
}

export function isEmptyDiff(d: SnapshotDiff): boolean {
  return !(d.addedNodes.length || d.changedNodes.length || d.removedNodeIds.size || d.addedEdges.length || d.changedEdges.length || d.removedEdgeIds.size);
}

/**
 * The canvas after the diff: removed nodes (with their edges) and edges leave,
 * added ones join — or, already on the canvas, count as changed — and changed
 * edges are replaced. Changed nodes are NOT replaced (their objects carry the
 * layout): `patch` holds their new properties for the store to apply in place,
 * and their new type is set on the object.
 */
export function applyDiff(
  nodes: Node[],
  edges: Edge[],
  diff: SnapshotDiff,
): { nodes: Node[]; edges: Edge[]; patch: Map<string, Record<string, unknown>> } {
  const patch = new Map<string, Record<string, unknown>>();
  const keptNodes = nodes.filter((n) => !diff.removedNodeIds.has(n.node_id));
  const byId = new Map(keptNodes.map((n) => [n.node_id, n]));
  const outNodes = [...keptNodes];
  for (const remote of [...diff.changedNodes, ...diff.addedNodes]) {
    const local = byId.get(remote.node_id);
    if (local) {
      if (local.node_type !== remote.node_type) local.node_type = remote.node_type;
      patch.set(remote.node_id, remote.properties ?? {});
    } else if (diff.addedNodes.includes(remote)) {
      outNodes.push(remote);
      byId.set(remote.node_id, remote);
    }
  }
  const replaced = new Map([...diff.changedEdges, ...diff.addedEdges].map((e) => [e.edge_id, e]));
  const outEdges: Edge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (diff.removedEdgeIds.has(e.edge_id) || diff.removedNodeIds.has(e.src) || diff.removedNodeIds.has(e.dst)) continue;
    outEdges.push(replaced.get(e.edge_id) ?? e);
    seen.add(e.edge_id);
  }
  for (const e of diff.addedEdges) {
    if (!seen.has(e.edge_id) && byId.has(e.src) && byId.has(e.dst)) outEdges.push(e);
  }
  return { nodes: outNodes, edges: outEdges, patch };
}

/** "+3 nodes, −1 edge, 2 changed" for a toast; empty when nothing moved. */
export function describeSummary(summary: ExplorationLastChange['summary']): string {
  if (!summary) return '';
  const part = (n: number | undefined, sign: string, one: string, many: string) =>
    n ? `${sign}${n} ${n === 1 ? one : many}` : '';
  const changed = (summary.updated_nodes ?? 0) + (summary.updated_edges ?? 0);
  return [
    part(summary.added_nodes, '+', 'node', 'nodes'),
    part(summary.removed_nodes, '−', 'node', 'nodes'),
    part(summary.added_edges, '+', 'edge', 'edges'),
    part(summary.removed_edges, '−', 'edge', 'edges'),
    changed ? `${changed} changed` : '',
  ].filter(Boolean).join(', ');
}
