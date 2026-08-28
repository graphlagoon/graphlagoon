import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { refreshRuntimeConfig } from '@/services/config';

function _resolveInitialEmail(): string | null {
  // Databricks email takes priority (injected by backend or Vite env)
  const dbEmail =
    window.__GRAPH_LAGOON_CONFIG__?.databricks_user_email
    || import.meta.env.VITE_DATABRICKS_USER_EMAIL;
  if (dbEmail) {
    localStorage.setItem('userEmail', dbEmail);
    return dbEmail;
  }
  return localStorage.getItem('userEmail');
}

function isDevMode(): boolean {
  return window.__GRAPH_LAGOON_CONFIG__?.dev_mode ?? import.meta.env.DEV;
}

export const useAuthStore = defineStore('auth', () => {
  const email = ref<string | null>(_resolveInitialEmail());

  const isAuthenticated = computed(() => !!email.value);

  /**
   * Resolves once the per-user runtime config (is_superuser, …) has been
   * refreshed for the new identity — callers that navigate to a gated route
   * right after logging in should await it.
   */
  async function login(userEmail: string): Promise<void> {
    email.value = userEmail;
    localStorage.setItem('userEmail', userEmail);
    if (isDevMode()) await refreshRuntimeConfig(userEmail);
  }

  async function logout(): Promise<void> {
    email.value = null;
    localStorage.removeItem('userEmail');
    if (isDevMode()) await refreshRuntimeConfig(null);
  }

  return {
    email,
    isAuthenticated,
    login,
    logout,
  };
});
