import { ref } from 'vue';
import { Table2, Focus, Eye } from 'lucide-vue-next';
import { useContextMenu } from './useContextMenu';
import { useCommunityStore } from '@/stores/community';
import { useClusterStore } from '@/stores/cluster';
import { useGraphStore } from '@/stores/graph';

export const COMMUNITY_TABLE_ACTION_ID = 'view-community-table';
export const ISOLATE_COMMUNITY_ACTION_ID = 'isolate-community';
export const ISOLATE_CLUSTER_ACTION_ID = 'isolate-cluster';
export const CLEAR_ISOLATION_ACTION_ID = 'clear-isolation';

/**
 * Context menu actions on a node's community or cluster:
 *
 * - "View community members" opens the CommunityNodeModal for its community.
 * - "Show only this community" / "Show only this cluster" hide every other
 *   node (graphStore.isolate — a saved rule, see utils/isolation.ts).
 * - "Show all nodes" ends any "show only".
 *
 * Community actions are visible only when the node belongs to a detected
 * community (Louvain, components, or a cluster program run as a community
 * algorithm); the cluster one when a program's result cluster holds it.
 *
 * The owning page (exploration or case) calls register()/unregister() in its
 * mount/unmount hooks and binds `selectedCommunityId` to the modal.
 */
export function useCommunityMenuActions() {
  const contextMenu = useContextMenu();
  const communityStore = useCommunityStore();
  const clusterStore = useClusterStore();
  const graphStore = useGraphStore();

  const selectedCommunityId = ref<number | null>(null);

  function communityLabel(id: number): string {
    return communityStore.communityLabels[id] ?? `Community ${id}`;
  }

  function register() {
    contextMenu.addAction({
      id: COMMUNITY_TABLE_ACTION_ID,
      label: 'View community members',
      icon: Table2,
      visible: (t) => t.type === 'node' && communityStore.communityMap.has(t.id),
      handler: (t) => {
        const communityId = communityStore.communityMap.get(t.id);
        if (communityId !== undefined) {
          selectedCommunityId.value = communityId;
        }
      },
    });
    contextMenu.addAction({
      id: ISOLATE_COMMUNITY_ACTION_ID,
      label: 'Show only this community',
      icon: Focus,
      visible: (t) => t.type === 'node' && communityStore.communityMap.has(t.id),
      handler: (t) => {
        const id = communityStore.communityMap.get(t.id);
        if (id !== undefined) graphStore.isolate({ kind: 'community', ids: [id], label: communityLabel(id) });
      },
    });
    contextMenu.addAction({
      id: ISOLATE_CLUSTER_ACTION_ID,
      label: 'Show only this cluster',
      icon: Focus,
      visible: (t) => t.type === 'node' && clusterStore.getClustersForNode(t.id).length > 0,
      handler: (t) => {
        const cluster = clusterStore.getClustersForNode(t.id)[0];
        if (cluster) graphStore.isolate({ kind: 'cluster', ids: [cluster.cluster_id], label: cluster.cluster_name });
      },
    });
    contextMenu.addAction({
      id: CLEAR_ISOLATION_ACTION_ID,
      label: 'Show all nodes',
      icon: Eye,
      visible: () => graphStore.isolation !== null,
      handler: () => graphStore.clearIsolation(),
    });
  }

  function unregister() {
    for (const id of [COMMUNITY_TABLE_ACTION_ID, ISOLATE_COMMUNITY_ACTION_ID, ISOLATE_CLUSTER_ACTION_ID, CLEAR_ISOLATION_ACTION_ID]) {
      contextMenu.removeAction(id);
    }
  }

  function close() {
    selectedCommunityId.value = null;
  }

  return { selectedCommunityId, register, unregister, close };
}
