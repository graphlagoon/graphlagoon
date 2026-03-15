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
