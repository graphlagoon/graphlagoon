/**
 * Move the focus to a node or edge of the graph: select it (the details panel
 * follows) and bring the camera to it. What is not drawn is said, not flown to:
 * a member of a collapsed group leads to the group's node, an item the filters
 * hide is selected where it is.
 */
import { useClusterStore } from '@/stores/cluster';
import { useGraphStore } from '@/stores/graph';
import { useToast } from '@/composables/useToast';
import type { ItemRef } from '@/utils/itemReference';

interface FocusCanvas {
  focusOnNodes?: (ids: string[]) => void;
}

export function useFocusItem(canvas: () => FocusCanvas | null | undefined) {
  const graphStore = useGraphStore();
  const clusterStore = useClusterStore();
  const toast = useToast();

  /** The node drawn for this one: itself, or the collapsed group that holds it. */
  function drawnId(nodeId: string): string {
    if (clusterStore.visibleNodeIds.has(nodeId)) return nodeId;
    return clusterStore.nodeToClosedClusters.get(nodeId)?.[0] ?? nodeId;
  }

  function focusItem(ref: ItemRef) {
    if (ref.type === 'node') {
      // A collapsed group's node is in no node list; only the camera moves.
      if (clusterStore.clusters.some((c) => c.cluster_id === ref.id)) {
        canvas()?.focusOnNodes?.([ref.id]);
        return;
      }
      if (!graphStore.nodes.some((n) => n.node_id === ref.id)) {
        toast.info('That node is not on the canvas.');
        return;
      }
      if (!graphStore.selectedNodeIds.has(ref.id)) graphStore.selectNode(ref.id);
      if (!graphStore.visibleNodes.some((n) => n.node_id === ref.id)) {
        toast.info('That node is hidden by the filters or “show only”.');
        return;
      }
      canvas()?.focusOnNodes?.([drawnId(ref.id)]);
      return;
    }
    const edge = graphStore.edges.find((e) => e.edge_id === ref.id);
    if (!edge) {
      toast.info('That edge is not on the canvas.');
      return;
    }
    if (!graphStore.selectedEdgeIds.has(ref.id)) graphStore.selectEdge(ref.id);
    if (!graphStore.visibleEdges.some((e) => e.edge_id === ref.id)) {
      toast.info('That edge is hidden by the filters or “show only”.');
      return;
    }
    canvas()?.focusOnNodes?.([drawnId(edge.src), drawnId(edge.dst)]);
  }

  return { focusItem };
}
