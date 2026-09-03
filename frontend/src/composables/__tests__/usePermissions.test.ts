import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hasPermission, usePermissions } from '@/composables/usePermissions';

/**
 * The contract: a PRESENT permissions array is strict membership; an absent
 * one (older backend, bare Vite dev) allows; superusers always pass. This is
 * the opposite default of useFeatureFlags — deliberately a separate helper.
 */
describe('usePermissions', () => {
  beforeEach(() => {
    delete (window as any).__GRAPH_LAGOON_CONFIG__;
  });
  afterEach(() => {
    delete (window as any).__GRAPH_LAGOON_CONFIG__;
  });

  it('allows everything when no config is injected (back-compat)', () => {
    expect(hasPermission('context.create')).toBe(true);
  });

  it('allows when the config predates the permissions array', () => {
    window.__GRAPH_LAGOON_CONFIG__ = { is_superuser: false };
    expect(hasPermission('context.create')).toBe(true);
  });

  it('is strict when the array is present', () => {
    window.__GRAPH_LAGOON_CONFIG__ = { permissions: ['exploration.save'] };
    expect(hasPermission('context.create')).toBe(false);
    expect(hasPermission('exploration.save')).toBe(true);
  });

  it('an empty array blocks every catalog permission', () => {
    window.__GRAPH_LAGOON_CONFIG__ = { permissions: [] };
    const { canCreateContexts, canSaveExplorations } = usePermissions();
    expect(canCreateContexts.value).toBe(false);
    expect(canSaveExplorations.value).toBe(false);
  });

  it('superuser bypasses even an empty array', () => {
    window.__GRAPH_LAGOON_CONFIG__ = { is_superuser: true, permissions: [] };
    expect(hasPermission('context.create')).toBe(true);
  });

  it('reads the live config: dev re-login swaps the object', () => {
    window.__GRAPH_LAGOON_CONFIG__ = { permissions: [] };
    const { can } = usePermissions();
    expect(can('context.create')).toBe(false);
    window.__GRAPH_LAGOON_CONFIG__ = { permissions: ['context.create'] };
    expect(can('context.create')).toBe(true);
  });
});
