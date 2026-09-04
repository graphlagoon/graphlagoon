/**
 * Per-user app capabilities, mirrored from the backend's permission system
 * (groups + rules; see docs/guide/permissions.md). The backend enforces on
 * every gated route — this composable only decides which affordances to
 * RENDER (the UI hides what the user cannot do).
 *
 * Deliberately NOT useFeatureFlags: that helper's absent→enabled default is
 * a per-deployment feature contract. Here the array is per-user: when it is
 * PRESENT the check is strict membership; only a missing array (older
 * backend, bare Vite dev server) falls back to allow.
 */
import { computed } from 'vue';

export function hasPermission(perm: string): boolean {
  const config = window.__GRAPH_LAGOON_CONFIG__;
  if (config?.is_superuser === true) return true;
  const list = config?.permissions;
  if (!Array.isArray(list)) return true; // backend predates the feature
  return list.includes(perm);
}

export function usePermissions() {
  /** Reads the live window config on every evaluation, like `is_superuser`
   *  elsewhere — dev login/logout replaces the config object and the next
   *  render sees the new identity. */
  const can = (perm: string): boolean => hasPermission(perm);

  const canCreateContexts = computed(() => hasPermission('context.create'));
  const canSaveExplorations = computed(() => hasPermission('exploration.save'));
  return { can, canCreateContexts, canSaveExplorations };
}
