import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

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

export const useAuthStore = defineStore('auth', () => {
  const email = ref<string | null>(_resolveInitialEmail());

  const isAuthenticated = computed(() => !!email.value);

  function login(userEmail: string) {
    email.value = userEmail;
    localStorage.setItem('userEmail', userEmail);
  }

  function logout() {
    email.value = null;
    localStorage.removeItem('userEmail');
  }

  return {
    email,
    isAuthenticated,
    login,
    logout,
  };
});
