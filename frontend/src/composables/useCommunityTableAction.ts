import { ref } from 'vue';
import { Table2 } from 'lucide-vue-next';
import { useContextMenu } from './useContextMenu';
import { useCommunityStore } from '@/stores/community';

export const COMMUNITY_TABLE_ACTION_ID = 'view-community-table';

/**
 * "View community members" context menu action.
 *
 * Visible only when the right-clicked node belongs to a detected community
 * (Louvain or a cluster program run as community algorithm). Selecting it
 * opens the CommunityNodeModal for that node's community.
 *
 * The owning component (GraphVisualizationView) calls register()/unregister()
 * in its mount/unmount hooks and binds `selectedCommunityId` to the modal.
 */
export function useCommunityTableAction() {
  const contextMenu = useContextMenu();
  const communityStore = useCommunityStore();

  const selectedCommunityId = ref<number | null>(null);

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
  }

  function unregister() {
    contextMenu.removeAction(COMMUNITY_TABLE_ACTION_ID);
  }

  function close() {
    selectedCommunityId.value = null;
  }

  return { selectedCommunityId, register, unregister, close };
}
