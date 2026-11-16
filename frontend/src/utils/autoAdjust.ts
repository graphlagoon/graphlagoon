/**
 * Automatic adjustments: the layout helpers that decide by themselves, from the
 * shape of the loaded graph, whether to act. Each one is a setting whose value
 * can be 'auto' (the default), next to its fixed values; `behaviors.autoAdjust`
 * (default on) is the master switch — off, every 'auto' means its fallback.
 *
 *   setting                              acts when                              fallback
 *   behaviors.hubLeaves 'auto'           a node has >= hubLeavesMinLeaves       free
 *                                        leaves (default 30); per hub: petals
 *                                        if a key splits them, else crown
 *   behaviors.hubLeavesRevealByZoom      an arranged hub has >=                 show all
 *     'auto'                             AUTO_REVEAL_MIN_LEAVES leaves
 *   layoutModeConfig.ego.ringOrdering    ring 1 has >= EGO_CROWDED_RING nodes,  barycenter
 *     'auto'                             most of them leaves, and a key splits
 *                                        them: sectors by that key
 *
 * A decision is never written back into the settings (that would dirty every
 * exploration): it lives in derived stats (hubLeavesStats, egoLayoutStats) and
 * is recomputed with the layout. All functions here are pure.
 */
import { AUTO_PETALS_MIN_SCORE, scoreKey, type HubLeafRegion, type HubLeavesMode } from '@/utils/hubLeaves';

export { AUTO_PETALS_MIN_SCORE };

/**
 * Default of behaviors.hubLeavesMinLeaves: from this many leaves on, a hub is
 * arranged. Same number as the degree-dim threshold (`degreeDimThreshold`):
 * below it the force layout still shows each leaf and its label.
 */
export const AUTO_HUB_MIN_LEAVES = 30;
/**
 * Reveal-on-zoom 'auto': only hubs this large. At fit zoom their leaves are a
 * pixel or two apart, so the outer ones are noise (and cost frames); smaller
 * hubs keep every leaf drawn.
 */
export const AUTO_REVEAL_MIN_LEAVES = 2000;
/** Ego: a ring 1 with this many nodes is "crowded" (panel hint, automatic sectors). */
export const EGO_CROWDED_RING = 80;
/** Ego 'auto': sectors only when at least this share of ring 1 is leaves — otherwise crossings matter more. */
export const EGO_AUTO_MIN_LEAF_SHARE = 0.5;

export type RevealByZoomMode = 'auto' | 'on' | 'off';

/** The hub-leaves mode in force: 'auto' with the master switch off is 'free'. */
export function resolveHubLeavesMode(b: { hubLeaves: HubLeavesMode; autoAdjust: boolean }): HubLeavesMode {
  return b.hubLeaves === 'auto' && !b.autoAdjust ? 'free' : b.hubLeaves;
}

/**
 * Which regions reveal-on-zoom applies to, as a flag per region (plan.regions
 * order): all ('on'), none ('off'), or those of hubs with at least
 * AUTO_REVEAL_MIN_LEAVES leaves ('auto', master switch on).
 */
export function revealRegions(regions: HubLeafRegion[], mode: RevealByZoomMode, autoAdjust: boolean): boolean[] {
  if (mode === 'on') return regions.map(() => true);
  if (mode === 'off' || !autoAdjust) return regions.map(() => false);
  const leavesByHub = new Map<string, number>();
  for (const r of regions) leavesByHub.set(r.hub, (leavesByHub.get(r.hub) ?? 0) + r.count);
  return regions.map((r) => (leavesByHub.get(r.hub) ?? 0) >= AUTO_REVEAL_MIN_LEAVES);
}

export type EgoAutoOrdering =
  | { ordering: 'barycenter'; reason: string }
  | { ordering: 'node-type'; reason: string }
  | { ordering: 'property'; key: string; reason: string };

/**
 * Ego ring ordering 'auto'. A crowded ring 1 made mostly of leaves has no
 * crossings worth minimising — its angle is free to carry a meaning — so it is
 * ordered in sectors by the key that splits it best (same score as the petals).
 * Otherwise: fewest crossings, the layout's long-standing default.
 */
export function chooseEgoOrdering(input: {
  /** Nodes one hop from the focus. */
  ring1: { id: string; nodeType: string; properties?: Record<string, unknown> | null }[];
  /** Of those, the ones linked to nothing but the focus. */
  leafIds: ReadonlySet<string>;
}): EgoAutoOrdering {
  const n = input.ring1.length;
  if (n < EGO_CROWDED_RING) return { ordering: 'barycenter', reason: `ring 1 has ${n} nodes (sectors from ${EGO_CROWDED_RING})` };
  const leaves = input.ring1.filter((r) => input.leafIds.has(r.id)).length;
  if (leaves < n * EGO_AUTO_MIN_LEAF_SHARE) {
    return { ordering: 'barycenter', reason: `only ${leaves} of the ${n} nodes on ring 1 are leaves` };
  }
  const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
  const keys = new Set<string>();
  for (const r of input.ring1) for (const k of Object.keys(r.properties ?? {})) keys.add(k);
  let best: EgoAutoOrdering | null = null;
  let bestScore = 0;
  const consider = (score: number, make: () => EgoAutoOrdering) => {
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = make();
    }
  };
  const why = `ring 1 has ${n} nodes, ${leaves} of them leaves`;
  consider(scoreKey(input.ring1.map((r) => str(r.nodeType))), () => ({ ordering: 'node-type', reason: why }));
  for (const key of [...keys].sort()) {
    consider(scoreKey(input.ring1.map((r) => str(r.properties?.[key]))), () => ({ ordering: 'property', key, reason: why }));
  }
  if (!best || bestScore < AUTO_PETALS_MIN_SCORE) {
    return { ordering: 'barycenter', reason: `no type or property splits the ${n} nodes on ring 1` };
  }
  return best;
}
