import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * The item open in the full-screen viewer (ItemViewer), if any. Components ask
 * for it here; only InvestigationView ties it to the URL (`?view=<item>&v=<n>`),
 * so the inspector, the material list and the version list need no router.
 * `version: null` is the latest version.
 */
export const useItemViewerStore = defineStore('itemViewer', () => {
  const target = ref<{ itemId: string; version: number | null } | null>(null);

  function open(itemId: string, version: number | null = null) {
    target.value = { itemId, version };
  }

  function close() {
    target.value = null;
  }

  return { target, open, close };
});
