/**
 * The exploration's default focus, set from the side panel: the node the
 * exploration opens on, saved with it. A case has its own (per graph item).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import SidePanel from '@/components/SidePanel.vue';
import { useGraphStore } from '@/stores/graph';

const stubs = { JsonValueViewer: true };

beforeEach(() => {
  setActivePinia(createPinia());
});

function seed() {
  const store = useGraphStore();
  store.nodes = [{ node_id: 'n1', node_type: 'Person', properties: { name: 'Alice' } }] as never;
  store.edges = [{ edge_id: 'e1', src: 'n1', dst: 'n1', relationship_type: 'SELF', properties: {} }] as never;
  return store;
}

describe('SidePanel — default focus', () => {
  it('toggles the exploration focus on the selected node', async () => {
    const store = seed();
    store.selectNode('n1');
    const { getByTestId } = render(SidePanel, { global: { stubs } });

    await fireEvent.click(getByTestId('side-panel-default-focus'));
    expect(store.focusNodeId).toBe('n1');
    expect(getByTestId('side-panel-default-focus').textContent).toContain('✓');

    await fireEvent.click(getByTestId('side-panel-default-focus'));
    expect(store.focusNodeId).toBeNull();
  });

  it('is not offered for an edge nor on a case canvas', () => {
    const store = seed();
    store.selectEdge('e1');
    const { queryByTestId, unmount } = render(SidePanel, { global: { stubs } });
    expect(queryByTestId('side-panel-default-focus')).toBeNull();
    unmount();

    store.selectNode('n1');
    store.investigationMode = { origins: new Map(), rings: new Map(), chooseOrigin: async () => null, applyExpansion: () => {} };
    const { queryByTestId: q2 } = render(SidePanel, { global: { stubs } });
    expect(q2('side-panel-default-focus')).toBeNull();
  });
});
