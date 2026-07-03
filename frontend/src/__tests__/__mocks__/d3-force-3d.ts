/**
 * Mock for d3-force-3d — not installed as a direct dependency.
 * Used by vitest via the alias in vitest.config.ts.
 */

function makeForceFactory() {
  return () => {
    const force: Record<string, any> = {};
    force.strength = () => force;
    force.radius = () => force;
    force.iterations = () => force;
    return force;
  };
}

export const forceCollide = makeForceFactory();
export const forceX = makeForceFactory();
export const forceY = makeForceFactory();
export const forceZ = makeForceFactory();

// Link/charge/center force factories with the chainable methods the code uses.
export function forceLink(_links?: any) {
  const f: any = () => f;
  f.id = () => f;
  f.distance = () => f;
  f.strength = () => f;
  return f;
}
export function forceManyBody() {
  const f: any = () => f;
  f.strength = () => f;
  f.theta = () => f;
  f.distanceMin = () => f;
  f.distanceMax = () => f;
  return f;
}
export function forceCenter(_x?: number, _y?: number, _z?: number) {
  const f: any = () => f;
  f.strength = () => f;
  return f;
}

/**
 * Minimal functional simulation stub. Enough to exercise the headless-settle
 * orchestration (chunked ticking, alpha convergence, progress) deterministically
 * — the real force math runs in the app (vite aliases to the real submodule) and
 * is validated via the browser perf harness.
 */
export function forceSimulation(nodes: any[] = [], numDim = 2) {
  let alpha = 1;
  let alphaMin = 0.001;
  let alphaDecay = 0.0228;
  const sim: any = {
    force: () => sim,
    velocityDecay: () => sim,
    stop: () => sim,
    nodes: () => nodes,
    alphaDecay: (v?: number) =>
      v === undefined ? alphaDecay : ((alphaDecay = v), sim),
    alphaMin: (v?: number) => (v === undefined ? alphaMin : ((alphaMin = v), sim)),
    alpha: (v?: number) => (v === undefined ? alpha : ((alpha = v), sim)),
    tick: (n = 1) => {
      for (let k = 0; k < n; k++) alpha += (0 - alpha) * alphaDecay;
      // Deterministic, finite, spread-out positions so util outputs are testable.
      nodes.forEach((node: any, i: number) => {
        node.x = (i % 10) * 5;
        node.y = Math.floor(i / 10) * 5;
        if (numDim > 2) node.z = (i % 3) * 2 - 2;
      });
      return sim;
    },
  };
  return sim;
}
