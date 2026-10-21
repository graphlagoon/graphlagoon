/**
 * The user's layer of an exploration (BYOD-2): nodes and edges the person added (by hand,
 * from a mapped file or from JSON) and enrichment files that add properties to what the
 * context returned. Saved beside the exploration's snapshot, never inside it: the context's
 * data stays as the context gave it, and the layer is re-applied after every query, expand
 * or reload. Pure; the graph store owns the state.
 *
 * Bookkeeping is by object, not by id: a fresh query returns new node objects with the same
 * ids, and those must never be "restored" from what the layer wrote on the old ones.
 */
import { toRaw } from 'vue';
import type { Edge, GraphSnapshot, Node } from '@/types/graph';
import type { FileEnrichmentSpec } from '@/types/investigation';
import { matchFileRows, type FileRow, type FileRows } from '@/utils/enrichment';

export interface OverlayNode {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  x?: number | null;
  y?: number | null;
}

export interface OverlayEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  properties: Record<string, unknown>;
}

/** An enrichment file as the layer keeps it: the parsed rows (first per key), not the file. */
export interface OverlayEnrichment {
  id: string;
  filename: string;
  spec: FileEnrichmentSpec;
  rows: FileRows;
  row_count: number;
}

/** Where a group of the layer's nodes and edges came from, so it can be removed as one. */
export interface OverlayImport {
  id: string;
  filename: string;
  title: string;
  kind: 'mapping' | 'json';
  node_ids: string[];
  edge_ids: string[];
  report?: Record<string, unknown> | null;
}

export interface GraphOverlay {
  version: 1;
  nodes: OverlayNode[];
  edges: OverlayEdge[];
  enrichments: OverlayEnrichment[];
  imports: OverlayImport[];
}

/** Ids of the layer's nodes and edges that are drawn by hand get this prefix. */
export const SKETCH_PREFIX = 'sketch:';
/** Edges of an import are namespaced so they never collide with the context's edge ids. */
export const importEdgeId = (importId: string, edgeId: string) => `import:${importId}:${edgeId}`;

/** A short unique id; `crypto.randomUUID` is missing on plain-http origins. */
export function newOverlayId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID().slice(0, 12);
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyOverlay(): GraphOverlay {
  return { version: 1, nodes: [], edges: [], enrichments: [], imports: [] };
}

export function isEmptyOverlay(o: GraphOverlay | null | undefined): boolean {
  return !o || (o.nodes.length === 0 && o.edges.length === 0 && o.enrichments.length === 0);
}

type Bag = { properties?: Record<string, unknown> };
type Written = Map<string, { prev: unknown; had: boolean }>;

/** What the layer did to the graph currently drawn. */
export interface OverlayState {
  /** Per base node/edge object: each property the layer wrote, and the value before. */
  written: WeakMap<object, Written>;
  /** Node and edge objects the layer added (not in the context's answer). */
  added: WeakSet<object>;
  /** Whether anything was written or added (nothing to undo otherwise). */
  active: boolean;
}

export function emptyOverlayState(): OverlayState {
  return { written: new WeakMap(), added: new WeakSet(), active: false };
}

const isMissing = (v: unknown) => v === null || v === undefined;
/** The store hands reactive proxies and raw objects alike: bookkeeping keys on the raw one. */
const raw = <T extends object>(o: T): T => toRaw(o);

/** The ring color of the layer's nodes outside a case. */
export const OVERLAY_RING_COLOR = '#f59e0b';

/**
 * Merges `props` into `target` the way the case graph does, recording what it replaced: a
 * missing value is filled; one already there wins unless `overwrite`. The properties object
 * is replaced, never mutated, so anything holding the old one keeps it.
 */
function write(target: Bag, props: Record<string, unknown>, overwrite: boolean, state: OverlayState): number {
  const current = { ...(target.properties ?? {}) };
  let entry = state.written.get(raw(target));
  let changed = 0;
  for (const [k, v] of Object.entries(props)) {
    if (isMissing(v)) continue;
    const old = current[k];
    if (!isMissing(old) && (!overwrite || old === v)) continue;
    if (!entry) {
      entry = new Map();
      state.written.set(raw(target), entry);
    }
    if (!entry.has(k)) entry.set(k, { prev: old, had: k in current });
    current[k] = v;
    changed++;
  }
  if (changed) {
    target.properties = current;
    state.active = true;
  }
  return changed;
}

/** Puts back what the layer wrote on `target` (its properties object is replaced). */
export function undoOverlay(target: Bag, state: OverlayState): void {
  const entry = state.written.get(raw(target));
  if (!entry) return;
  target.properties = restored(target.properties, entry);
  state.written.delete(raw(target));
}

function restored(props: Record<string, unknown> | undefined, entry: Written): Record<string, unknown> {
  const out = { ...(props ?? {}) };
  for (const [k, { prev, had }] of entry) {
    if (had) out[k] = prev;
    else delete out[k];
  }
  return out;
}

function enrichmentTargetIsNodes(f: OverlayEnrichment) {
  return (f.spec.target ?? 'nodes') === 'nodes';
}

/** Writes the layer's node properties and node enrichments on `targets`. */
function enrichNodes(targets: Node[], overlay: GraphOverlay, state: OverlayState) {
  const byId = new Map(overlay.nodes.map((o) => [o.id, o]));
  for (const n of targets) {
    const own = byId.get(n.node_id);
    if (own && !state.added.has(raw(n))) write(n, own.properties, false, state);
  }
  for (const f of overlay.enrichments) {
    if (!enrichmentTargetIsNodes(f)) continue;
    const rows = matchFileRows({ nodes: targets, edges: [] }, f.spec, f.rows);
    for (const n of targets) {
      const row = rows.get(n.node_id);
      if (row) write(n, row, !!f.spec.overwrite, state);
    }
  }
}

/**
 * The graph with the layer on it. Idempotent: whatever the layer did before is undone first
 * (so passing an already-layered graph back in is safe, as `expandFromNode` does). Nodes of
 * the layer whose id the context already returned merge into it; the others are added, and
 * the layer's edges are drawn when both endpoints are on the canvas.
 */
export function applyOverlay(
  nodes: Node[],
  edges: Edge[],
  overlay: GraphOverlay | null,
  state: OverlayState,
): { nodes: Node[]; edges: Edge[]; state: OverlayState } {
  const baseNodes = state.active ? nodes.filter((n) => !state.added.has(raw(n))) : nodes;
  const baseEdges = state.active ? edges.filter((e) => !state.added.has(raw(e))) : edges;
  if (state.active) {
    for (const n of baseNodes) undoOverlay(n, state);
    for (const e of baseEdges) undoOverlay(e, state);
  }
  const next = emptyOverlayState();
  if (!overlay || isEmptyOverlay(overlay)) return { nodes: baseNodes, edges: baseEdges, state: next };

  const outNodes = [...baseNodes];
  const byId = new Map(baseNodes.map((n) => [n.node_id, n]));
  for (const o of overlay.nodes) {
    if (byId.has(o.id)) continue; // merged in enrichNodes, with the bookkeeping
    const n: Node = { node_id: o.id, node_type: o.type, properties: { ...o.properties } };
    if (typeof o.x === 'number') n.x = o.x;
    if (typeof o.y === 'number') n.y = o.y;
    next.added.add(n);
    next.active = true;
    outNodes.push(n);
    byId.set(o.id, n);
  }
  const outEdges = [...baseEdges];
  const edgeIds = new Set(baseEdges.map((e) => e.edge_id));
  for (const o of overlay.edges) {
    // An endpoint not on the canvas (another query) leaves the edge in the layer, undrawn.
    if (edgeIds.has(o.id) || !byId.has(o.source) || !byId.has(o.target)) continue;
    const e: Edge = { edge_id: o.id, src: o.source, dst: o.target, relationship_type: o.type, properties: { ...o.properties } };
    next.added.add(e);
    next.active = true;
    outEdges.push(e);
    edgeIds.add(o.id);
  }

  const graph = { nodes: outNodes, edges: outEdges };
  enrichNodes(outNodes, overlay, next);
  for (const f of overlay.enrichments) {
    if (enrichmentTargetIsNodes(f)) continue;
    const rows = matchFileRows(graph, f.spec, f.rows);
    for (const e of outEdges) {
      const row = rows.get(e.edge_id);
      if (row) write(e, row, !!f.spec.overwrite, next);
    }
  }
  return { ...graph, state: next };
}

/**
 * Re-applies the layer to nodes whose properties were just replaced (background property
 * loading, "save as property"): `beforePatch` undoes, the caller patches, `afterPatch`
 * writes again. Edges are left as they are.
 */
export function beforePatch(targets: Node[], state: OverlayState): void {
  if (state.active) for (const n of targets) undoOverlay(n, state);
}

export function afterPatch(targets: Node[], overlay: GraphOverlay | null, state: OverlayState): void {
  if (!overlay || isEmptyOverlay(overlay) || !targets.length) return;
  enrichNodes(targets, overlay, state);
}

/** The graph as the context gave it: the layer's nodes and edges left out, its values put back. */
export function baseGraphOf(nodes: Node[], edges: Edge[], state: OverlayState): { nodes: Node[]; edges: Edge[] } {
  if (!state.active) return { nodes, edges };
  const clean = <T extends Bag>(o: T): T => {
    const entry = state.written.get(raw(o));
    return entry ? { ...o, properties: restored(o.properties, entry) } : o;
  };
  return {
    nodes: nodes.filter((n) => !state.added.has(raw(n))).map(clean),
    edges: edges.filter((e) => !state.added.has(raw(e))).map(clean),
  };
}

/** Which properties of this node or edge came from the layer (the side panel's chip). */
export function overlayKeysOf(target: object, state: OverlayState): Set<string> {
  return new Set(state.written.get(raw(target))?.keys() ?? []);
}

export function isOverlayAdded(target: object, state: OverlayState): boolean {
  return state.added.has(raw(target));
}

// ---------------------------------------------------------------------------
// Building the layer
// ---------------------------------------------------------------------------

/** First row per key: all the layer ever uses, so it is all it keeps. */
export function firstRows(rows: FileRows): Record<string, [FileRow]> {
  return Object.fromEntries(Object.entries(rows).filter(([, r]) => r.length).map(([k, r]) => [k, [r[0]]]));
}

/** A snapshot (`{nodes, edges}` JSON) as layer nodes and edges, ids of edges namespaced. */
export function overlayFromSnapshot(importId: string, snap: GraphSnapshot): { nodes: OverlayNode[]; edges: OverlayEdge[] } {
  return {
    nodes: snap.nodes.map((n) => ({ id: String(n.id), type: String(n.type), properties: { ...(n.properties ?? {}) } })),
    edges: snap.edges.map((e) => ({
      id: importEdgeId(importId, String(e.id)),
      source: String(e.source),
      target: String(e.target),
      type: String(e.type),
      properties: { ...(e.properties ?? {}) },
    })),
  };
}

/** Pasted or uploaded JSON as a snapshot, or an error a person can act on. */
export function parseSnapshotJson(text: string): { snapshot: GraphSnapshot | null; error: string | null } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { snapshot: null, error: 'This is not valid JSON.' };
  }
  const d = data as { nodes?: unknown; edges?: unknown };
  if (!d || typeof d !== 'object' || !Array.isArray(d.nodes)) return { snapshot: null, error: 'Expected {"nodes": [...], "edges": [...]}.' };
  const edgesIn = Array.isArray(d.edges) ? d.edges : [];
  for (const [i, n] of (d.nodes as Record<string, unknown>[]).entries()) {
    if (!n || typeof n !== 'object' || isMissing(n.id) || isMissing(n.type)) return { snapshot: null, error: `Node ${i + 1} needs an "id" and a "type".` };
  }
  for (const [i, e] of (edgesIn as Record<string, unknown>[]).entries()) {
    if (!e || typeof e !== 'object' || isMissing(e.source) || isMissing(e.target) || isMissing(e.type)) {
      return { snapshot: null, error: `Edge ${i + 1} needs "source", "target" and "type".` };
    }
  }
  return {
    snapshot: {
      nodes: (d.nodes as Record<string, unknown>[]).map((n) => ({
        id: String(n.id),
        type: String(n.type),
        properties: (n.properties as Record<string, unknown>) ?? {},
      })),
      edges: (edgesIn as Record<string, unknown>[]).map((e, i) => ({
        id: String(e.id ?? `e${i + 1}`),
        source: String(e.source),
        target: String(e.target),
        type: String(e.type),
        properties: (e.properties as Record<string, unknown>) ?? {},
      })),
    } as GraphSnapshot,
    error: null,
  };
}
