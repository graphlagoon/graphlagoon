/**
 * The status bar under a canvas: counts, the store-driven qualifiers and the
 * shortcuts chip that replaced the strip over the canvas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
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
});
