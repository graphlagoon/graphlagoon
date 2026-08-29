import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useGraphStore } from '@/stores/graph';
import type { Exploration } from '@/types/graph';

/**
 * The toolbar showed a saved exploration's name whether or not the view still
 * matched it, so a user could re-style and re-filter for an hour and be told
 * nothing. `isExplorationDirty` is what makes the marker possible.
 */
describe('graph store — exploration dirty state', () => {
  beforeEach(() => setActivePinia(createPinia()));

  function openSavedExploration() {
    const store = useGraphStore();
    store.currentExploration = {
      id: 'exp-1',
      title: 'Fraud ring',
      graph_context_id: 'ctx-1',
      owner_email: 'e2e@test.com',
    } as unknown as Exploration;
    store.markExplorationSaved();
    return store;
  }

  it('is false with no exploration open, however much the view changes', () => {
    const store = useGraphStore();
    store.applyFilters({ node_types: ['Person'] });
    expect(store.isExplorationDirty).toBe(false);
  });

  it('is false right after the baseline is taken', () => {
    const store = openSavedExploration();
    expect(store.isExplorationDirty).toBe(false);
  });

  it('turns true when a saved setting changes, and false again after saving', () => {
    const store = openSavedExploration();

    store.applyFilters({ node_types: ['Person'] });
    expect(store.isExplorationDirty).toBe(true);

    // Saving re-baselines (saveExploration calls markExplorationSaved on success).
    store.markExplorationSaved();
    expect(store.isExplorationDirty).toBe(false);
  });

  it('tracks the graph query too', () => {
    const store = openSavedExploration();
    store.setGraphQuery('MATCH (n) RETURN n');
    expect(store.isExplorationDirty).toBe(true);
  });

  it('is false again when the change is reverted', () => {
    const store = openSavedExploration();
    const before = [...store.filters.node_types];

    store.applyFilters({ node_types: ['Person'] });
    expect(store.isExplorationDirty).toBe(true);

    store.applyFilters({ node_types: before });
    expect(store.isExplorationDirty).toBe(false);
  });
});
