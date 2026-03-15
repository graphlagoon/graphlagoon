/**
 * Composable to expose persistence configuration
 */

import { computed } from 'vue';
import { api } from '@/services/api';

/**
 * Composable for accessing persistence configuration in components
 */
export function usePersistence() {
  // Check if sharing is available (only when database is enabled)
  // Priority: backend-injected config (production) > Vite env var (dev mode)
  const sharingEnabled = computed(
    () => window.__GRAPH_LAGOON_CONFIG__?.database_enabled === true
      || import.meta.env.VITE_DATABASE_ENABLED === 'true'
  );

  // Check if dev mode is enabled (from backend config)
  const devMode = computed(() => api.devMode);

  return {
    sharingEnabled,
    devMode,
  };
}
