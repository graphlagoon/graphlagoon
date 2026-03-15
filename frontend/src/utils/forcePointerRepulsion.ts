/**
 * Custom d3-force that repels/attracts nodes along a camera ray (cylindrical blower/vacuum).
 *
 * Computes the shortest distance from each node to the pointer RAY
 * (line from camera through mouse), producing a cylindrical clearing
 * along the line of sight.
 *
 * Force direction is perpendicular to the ray (radial push outward).
 * Decay: linear — full strength at ray, zero at range boundary.
 *
 * When sizeInertia is enabled, larger nodes resist the force more
 * (force divided by cbrt(size)), simulating mass/inertia.
 */

interface ForceNode {
  index: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  id?: string;
  size?: number;
  [key: string]: unknown;
}

export interface PointerRepulsionForce {
  (alpha: number): void;
  initialize(nodes: ForceNode[], ...args: unknown[]): void;
  strength(): number;
  strength(value: number): PointerRepulsionForce;
  range(): number;
  range(value: number): PointerRepulsionForce;
  rayOrigin(): [number, number, number];
  rayOrigin(value: [number, number, number]): PointerRepulsionForce;
  rayDirection(): [number, number, number];
  rayDirection(value: [number, number, number]): PointerRepulsionForce;
  enabled(): boolean;
  enabled(value: boolean): PointerRepulsionForce;
  sizeInertia(): boolean;
  sizeInertia(value: boolean): PointerRepulsionForce;
}

export function forcePointerRepulsion(): PointerRepulsionForce {
  let nodes: ForceNode[] = [];
  let _strength = 150;
  let _range = 200;
  let _enabled = false;
  let _sizeInertia = false;

  // Ray defined by origin + unit direction
  let ox = 0, oy = 0, oz = 0;
  let dx = 0, dy = 0, dz = 1;

  function force(alpha: number): void {
    if (!_enabled) return;

    const range2 = _range * _range;

    for (let i = 0, n = nodes.length; i < n; ++i) {
      const node = nodes[i];

      // Skip pinned nodes (they have fx/fy/fz set — frozen by the caller)
      if (node.fx != null) continue;

      // Vector from ray origin to node: P - O
      // In 2D mode (numDimensions=2), node.z is undefined — treat as 0
      const px = node.x - ox;
      const py = node.y - oy;
      const pz = (node.z ?? 0) - oz;

      // Project P onto ray direction: t = (P · D)
      const t = px * dx + py * dy + pz * dz;

      // Perpendicular vector from ray to node: P - t*D
      const perpX = px - t * dx;
      const perpY = py - t * dy;
      const perpZ = pz - t * dz;

      // Distance squared from node to ray
      const dist2 = perpX * perpX + perpY * perpY + perpZ * perpZ;

      if (dist2 < 1e-6 || dist2 > range2) continue;

      const dist = Math.sqrt(dist2);

      // Linear decay: full strength at ray, zero at range boundary
      let k = _strength * alpha * (1 - dist / _range) / dist;

      // Size-based inertia: larger nodes resist force more
      if (_sizeInertia) {
        const mass = Math.cbrt(node.size ?? 1);
        if (mass > 0) k /= mass;
      }

      node.vx += perpX * k;
      node.vy += perpY * k;
      if (node.vz !== undefined) node.vz += perpZ * k;
    }
  }

  force.initialize = function (_nodes: ForceNode[]): void {
    nodes = _nodes;
  };

  force.strength = function (value?: number): number | PointerRepulsionForce {
    if (value === undefined) return _strength;
    _strength = value;
    return force;
  } as PointerRepulsionForce['strength'];

  force.range = function (value?: number): number | PointerRepulsionForce {
    if (value === undefined) return _range;
    _range = value;
    return force;
  } as PointerRepulsionForce['range'];

  force.rayOrigin = function (value?: [number, number, number]): [number, number, number] | PointerRepulsionForce {
    if (value === undefined) return [ox, oy, oz];
    ox = value[0]; oy = value[1]; oz = value[2];
    return force;
  } as PointerRepulsionForce['rayOrigin'];

  force.rayDirection = function (value?: [number, number, number]): [number, number, number] | PointerRepulsionForce {
    if (value === undefined) return [dx, dy, dz];
    if (value) {
      const len = Math.sqrt(value[0] * value[0] + value[1] * value[1] + value[2] * value[2]);
      if (len > 0) {
        dx = value[0] / len;
        dy = value[1] / len;
        dz = value[2] / len;
      }
    }
    return force;
  } as PointerRepulsionForce['rayDirection'];

  force.enabled = function (value?: boolean): boolean | PointerRepulsionForce {
    if (value === undefined) return _enabled;
    _enabled = value;
    return force;
  } as PointerRepulsionForce['enabled'];

  force.sizeInertia = function (value?: boolean): boolean | PointerRepulsionForce {
    if (value === undefined) return _sizeInertia;
    _sizeInertia = value;
    return force;
  } as PointerRepulsionForce['sizeInertia'];

  return force as PointerRepulsionForce;
}
