import { describe, it, expect, vi } from 'vitest';
import { applyForceConfig, computeAdaptiveLayoutParams, type Force3DSettings } from '../forceConfig3D';

// ---------------------------------------------------------------------------
// Helper to build a mock graph3d instance
// ---------------------------------------------------------------------------

function makeMockGraph3d() {
  const chargeForce = {
    strength: vi.fn().mockReturnThis(),
    theta: vi.fn().mockReturnThis(),
    distanceMin: vi.fn().mockReturnThis(),
    distanceMax: vi.fn().mockReturnThis(),
  };

  const linkForce = {
    distance: vi.fn().mockReturnThis(),
  };

  const centerForce = {
    strength: vi.fn().mockReturnThis(),
  };

  const simulation = {
    alphaTarget: vi.fn().mockReturnThis(),
  };

  const collideForce = vi.fn();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graph3d: any = {
    d3AlphaDecay: vi.fn().mockReturnThis(),
    d3VelocityDecay: vi.fn().mockReturnThis(),
    d3AlphaMin: vi.fn().mockReturnThis(),
    d3Force: vi.fn((name?: string, force?: unknown) => {
      if (name === undefined) return simulation;
      if (force !== undefined) {
        collideForce(name, force);
        return graph3d;
      }
      if (name === 'charge') return chargeForce;
      if (name === 'link') return linkForce;
      if (name === 'center') return centerForce;
      return null;
    }),
  };

  return { graph3d, chargeForce, linkForce, centerForce, simulation, collideForce };
}

function makeSettings(overrides: Partial<Force3DSettings> = {}): Force3DSettings {
  return {
    d3AlphaDecay: 0.0228,
    d3VelocityDecay: 0.4,
    d3AlphaMin: 0.001,
    d3AlphaTarget: 0,
    d3ChargeStrength: -80,
    d3Theta: 0.9,
    d3DistanceMin: 1,
    d3DistanceMax: Infinity,
    d3LinkDistance: 30,
    d3CenterStrength: 1,
    d3GravityStrength: 0.03,
    d3CollideEnabled: false,
    d3CollideRadius: 10,
    d3CollideStrength: 0.7,
    d3CollideIterations: 1,
    pointerRepulsionEnabled: true,
    pointerVacuumEnabled: true,
    pointerRepulsionStrength: 150,
    pointerRepulsionRange: 200,
    pointerSizeInertia: false,
    clippingPlaneEnabled: false,
    clippingPlaneDistance: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyForceConfig', () => {
  it('sets global simulation parameters', () => {
    const { graph3d } = makeMockGraph3d();
    const settings = makeSettings();

    applyForceConfig(graph3d, settings);

    expect(graph3d.d3AlphaDecay).toHaveBeenCalledWith(0.0228);
    expect(graph3d.d3VelocityDecay).toHaveBeenCalledWith(0.4);
    expect(graph3d.d3AlphaMin).toHaveBeenCalledWith(0.001);
  });

  it('sets alphaTarget on the simulation', () => {
    const { graph3d, simulation } = makeMockGraph3d();
    const settings = makeSettings({ d3AlphaTarget: 0.05 });

    applyForceConfig(graph3d, settings);

    expect(simulation.alphaTarget).toHaveBeenCalledWith(0.05);
  });

  it('configures charge force', () => {
    const { graph3d, chargeForce } = makeMockGraph3d();
    const settings = makeSettings({
      d3ChargeStrength: -200,
      d3Theta: 0.8,
      d3DistanceMin: 5,
      d3DistanceMax: 500,
    });

    applyForceConfig(graph3d, settings);

    expect(chargeForce.strength).toHaveBeenCalledWith(-200);
    expect(chargeForce.theta).toHaveBeenCalledWith(0.8);
    expect(chargeForce.distanceMin).toHaveBeenCalledWith(5);
    expect(chargeForce.distanceMax).toHaveBeenCalledWith(500);
  });

  it('configures link force distance', () => {
    const { graph3d, linkForce } = makeMockGraph3d();
    const settings = makeSettings({ d3LinkDistance: 50 });

    applyForceConfig(graph3d, settings);

    expect(linkForce.distance).toHaveBeenCalledWith(50);
  });

  it('configures center force strength', () => {
    const { graph3d, centerForce } = makeMockGraph3d();
    const settings = makeSettings({ d3CenterStrength: 0.5 });

    applyForceConfig(graph3d, settings);

    expect(centerForce.strength).toHaveBeenCalledWith(0.5);
  });

  it('sets collide force to null when disabled', () => {
    const { graph3d, collideForce } = makeMockGraph3d();
    const settings = makeSettings({ d3CollideEnabled: false });

    applyForceConfig(graph3d, settings);

    expect(collideForce).toHaveBeenCalledWith('collide', null);
  });

  it('creates collide force when enabled', () => {
    const { graph3d, collideForce } = makeMockGraph3d();
    const settings = makeSettings({
      d3CollideEnabled: true,
      d3CollideRadius: 15,
      d3CollideStrength: 0.9,
      d3CollideIterations: 3,
    });

    applyForceConfig(graph3d, settings);

    // The first call to collideForce should be for 'collide' with a force object
    const calls = collideForce.mock.calls;
    const collideCall = calls.find((c: unknown[]) => c[0] === 'collide' && c[1] !== null);
    expect(collideCall).toBeDefined();
    expect(collideCall![1]).not.toBeNull();
  });

  it('handles missing forces gracefully', () => {
    // Create a graph3d where d3Force returns null for all named forces
    const graph3d = {
      d3AlphaDecay: vi.fn().mockReturnThis(),
      d3VelocityDecay: vi.fn().mockReturnThis(),
      d3AlphaMin: vi.fn().mockReturnThis(),
      d3Force: vi.fn(() => null),
    };

    const settings = makeSettings();

    // Should not throw
    expect(() => applyForceConfig(graph3d, settings)).not.toThrow();
  });

  it('sets gravityX, gravityY, gravityZ when gravity > 0 and is2D is false', () => {
    const { graph3d, collideForce } = makeMockGraph3d();
    const settings = makeSettings({ d3GravityStrength: 0.05 });

    applyForceConfig(graph3d, settings, undefined, false);

    const gravityCalls = collideForce.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('gravity')
    );
    const gravityNames = gravityCalls.map((c: unknown[]) => c[0]);
    expect(gravityNames).toContain('gravityX');
    expect(gravityNames).toContain('gravityY');
    expect(gravityNames).toContain('gravityZ');
    // All should have non-null forces
    gravityCalls.forEach((c: unknown[]) => expect(c[1]).not.toBeNull());
  });

  it('sets gravityZ to null when is2D is true', () => {
    const { graph3d, collideForce } = makeMockGraph3d();
    const settings = makeSettings({ d3GravityStrength: 0.05 });

    applyForceConfig(graph3d, settings, undefined, true);

    const gravityCalls = collideForce.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('gravity')
    );
    const gravityZCall = gravityCalls.find((c: unknown[]) => c[0] === 'gravityZ');
    const gravityXCall = gravityCalls.find((c: unknown[]) => c[0] === 'gravityX');
    const gravityYCall = gravityCalls.find((c: unknown[]) => c[0] === 'gravityY');

    expect(gravityZCall).toBeDefined();
    expect(gravityZCall![1]).toBeNull();
    expect(gravityXCall![1]).not.toBeNull();
    expect(gravityYCall![1]).not.toBeNull();
  });

  it('handles simulation without alphaTarget method', () => {
    const graph3d = {
      d3AlphaDecay: vi.fn().mockReturnThis(),
      d3VelocityDecay: vi.fn().mockReturnThis(),
      d3AlphaMin: vi.fn().mockReturnThis(),
      d3Force: vi.fn((name?: string) => {
        if (name === undefined) return {}; // simulation without alphaTarget
        return null;
      }),
    };

    const settings = makeSettings();

    // Should not throw
    expect(() => applyForceConfig(graph3d, settings)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// computeAdaptiveLayoutParams
// ---------------------------------------------------------------------------

describe('computeAdaptiveLayoutParams', () => {
  it('returns defaults for small graphs (<500 elements)', () => {
    const params = computeAdaptiveLayoutParams(100, 200);

    expect(params.warmupTicks).toBe(0);
    expect(params.cooldownTicks).toBe(100);
    expect(params.ticksPerFrame).toBe(1);
    expect(params.forceOverrides).toEqual({});
  });

  it('returns medium settings for graphs with 500-3000 elements', () => {
    const params = computeAdaptiveLayoutParams(500, 1500);

    expect(params.warmupTicks).toBeGreaterThan(0);
    expect(params.cooldownTicks).toBeGreaterThan(100);
    expect(params.ticksPerFrame).toBeGreaterThan(1);
    expect(params.forceOverrides.d3Theta).toBeDefined();
    expect(params.forceOverrides.d3Theta!).toBeGreaterThan(0.9);
  });

  it('returns large settings for graphs with 3000-10000 elements', () => {
    const params = computeAdaptiveLayoutParams(2000, 5000);

    expect(params.warmupTicks).toBeGreaterThanOrEqual(80);
    expect(params.cooldownTicks).toBeGreaterThanOrEqual(500);
    expect(params.ticksPerFrame).toBeGreaterThanOrEqual(6);
    expect(params.forceOverrides.d3Theta).toBeGreaterThanOrEqual(1.5);
    expect(params.forceOverrides.d3AlphaDecay).toBeDefined();
    expect(params.forceOverrides.d3VelocityDecay).toBeDefined();
  });

  it('returns very large settings for graphs with >10000 elements', () => {
    const params = computeAdaptiveLayoutParams(5000, 10000);

    expect(params.warmupTicks).toBeGreaterThanOrEqual(150);
    expect(params.cooldownTicks).toBeGreaterThanOrEqual(800);
    expect(params.ticksPerFrame).toBeGreaterThanOrEqual(10);
    expect(params.forceOverrides.d3Theta).toBeGreaterThanOrEqual(1.7);
  });

  it('scales monotonically — larger graphs get more aggressive params', () => {
    const small = computeAdaptiveLayoutParams(50, 80);
    const medium = computeAdaptiveLayoutParams(500, 1500);
    const large = computeAdaptiveLayoutParams(2000, 5000);
    const vLarge = computeAdaptiveLayoutParams(5000, 10000);

    expect(small.ticksPerFrame).toBeLessThanOrEqual(medium.ticksPerFrame);
    expect(medium.ticksPerFrame).toBeLessThanOrEqual(large.ticksPerFrame);
    expect(large.ticksPerFrame).toBeLessThanOrEqual(vLarge.ticksPerFrame);

    expect(small.cooldownTicks).toBeLessThanOrEqual(medium.cooldownTicks);
    expect(medium.cooldownTicks).toBeLessThanOrEqual(large.cooldownTicks);
    expect(large.cooldownTicks).toBeLessThanOrEqual(vLarge.cooldownTicks);
  });

  it('handles edge case of zero nodes and edges', () => {
    const params = computeAdaptiveLayoutParams(0, 0);

    expect(params.warmupTicks).toBe(0);
    expect(params.ticksPerFrame).toBe(1);
  });

  it('uses node+edge total (not just one)', () => {
    // 200 nodes + 400 edges = 600 total → medium tier
    const params = computeAdaptiveLayoutParams(200, 400);

    expect(params.ticksPerFrame).toBeGreaterThan(1);
  });
});
