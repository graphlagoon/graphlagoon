import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import TranspileSettingsModal from '@/components/TranspileSettingsModal.vue';
import { useGraphStore } from '@/stores/graph';
import { DEFAULT_PROCEDURAL_BFS_OPTIONS } from '@/types/graph';

function q(testid: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testid}"]`);
}

function checkbox(testid: string): HTMLInputElement {
  return q(testid) as HTMLInputElement;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  document.body.querySelectorAll('.modal-overlay').forEach(el => el.remove());
});

describe('TranspileSettingsModal', () => {
  it('shows the large-results toggle regardless of transpile mode', () => {
    render(TranspileSettingsModal);
    expect(q('opt-large-results')).not.toBeNull();
  });

  it('hides per-optimization flags until procedural BFS is enabled', async () => {
    const graph = useGraphStore();
    graph.vlpRenderingMode = 'cte';
    render(TranspileSettingsModal);

    expect(q('opt-visited_not_exists')).toBeNull();
    expect(document.body.textContent).toContain('Enable Procedural BFS');

    // Enabling procedural BFS reveals the flags.
    await fireEvent.click(checkbox('opt-procedural-bfs'));
    expect(graph.vlpRenderingMode).toBe('procedural');
    expect(q('opt-visited_not_exists')).not.toBeNull();
  });

  it('shows the CTE fallback toggle checked by default under procedural BFS', () => {
    const graph = useGraphStore();
    graph.vlpRenderingMode = 'procedural';
    render(TranspileSettingsModal);

    expect(checkbox('opt-cte-fallback').checked).toBe(true);
  });

  it('hides the CTE fallback toggle in CTE mode', () => {
    const graph = useGraphStore();
    graph.vlpRenderingMode = 'cte';
    render(TranspileSettingsModal);

    expect(q('opt-cte-fallback')).toBeNull();
  });

  it('binds the CTE fallback toggle to the store', async () => {
    const graph = useGraphStore();
    graph.vlpRenderingMode = 'procedural';
    render(TranspileSettingsModal);

    await fireEvent.click(checkbox('opt-cte-fallback'));
    expect(graph.cteFallbackEnabled).toBe(false);

    await fireEvent.click(checkbox('opt-cte-fallback'));
    expect(graph.cteFallbackEnabled).toBe(true);
  });

  it('shows the silent sub-toggle checked by default, only while the fallback is on', async () => {
    const graph = useGraphStore();
    graph.vlpRenderingMode = 'procedural';
    render(TranspileSettingsModal);

    expect(checkbox('opt-cte-fallback-silent').checked).toBe(true);

    // Turning the fallback off hides the silent sub-option.
    await fireEvent.click(checkbox('opt-cte-fallback'));
    expect(q('opt-cte-fallback-silent')).toBeNull();
  });

  it('binds the silent toggle to the store', async () => {
    const graph = useGraphStore();
    graph.vlpRenderingMode = 'procedural';
    render(TranspileSettingsModal);

    await fireEvent.click(checkbox('opt-cte-fallback-silent'));
    expect(graph.cteFallbackSilent).toBe(false);

    await fireEvent.click(checkbox('opt-cte-fallback-silent'));
    expect(graph.cteFallbackSilent).toBe(true);
  });

  it('binds the large-results toggle to the store', async () => {
    const graph = useGraphStore();
    graph.useExternalLinks = true;
    render(TranspileSettingsModal);

    await fireEvent.click(checkbox('opt-large-results'));
    expect(graph.useExternalLinks).toBe(false);
  });

  it('enforces mutual exclusivity of the two undirected strategies', async () => {
    const graph = useGraphStore();
    graph.vlpRenderingMode = 'procedural';
    // Start from defaults: doubled_adjacency ON, union_all OFF.
    render(TranspileSettingsModal);

    await fireEvent.click(checkbox('opt-undirected_union_all'));

    expect(graph.proceduralOptimizations.undirected_union_all).toBe(true);
    expect(graph.proceduralOptimizations.undirected_doubled_adjacency).toBe(false);

    // Flipping doubled_adjacency back on clears union_all again.
    await fireEvent.click(checkbox('opt-undirected_doubled_adjacency'));
    expect(graph.proceduralOptimizations.undirected_doubled_adjacency).toBe(true);
    expect(graph.proceduralOptimizations.undirected_union_all).toBe(false);
  });

  it('disables temp_tables-only flags under numbered_views (and vice versa)', async () => {
    const graph = useGraphStore();
    graph.vlpRenderingMode = 'procedural';
    graph.materializationStrategy = 'numbered_views';
    render(TranspileSettingsModal);

    // temp_tables-only flags are disabled under numbered_views
    expect(checkbox('opt-deferred_edge_payload').disabled).toBe(true);
    expect(checkbox('opt-barrier_precompute').disabled).toBe(true);
    // numbered_views-only flag is enabled
    expect(checkbox('opt-loop_control_into').disabled).toBe(false);

    // Switch materialization → scope flips
    graph.materializationStrategy = 'temp_tables';
    await fireEvent.update(q('opt-materialization') as HTMLSelectElement, 'temp_tables');
    expect(checkbox('opt-loop_control_into').disabled).toBe(true);
    expect(checkbox('opt-deferred_edge_payload').disabled).toBe(false);
  });

  it('disables barrier_on_adjacency when barrier_precompute is off', async () => {
    const graph = useGraphStore();
    graph.vlpRenderingMode = 'procedural';
    graph.materializationStrategy = 'temp_tables';
    render(TranspileSettingsModal);

    // Defaults: both barrier flags ON → dependent flag is interactive.
    expect(checkbox('opt-barrier_on_adjacency').disabled).toBe(false);

    // Turning off the prerequisite disables the dependent flag.
    await fireEvent.click(checkbox('opt-barrier_precompute'));
    expect(graph.proceduralOptimizations.barrier_precompute).toBe(false);
    expect(checkbox('opt-barrier_on_adjacency').disabled).toBe(true);
  });

  it('disables prune_barrier_adjacency unless BOTH prerequisites are on', async () => {
    const graph = useGraphStore();
    graph.vlpRenderingMode = 'procedural';
    graph.materializationStrategy = 'temp_tables';
    render(TranspileSettingsModal);

    // Defaults: doubled_adjacency + barrier_precompute both ON → interactive.
    expect(checkbox('opt-prune_barrier_adjacency').disabled).toBe(false);

    // Dropping either prerequisite disables it.
    await fireEvent.click(checkbox('opt-undirected_doubled_adjacency'));
    expect(graph.proceduralOptimizations.undirected_doubled_adjacency).toBe(false);
    expect(checkbox('opt-prune_barrier_adjacency').disabled).toBe(true);
  });

  it('resets the flags to the transpiler defaults', async () => {
    const graph = useGraphStore();
    graph.vlpRenderingMode = 'procedural';
    graph.proceduralOptimizations = {
      ...DEFAULT_PROCEDURAL_BFS_OPTIONS,
      visited_not_exists: false,
      barrier_precompute: false,
    };
    render(TranspileSettingsModal);

    await fireEvent.click(q('opt-reset') as HTMLElement);
    expect(graph.proceduralOptimizations).toEqual(DEFAULT_PROCEDURAL_BFS_OPTIONS);
  });
});
