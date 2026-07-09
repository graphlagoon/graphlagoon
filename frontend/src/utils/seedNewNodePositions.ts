/**
 * Seed positions for nodes that entered the graph incrementally (e.g. "expand
 * from node") so they render next to their anchor instead of triggering a
 * global layout reheat.
 *
 * Every node whose id is missing from `knownPositions` is placed at a random
 * offset (within `radius`) around a positioned neighbor and PINNED
 * (fx/fy/fz), leaving all existing positions untouched. Multi-pass so a
 * depth-2 expansion chains: ring-2 nodes anchor on the ring-1 seeds placed in
 * the previous pass. New nodes with no positioned neighbor at all (rare) fall
 * back to the centroid of the known positions plus jitter.
 *
 * Pure (no Vue/Three imports) — used by GraphCanvas3D's updateGraph on large
 * graphs only; small graphs keep the exact global re-layout behavior.
 */

export interface SeedableNode {
  id: string;
  x?: number;
  y?: number;
  z?: number;
  fx?: number | null;
  fy?: number | null;
  fz?: number | null;
}

export interface SeedableLink {
  /** Node id (buildGraphData emits string endpoints; the 3D lib only swaps
   * them for node objects after graphData() ingests the array). */
  source: string;
  target: string;
}

export interface SeedOptions {
  /** Max distance from the anchor neighbor. */
  radius?: number;
  /** 2D-projection mode: z is forced to 0. */
  is2D?: boolean;
}

interface Position { x: number; y: number; z: number }

function jitter(radius: number): number {
  return (Math.random() - 0.5) * 2 * radius;
}

export function seedNewNodePositions(
  nodes: SeedableNode[],
  links: SeedableLink[],
  knownPositions: Map<string, Position>,
  opts: SeedOptions = {},
): void {
  const radius = opts.radius ?? 40;
  const is2D = opts.is2D ?? false;

  // Positions resolved so far: existing ones plus seeds from earlier passes.
  const resolved = new Map<string, Position>(knownPositions);

  const pending = nodes.filter(n => !resolved.has(n.id));
  if (pending.length === 0) return;

  // Adjacency restricted to pending nodes (both directions).
  const neighbors = new Map<string, string[]>();
  const pendingIds = new Set(pending.map(n => n.id));
  for (const link of links) {
    if (pendingIds.has(link.source)) {
      let list = neighbors.get(link.source);
      if (!list) { list = []; neighbors.set(link.source, list); }
      list.push(link.target);
    }
    if (pendingIds.has(link.target)) {
      let list = neighbors.get(link.target);
      if (!list) { list = []; neighbors.set(link.target, list); }
      list.push(link.source);
    }
  }

  const place = (node: SeedableNode, around: Position) => {
    const pos: Position = {
      x: around.x + jitter(radius),
      y: around.y + jitter(radius),
      z: is2D ? 0 : around.z + jitter(radius),
    };
    node.x = pos.x;
    node.y = pos.y;
    node.z = pos.z;
    node.fx = pos.x;
    node.fy = pos.y;
    node.fz = pos.z;
    resolved.set(node.id, pos);
  };

  // Multi-pass: each pass places every pending node that has a resolved
  // neighbor; seeds from this pass anchor the next ring in the next pass.
  let remaining = pending;
  while (remaining.length > 0) {
    const next: SeedableNode[] = [];
    for (const node of remaining) {
      const anchorId = neighbors.get(node.id)?.find(id => resolved.has(id));
      if (anchorId) place(node, resolved.get(anchorId)!);
      else next.push(node);
    }
    if (next.length === remaining.length) break; // no progress — disconnected rest
    remaining = next;
  }

  // Fallback: no positioned neighbor anywhere (isolated additions) — centroid
  // of the known layout plus jitter, so they at least appear in-frame.
  if (remaining.length > 0) {
    let cx = 0, cy = 0, cz = 0, count = 0;
    for (const p of knownPositions.values()) {
      cx += p.x; cy += p.y; cz += p.z; count++;
    }
    const centroid: Position = count > 0
      ? { x: cx / count, y: cy / count, z: cz / count }
      : { x: 0, y: 0, z: 0 };
    for (const node of remaining) place(node, centroid);
  }
}
