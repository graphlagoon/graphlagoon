import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useFocusItem } from '@/composables/useFocusItem';
import { useToast } from '@/composables/useToast';
import { useClusterStore } from '@/stores/cluster';
import { useGraphStore } from '@/stores/graph';
import { createNode } from '@/__tests__/fixtures/nodes';
import { createEdge } from '@/__tests__/fixtures/edges';

const focusOnNodes = vi.fn();

beforeEach(() => {
  setActivePinia(createPinia());
  focusOnNodes.mockReset();
  useToast().toasts.value = [];
  const g = useGraphStore();
  g.nodes = [
    createNode({ node_id: 'a', node_type: 'Person' }),
    createNode({ node_id: 'b', node_type: 'Company' }),
  ];
  g.edges = [createEdge({ edge_id: 'e', src: 'a', dst: 'b' })];
});

const lastToast = () => useToast().toasts.value.at(-1)?.message ?? '';

describe('useFocusItem', () => {
  it('selects the node or edge and frames it', () => {
    const g = useGraphStore();
    const { focusItem } = useFocusItem(() => ({ focusOnNodes }));
    focusItem({ type: 'edge', id: 'e' });
    expect([...g.selectedEdgeIds]).toEqual(['e']);
    expect(focusOnNodes).toHaveBeenLastCalledWith(['a', 'b']);
    focusItem({ type: 'node', id: 'b' });
    expect([...g.selectedNodeIds]).toEqual(['b']);
    expect(g.selectedEdgeIds.size).toBe(0);
    expect(focusOnNodes).toHaveBeenLastCalledWith(['b']);
    focusItem({ type: 'node', id: 'b' }); // again: stays selected
    expect([...g.selectedNodeIds]).toEqual(['b']);
  });

  it('says when the item is hidden or not on the canvas, and does not fly there', () => {
    const g = useGraphStore();
    g.applyFilters({ node_types: ['Person'] });
    const { focusItem } = useFocusItem(() => ({ focusOnNodes }));
    focusItem({ type: 'node', id: 'b' });
    expect(lastToast()).toContain('hidden');
    focusItem({ type: 'edge', id: 'e' });
    expect(lastToast()).toContain('hidden');
    focusItem({ type: 'node', id: 'zzz' });
    expect(lastToast()).toContain('not on the canvas');
    expect(focusOnNodes).not.toHaveBeenCalled();
  });

  it('a member of a collapsed group leads to the group', () => {
    useClusterStore().createCluster({
      cluster_id: 'c1', cluster_name: 'G', cluster_class: 'x', figure: 'circle', state: 'closed', node_ids: ['b'],
    });
    useFocusItem(() => ({ focusOnNodes })).focusItem({ type: 'node', id: 'b' });
    expect(focusOnNodes).toHaveBeenCalledWith(['c1']);
  });
});
