/**
 * The groups a share modal can offer (`GET /api/groups`: id, name, description;
 * never the members). Loaded once, on demand; a failure leaves the list empty
 * so the modal simply hides the group option.
 */
import { computed, ref } from 'vue';
import { api } from '@/services/api';
import type { ShareableGroup } from '@/types/admin';
import type { GroupListState } from '@/utils/shareTargets';

export function useShareableGroups() {
  const groups = ref<ShareableGroup[]>([]);
  const state = ref<GroupListState>('idle');
  let loading: Promise<void> | null = null;

  function load(): Promise<void> {
    if (!loading) {
      state.value = 'loading';
      loading = api
        .listGroups()
        .then((res) => {
          groups.value = res.items;
          state.value = 'loaded';
        })
        .catch(() => {
          groups.value = [];
          state.value = 'failed';
          loading = null; // try again next time the modal opens
        });
    }
    return loading;
  }

  const byId = computed(() => new Map(groups.value.map((g) => [g.id, g])));

  function nameOf(groupId: string): string | undefined {
    return byId.value.get(groupId)?.name;
  }

  return { groups, state, load, nameOf };
}
