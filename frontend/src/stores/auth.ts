import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { refreshRuntimeConfig } from '@/services/config';

const API_URL = window.__GRAPH_LAGOON_API_URL__ || import.meta.env.VITE_API_URL || '';

/** The backend verifies every identity with the workspace (auth_mode=databricks). */
export function isDatabricksAuth(): boolean {
  return window.__GRAPH_LAGOON_CONFIG__?.auth_mode === 'databricks';
}

function _resolveInitialEmail(): string | null {
  // Databricks email takes priority (injected by backend or Vite env)
  const dbEmail =
    window.__GRAPH_LAGOON_CONFIG__?.databricks_user_email
    || import.meta.env.VITE_DATABRICKS_USER_EMAIL;
  if (dbEmail) {
    localStorage.setItem('userEmail', dbEmail);
    return dbEmail;
  }
  // With the workspace-verified sign-in the page's identity is the session the
  // backend injected; a remembered e-mail would only paint a stale login.
  if (isDatabricksAuth()) return null;
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
    if (isDatabricksAuth()) {
      // Ends the app-hosted session (a cookie); the proxy's own login is untouched.
      try {
        await fetch(`${API_URL}/api/auth/logout`, {
          method: 'POST',
          headers: { 'X-Requested-With': 'graphlagoon' },
        });
      } catch {
        /* the session cookie expires on its own */
      }
      if (window.__GRAPH_LAGOON_CONFIG__) delete window.__GRAPH_LAGOON_CONFIG__.databricks_user_email;
      return;
    }
    if (isDevMode()) await refreshRuntimeConfig(null);
  }

  return {
    email,
    isAuthenticated,
    login,
    logout,
  };
});
