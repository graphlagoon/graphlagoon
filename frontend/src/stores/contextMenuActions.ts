/**
 * Store for user-configurable context-menu actions.
 *
 * The action configs live in the current graph context's
 * `context_menu_actions` JSON column (opaque to the backend). Mirrors the
 * cluster store's persistence contract: hydration from the context never
 * triggers a PUT, edits persist debounced + fire-and-forget, and nothing is
 * sent without write access.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ContextMenuActionConfig } from '@/types/contextMenuActions';
import { useGraphStore } from '@/stores/graph';
import { api } from '@/services/api';

const PERSIST_DEBOUNCE_MS = 800;

export const useContextMenuActionsStore = defineStore('contextMenuActions', () => {
  const actionConfigs = ref<ContextMenuActionConfig[]>([]);
  const error = ref<string | null>(null);

  // Guards against persisting while configs are being rebuilt from context
  // data (hydration must never trigger a PUT).
  let isHydrating = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  function hydrateFromContext(configs?: ContextMenuActionConfig[]) {
    isHydrating = true;
    try {
      actionConfigs.value = (configs ?? []).map((c) => ({ ...c }));
    } finally {
      isHydrating = false;
    }
  }

  function addConfig(config: ContextMenuActionConfig) {
    actionConfigs.value.push(config);
    persistToContext();
  }

  function updateConfig(config: ContextMenuActionConfig) {
    const index = actionConfigs.value.findIndex((c) => c.id === config.id);
    if (index === -1) return;
    actionConfigs.value[index] = config;
    persistToContext();
  }

  function removeConfig(configId: string) {
    actionConfigs.value = actionConfigs.value.filter((c) => c.id !== configId);
    persistToContext();
  }

  function setEnabled(configId: string, enabled: boolean) {
    const config = actionConfigs.value.find((c) => c.id === configId);
    if (!config) return;
    config.enabled = enabled;
    persistToContext();
  }

  /** Push the configs to the backend (debounced, fire-and-forget). */
  function persistToContext() {
    if (isHydrating) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void doPersist();
    }, PERSIST_DEBOUNCE_MS);
  }

  async function doPersist(): Promise<void> {
    const graphStore = useGraphStore();
    const context = graphStore.currentContext;
    if (!context || !context.has_write_access) return;

    try {
      const updated = await api.updateGraphContext(context.id, {
        context_menu_actions: actionConfigs.value,
      });
      // Keep the local context record in sync so a later hydrate is consistent
      if (graphStore.currentContext?.id === updated.id) {
        graphStore.currentContext = updated;
      }
      error.value = null;
    } catch (e) {
      console.warn('Failed to persist context menu actions:', e);
      error.value = 'Failed to save context menu actions to the context';
    }
  }

  /** Immediately run any pending debounced persist (unmount and tests). */
  async function flushPersist(): Promise<void> {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
      await doPersist();
    }
  }

  return {
    actionConfigs,
    error,
    hydrateFromContext,
    addConfig,
    updateConfig,
    removeConfig,
    setEnabled,
    persistToContext,
    flushPersist,
  };
});
