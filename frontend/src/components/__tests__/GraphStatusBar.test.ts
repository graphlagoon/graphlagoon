/**
 * The status bar under a canvas: counts, the store-driven qualifiers and the
 * shortcuts chip that replaced the strip over the canvas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { nextTick } from 'vue';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import GraphStatusBar from '@/components/GraphStatusBar.vue';
import { useGraphStore } from '@/stores/graph';
import { useToolbarStore } from '@/stores/toolbar';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('GraphStatusBar', () => {
  it('shows the counts, the slot and the shortcuts chip that opens About', async () => {
    const { getByTestId, container } = render(GraphStatusBar, {
      props: { nodes: 3, edges: 2, testId: 'workspace-status' },
      slots: { default: '<span data-testid="extra">2 sources</span>' },
    });
    expect(getByTestId('workspace-status').textContent).toContain('3 nodes');
    expect(container.textContent).toContain('2 edges');
    expect(getByTestId('extra')).toBeTruthy();

    await fireEvent.click(getByTestId('graph-status-shortcuts'));
    expect(useToolbarStore().aboutOpen).toBe(true);
  });

  it('a truncated result shows the chip that leads to the behaviors', async () => {
    const store = useGraphStore();
    store.truncated = true;
    const { getByTestId, emitted } = render(GraphStatusBar, { props: { nodes: 1, edges: 1 } });
    await fireEvent.click(getByTestId('graph-status-truncated'));
    expect(emitted('open-behaviors')).toHaveLength(1);
  });

  it('"Showing only" says what is shown and its ✕ shows every node', async () => {
    const store = useGraphStore();
    store.nodes = [
      { node_id: 'a', node_type: 'T', properties: { branch: 'x' } },
      { node_id: 'b', node_type: 'T', properties: { branch: 'y' } },
    ];
    const { getByTestId, queryByTestId } = render(GraphStatusBar, { props: { nodes: 2, edges: 0 } });
    expect(queryByTestId('status-isolation')).toBeNull();
    store.isolate({ kind: 'value', field: 'branch', value: 'x', mode: 'same', label: 'branch = x' });
    await nextTick();
    const chip = getByTestId('status-isolation');
    expect(chip.textContent).toContain('branch = x');
    expect(chip.getAttribute('title')).toContain('1 of 2 nodes shown');
    await fireEvent.click(getByTestId('status-isolation-clear'));
    expect(store.isolation).toBeNull();
    await nextTick();
    expect(queryByTestId('status-isolation')).toBeNull();
  });

  it('counts the nodes drawn against the nodes loaded, and names a Filters-panel filter with its ✕', async () => {
    const store = useGraphStore();
    store.nodes = [
      { node_id: 'a', node_type: 'Person' },
      { node_id: 'b', node_type: 'Company' },
    ] as any;
    store.applyFilters({ node_types: ['Person'] });
    const { getByTestId } = render(GraphStatusBar, { props: { nodes: 1, edges: 0 } });
    expect(getByTestId('graph-status-nodes').textContent).toContain('1 of 2 nodes');
    expect(getByTestId('status-filtered').textContent).toContain('1 type hidden');
    await fireEvent.click(getByTestId('status-filtered-clear'));
    await nextTick();
    expect(store.filters.node_types).toEqual([]);
  });

  it('a case turns the Filters chip off (its own chips have a Clear)', () => {
    const store = useGraphStore();
    store.nodes = [{ node_id: 'a', node_type: 'P' }, { node_id: 'b', node_type: 'Q' }] as any;
    store.applyFilters({ node_types: ['P'] });
    const { queryByTestId } = render(GraphStatusBar, { props: { nodes: 1, edges: 0, filterChip: false } });
    expect(queryByTestId('status-filtered')).toBeNull();
  });
});
