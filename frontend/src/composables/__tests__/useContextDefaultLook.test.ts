/**
 * A context's default look lives under `default_behaviors.look`: written
 * without behaviors, next to the context's other keys, and every copy of the
 * context the page holds follows the write.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { storedDefaultLook, toDefaultLook, useContextDefaultLook, withDefaultLook } from '@/composables/useContextDefaultLook';
import { useGraphStore, resolveInitialBehaviors } from '@/stores/graph';
import { useInvestigationStore } from '@/stores/investigation';

vi.mock('@/services/api', () => ({
  api: { updateGraphContext: vi.fn(), getGraphContext: vi.fn() },
}));

import { api } from '@/services/api';

const RED = { nodeTypeColors: { Person: '#f00' } };

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  vi.mocked(api.updateGraphContext).mockImplementation(async (id, data) => ({ id, title: 't', ...data }) as any);
});

describe('helpers', () => {
  it('toDefaultLook drops behaviors and names the source', () => {
    expect(toDefaultLook({ ...RED, behaviors: { viewMode: '3d' } }, 'current')).toEqual({ ...RED, source: 'current' });
  });

  it('withDefaultLook replaces or removes the look, keeping the other keys', () => {
    expect(withDefaultLook({ viewMode: '3d', look: { old: 1 } }, { ...RED })).toEqual({ viewMode: '3d', look: RED });
    expect(withDefaultLook({ viewMode: '3d', look: RED }, null)).toEqual({ viewMode: '3d' });
    expect(withDefaultLook(undefined, null)).toEqual({});
  });

  it('storedDefaultLook ignores anything that is not an object', () => {
    expect(storedDefaultLook({ default_behaviors: { look: 'x' } })).toBeNull();
    expect(storedDefaultLook({ default_behaviors: { look: RED } })).toEqual(RED);
  });

  it('the look is never read as a behavior', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = resolveInitialBehaviors({ viewMode: '2d-proj', look: RED });
    expect(b.viewMode).toBe('2d-proj');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('setDefaultLook', () => {
  it('writes through the context update and refreshes the page copies', async () => {
    const graph = useGraphStore();
    const inv = useInvestigationStore();
    graph.currentContext = { id: 'c1', title: 't', default_behaviors: { viewMode: '3d' } } as any;
    inv.contexts = { c1: { id: 'c1', title: 't', default_behaviors: { viewMode: '3d' } } as any };

    await useContextDefaultLook().setDefaultLook('c1', { ...RED, source: 'current' });

    expect(api.updateGraphContext).toHaveBeenCalledWith('c1', { default_behaviors: { viewMode: '3d', look: { ...RED, source: 'current' } } });
    expect(graph.currentContext?.default_behaviors?.look).toEqual({ ...RED, source: 'current' });
    expect(inv.contexts.c1.default_behaviors?.look).toEqual({ ...RED, source: 'current' });
  });

  it('fetches a context the page does not hold', async () => {
    vi.mocked(api.getGraphContext).mockResolvedValue({ id: 'c9', title: 't', default_behaviors: { autoLoadOnOpen: true } } as any);
    await useContextDefaultLook().setDefaultLook('c9', null);
    expect(api.updateGraphContext).toHaveBeenCalledWith('c9', { default_behaviors: { autoLoadOnOpen: true } });
  });
});
