/**
 * Apply D3-force-3d configuration to a 3d-force-graph instance.
 *
 * This function encapsulates the force configuration logic that was
 * previously duplicated in initGraph(), updateGraph(), and the
 * force3DSettings watcher inside GraphCanvas3D.vue.
 */
import { forceCollide, forceX, forceY, forceZ } from 'd3-force-3d';

/**
 * Parameters computed adaptively based on graph size to optimize layout
 * convergence and rendering performance for large graphs.
 */
export interface AdaptiveLayoutParams {
  warmupTicks: number;
  cooldownTicks: number;
  ticksPerFrame: number;
  forceOverrides: Partial<Force3DSettings>;
}

/**
 * Compute layout parameters adapted to the graph size.
 *
 * Small graphs (<500 elements) use defaults.
 * Medium graphs (500-3000) get moderate batch ticking and theta increase.
 * Large graphs (3000-10000) get aggressive batch ticking, warmup, and faster convergence.
 * Very large graphs (>10000) get maximum optimization.
 */
export function computeAdaptiveLayoutParams(
  nodeCount: number,
  edgeCount: number,
): AdaptiveLayoutParams {
  const total = nodeCount + edgeCount;

  if (total < 500) {
    return {
      warmupTicks: 0,
      cooldownTicks: 100,
      ticksPerFrame: 1,
      forceOverrides: {},
    };
  }

  // Warmup ticks run SYNCHRONOUSLY before the first paint, and each tick costs
  // roughly O(total). Fixed per-bucket warmup counts made huge graphs block for
  // a long time (150 ticks x tens of thousands of elements). Instead we bound
  // the synchronous pre-paint WORK: warmupTicks scales DOWN as the graph grows,
  // so warmupTicks * total stays near a fixed budget. The animated cooldown
  // ticks below finish the settling without blocking the main thread.
  //
  // The upper cap stays high (150) because small graphs are cheap to warm up
  // (e.g. 150 ticks x 500 elements is trivial) and benefit from a well-settled
  // first paint; the budget only kicks in to shrink warmup for large graphs,
  // down to a floor of 20 ticks so even huge graphs get some pre-positioning.
  const WARMUP_WORK_BUDGET = 600_000; // ~node-ticks of synchronous pre-paint work
  const warmupTicks = Math.max(
    20,
    Math.min(150, Math.round(WARMUP_WORK_BUDGET / total)),
  );

  // ticksPerFrame batches simulation ticks per rendered frame. The animated
  // settling renders the whole scene ONCE PER FRAME, so the number of (costly,
  // for large scenes) renders during settling is ~cooldownTicks / ticksPerFrame.
  // Larger graphs get a higher ticksPerFrame so the same total settling ticks
  // run across far fewer rendered frames (e.g. 800/24 ~= 33 renders instead of
  // 800/10 = 80). Trade-off: each frame does more work (chunkier animation), but
  // total render overhead during settling drops sharply.
  if (total < 3000) {
    return {
      warmupTicks,
      cooldownTicks: 300,
      ticksPerFrame: 4,
      forceOverrides: {
        d3Theta: 1.2,
      },
    };
  }

  if (total < 10000) {
    return {
      warmupTicks,
      cooldownTicks: 500,
      ticksPerFrame: 12,
      forceOverrides: {
        d3Theta: 1.5,
        d3AlphaDecay: 0.04,
        d3VelocityDecay: 0.55,
      },
    };
  }

  // Very large graph: heavier animated settling, but the synchronous warmup
  // stays bounded (see WARMUP_WORK_BUDGET) so first paint isn't blocked.
  return {
    warmupTicks,
    cooldownTicks: 800,
    ticksPerFrame: 24,
    forceOverrides: {
      d3Theta: 1.7,
      d3AlphaDecay: 0.06,
      d3VelocityDecay: 0.6,
    },
  };
}

export interface Force3DSettings {
  d3AlphaDecay: number;
  d3VelocityDecay: number;
  d3AlphaMin: number;
  d3AlphaTarget: number;
  d3ChargeStrength: number;
  d3Theta: number;
  d3DistanceMin: number;
  d3DistanceMax: number;
  d3LinkDistance: number;
  d3CenterStrength: number;
  d3GravityStrength: number;
  d3CollideEnabled: boolean;
  d3CollideRadius: number;
  d3CollideStrength: number;
  d3CollideIterations: number;
  // Pointer repulsion (cylindrical blower) / attraction (vacuum)
  pointerRepulsionEnabled: boolean;
  pointerVacuumEnabled: boolean;
  pointerRepulsionStrength: number;
  pointerRepulsionRange: number;
  pointerSizeInertia: boolean;
  // Clipping plane
  clippingPlaneEnabled: boolean;
  clippingPlaneDistance: number;
}

/**
 * Apply all D3-force simulation settings to the graph instance.
 *
 * @param graph3d - The 3d-force-graph instance (typed as any because the
 *   library doesn't export precise types)
 * @param settings - The force simulation parameters
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyForceConfig(graph3d: any, settings: Force3DSettings, nodeRelSize?: number, is2D?: boolean): void {
  // Global simulation parameters
  graph3d
    .d3AlphaDecay(settings.d3AlphaDecay)
    .d3VelocityDecay(settings.d3VelocityDecay)
    .d3AlphaMin(settings.d3AlphaMin);

  // Set alphaTarget on the simulation directly (no wrapper method on graph3d)
  const simulation = graph3d.d3Force();
  if (simulation && typeof simulation.alphaTarget === 'function') {
    simulation.alphaTarget(settings.d3AlphaTarget);
  }

  // Charge force (node repulsion)
  const chargeForce = graph3d.d3Force('charge');
  if (chargeForce) {
    if (typeof chargeForce.strength === 'function') {
      chargeForce.strength(settings.d3ChargeStrength);
    }
    if (typeof chargeForce.theta === 'function') {
      chargeForce.theta(settings.d3Theta);
    }
    if (typeof chargeForce.distanceMin === 'function') {
      chargeForce.distanceMin(settings.d3DistanceMin);
    }
    if (typeof chargeForce.distanceMax === 'function') {
      chargeForce.distanceMax(settings.d3DistanceMax);
    }
  }

  // Link force (edge distance)
  const linkForce = graph3d.d3Force('link');
  if (linkForce && typeof linkForce.distance === 'function') {
    linkForce.distance(settings.d3LinkDistance);
  }

  // Center force
  const centerForce = graph3d.d3Force('center');
  if (centerForce && typeof centerForce.strength === 'function') {
    centerForce.strength(settings.d3CenterStrength);
  }

  // Gravity (positioning forces toward origin — keeps disconnected components together)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type D3PositionForce = { strength(s: number): any };
  if (settings.d3GravityStrength > 0) {
    const gx = (forceX(0) as D3PositionForce).strength(settings.d3GravityStrength);
    const gy = (forceY(0) as D3PositionForce).strength(settings.d3GravityStrength);
    graph3d.d3Force('gravityX', gx);
    graph3d.d3Force('gravityY', gy);
    if (is2D) {
      graph3d.d3Force('gravityZ', null);
    } else {
      const gz = (forceZ(0) as D3PositionForce).strength(settings.d3GravityStrength);
      graph3d.d3Force('gravityZ', gz);
    }
  } else {
    graph3d.d3Force('gravityX', null);
    graph3d.d3Force('gravityY', null);
    graph3d.d3Force('gravityZ', null);
  }

  // Collide force (optional - prevents node overlap)
  if (settings.d3CollideEnabled) {
    const minRadius = settings.d3CollideRadius;
    const relSize = nodeRelSize ?? 4;
    const collide = forceCollide()
      .radius((node: any) => Math.max(minRadius, Math.cbrt(node.size ?? 1) * relSize))
      .strength(settings.d3CollideStrength)
      .iterations(settings.d3CollideIterations);
    graph3d.d3Force('collide', collide);
  } else {
    graph3d.d3Force('collide', null);
  }
}

// ============================================================================
// Community Radial Layout
// ============================================================================

/**
 * Apply or remove community-based radial positioning forces.
 *
 * Each community is assigned a target (x, y) position based on its angle and
 * radius. Nodes are pulled toward their community's position using forceX/forceY.
 *
 * @param graph3d - The 3d-force-graph instance
 * @param communityMap - nodeId → communityId mapping
 * @param communityRadialConfig - communityId → { angle, radius } or null to remove
 * @param is2D - Whether the graph is in 2D projection mode
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyCommunityRadialForce(
  graph3d: any,
  communityMap: Map<string, number>,
  communityRadialConfig: Map<number, { angle: number; radius: number }> | null,
  is2D: boolean,
): void {
  if (!communityRadialConfig || communityMap.size === 0) {
    graph3d.d3Force('communityX', null);
    graph3d.d3Force('communityY', null);
    graph3d.d3Force('communityZ', null);
    return;
  }

  // Snapshot reactive Maps into plain Maps so d3 force closures read stable data
  const nodeCommMap = new Map(communityMap);
  const radialCfg = new Map(communityRadialConfig);

  // Pre-compute per-node target positions for O(1) lookup in the force tick
  const nodeTargetX = new Map<string, number>();
  const nodeTargetY = new Map<string, number>();
  for (const [nodeId, communityId] of nodeCommMap) {
    const cfg = radialCfg.get(communityId);
    if (cfg) {
      nodeTargetX.set(nodeId, Math.cos(cfg.angle) * cfg.radius);
      nodeTargetY.set(nodeId, Math.sin(cfg.angle) * cfg.radius);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type D3PositionForce = { strength(s: number): any };

  const STRENGTH = 0.5;

  const cx = (forceX((node: any) => nodeTargetX.get(node.id) ?? 0) as D3PositionForce).strength(STRENGTH);
  const cy = (forceY((node: any) => nodeTargetY.get(node.id) ?? 0) as D3PositionForce).strength(STRENGTH);

  graph3d.d3Force('communityX', cx);
  graph3d.d3Force('communityY', cy);

  if (is2D) {
    graph3d.d3Force('communityZ', null);
  } else {
    const cz = (forceZ(0) as D3PositionForce).strength(STRENGTH * 0.3);
    graph3d.d3Force('communityZ', cz);
  }
}

// ============================================================================
// Layout by Edge Type
// ============================================================================

export type EdgeTypeLayoutStrategy = 'unified' | 'fix-then-recompute' | 'selected-only';

/**
 * Configure the link force to only include edges of the selected type.
 *
 * Strategy "unified": All nodes participate in charge/gravity, but only
 * the selected edge type contributes link forces.
 *
 * Strategy "selected-only": Only the selected edge type drives link forces.
 * Non-participating nodes get no link attraction (pushed to periphery).
 *
 * Strategy "fix-then-recompute": Two-pass approach handled by the caller
 * (useGraphLayout composable). This function handles the force config for
 * each phase.
 *
 * @param graph3d - The 3d-force-graph instance
 * @param edgeType - Edge type to use for layout, or null to reset
 * @param strategy - Layout strategy
 * @param phase - For fix-then-recompute: 'subgraph' or 'full'
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyEdgeTypeLayoutForce(
  graph3d: any,
  edgeType: string | null,
  strategy: EdgeTypeLayoutStrategy,
  phase?: 'subgraph' | 'full',
  useScoreAsWeight?: boolean,
): void {
  const linkForce = graph3d.d3Force('link');
  if (!linkForce) return;

  if (!edgeType) {
    // Reset: use all links and default strength
    if (typeof linkForce.strength === 'function') {
      linkForce.strength(1);
    }
    graph3d.d3ReheatSimulation();
    return;
  }

  // Get current graph data
  const graphData = graph3d.graphData();
  if (!graphData) return;

  const allLinks = graphData.links || [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filterByType = (l: any) => l.relationshipType === edgeType;

  if (strategy === 'fix-then-recompute') {
    if (phase === 'subgraph') {
      linkForce.links(allLinks.filter(filterByType));
    } else {
      // Phase 2 (full): Restore all links
      linkForce.links(allLinks);
    }
  } else {
    // "selected-only" and "unified": only selected edge type links
    linkForce.links(allLinks.filter(filterByType));
  }

  // Apply score-based strength when enabled
  if (useScoreAsWeight && typeof linkForce.strength === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    linkForce.strength((link: any) => {
      if (link.score !== undefined && link.score !== null) {
        // score 0-1 maps to strength 0.1-1.0 (avoid zero)
        return 0.1 + link.score * 0.9;
      }
      return 1;
    });
  } else if (typeof linkForce.strength === 'function') {
    linkForce.strength(1);
  }

  graph3d.d3ReheatSimulation();
}
