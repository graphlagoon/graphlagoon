/**
 * Headless force-layout settling.
 *
 * For large graphs, animating the force simulation frame-by-frame is expensive:
 * 3d-force-graph re-renders the whole scene every rAF frame, so the settling
 * costs ~cooldownTicks/ticksPerFrame full renders of a huge scene. This module
 * runs the *same* force simulation OFF the render loop — ticking d3-force-3d in
 * async chunks (main thread stays responsive) until it converges — so the graph
 * can be rendered once, already settled.
 *
 * The forces mirror what applyForceConfig() configures on the live engine
 * (see forceConfig3D.ts) so the resulting layout matches the animated path.
 */
import {
  forceSimulation as _forceSimulation,
  forceLink as _forceLink,
  forceManyBody as _forceManyBody,
  forceCenter as _forceCenter,
  forceX as _forceX,
  forceY as _forceY,
  forceZ as _forceZ,
  forceCollide as _forceCollide,
} from 'd3-force-3d';
import type { Force3DSettings } from './forceConfig3D';

// d3-force-3d ships no type declarations (vite aliases it to the JS submodule),
// so the imports come in as `unknown`. Re-type them loosely to call them.
/* eslint-disable @typescript-eslint/no-explicit-any */
const forceSimulation = _forceSimulation as (nodes: unknown[], numDim?: number) => any;
const forceLink = _forceLink as (links: unknown[]) => any;
const forceManyBody = _forceManyBody as () => any;
const forceCenter = _forceCenter as (x?: number, y?: number, z?: number) => any;
const forceX = _forceX as (x?: number) => any;
const forceY = _forceY as (y?: number) => any;
const forceZ = _forceZ as (z?: number) => any;
const forceCollide = _forceCollide as () => any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface SettleNode {
  id: string;
  size?: number;
  x?: number;
  y?: number;
  z?: number;
}

export interface SettleLink {
  // Usually a node id string; d3's forceLink also accepts a resolved node ref.
  source: string | { id: string };
  target: string | { id: string };
}

export interface SettleOptions {
  /** 2 or 3 dimensions (matches the engine's numDimensions). Default 2. */
  numDimensions?: 2 | 3;
  /** nodeRelSize used by the collide radius (matches applyForceConfig). Default 4. */
  nodeRelSize?: number;
  /** Hard cap on ticks (safety). Default derived from alphaDecay, min 300. */
  maxTicks?: number;
  /** Ticks to run per async chunk before yielding. Default 20. */
  ticksPerChunk?: number;
  /** Progress callback in [0, 1]. */
  onProgress?: (fraction: number) => void;
  /** Yield between chunks. Default: macrotask (setTimeout 0). Injectable for tests. */
  yieldToEventLoop?: () => Promise<void>;
  /** Abort signal: if it returns true between chunks, settling stops early. */
  shouldAbort?: () => boolean;
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Settle a force layout headlessly (no rendering). Mutates each node's x/y/z in
 * place with the final positions. Links are NOT mutated (a private copy is used,
 * because d3's forceLink rewrites link.source/target to node objects).
 *
 * @returns the number of ticks actually run.
 */
export async function settleLayoutHeadless(
  nodes: SettleNode[],
  links: SettleLink[],
  settings: Force3DSettings,
  opts: SettleOptions = {},
): Promise<number> {
  const numDim = opts.numDimensions ?? 2;
  const relSize = opts.nodeRelSize ?? 4;
  const ticksPerChunk = Math.max(1, opts.ticksPerChunk ?? 20);
  const yieldFn = opts.yieldToEventLoop ?? defaultYield;

  if (nodes.length === 0) {
    opts.onProgress?.(1);
    return 0;
  }

  // Private link copies: forceLink mutates source/target into node refs, and we
  // must not corrupt the caller's GraphLink objects (the renderer reads them).
  const simLinks = links.map((l) => ({ source: l.source, target: l.target }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sim: any = forceSimulation(nodes as any, numDim)
    .force(
      'link',
      forceLink(simLinks)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .id((n: any) => n.id)
        .distance(settings.d3LinkDistance),
    )
    .force(
      'charge',
      forceManyBody()
        .strength(settings.d3ChargeStrength)
        .theta(settings.d3Theta)
        .distanceMin(settings.d3DistanceMin)
        .distanceMax(settings.d3DistanceMax),
    )
    .force('center', forceCenter(0, 0, 0).strength(settings.d3CenterStrength))
    .alphaDecay(settings.d3AlphaDecay)
    .velocityDecay(settings.d3VelocityDecay)
    .alphaMin(settings.d3AlphaMin)
    .stop(); // we tick manually; don't let the internal timer run

  // Gravity toward origin (keeps disconnected components together).
  if (settings.d3GravityStrength > 0) {
    sim.force('gravityX', forceX(0).strength(settings.d3GravityStrength));
    sim.force('gravityY', forceY(0).strength(settings.d3GravityStrength));
    if (numDim > 2) {
      sim.force('gravityZ', forceZ(0).strength(settings.d3GravityStrength));
    }
  }

  // Collide (prevents node overlap) — same radius formula as applyForceConfig.
  if (settings.d3CollideEnabled) {
    sim.force(
      'collide',
      forceCollide()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .radius((n: any) =>
          Math.max(settings.d3CollideRadius, Math.cbrt(n.size ?? 1) * relSize),
        )
        .strength(settings.d3CollideStrength)
        .iterations(settings.d3CollideIterations),
    );
  }

  // Estimate total ticks for progress: alpha *= (1 - alphaDecay) each tick,
  // stops when alpha < alphaMin ⇒ n ≈ ln(alphaMin) / ln(1 - alphaDecay).
  const alphaMin = settings.d3AlphaMin > 0 ? settings.d3AlphaMin : 0.001;
  const decay = settings.d3AlphaDecay > 0 ? settings.d3AlphaDecay : 0.0228;
  const estTotal = Math.max(
    1,
    Math.ceil(Math.log(alphaMin) / Math.log(1 - decay)),
  );
  const maxTicks = opts.maxTicks ?? Math.max(estTotal, 300);

  let ticks = 0;
  while (sim.alpha() > alphaMin && ticks < maxTicks) {
    if (opts.shouldAbort?.()) break;
    const n = Math.min(ticksPerChunk, maxTicks - ticks);
    sim.tick(n);
    ticks += n;
    opts.onProgress?.(Math.min(1, ticks / estTotal));
    await yieldFn();
  }

  opts.onProgress?.(1);
  return ticks;
}
