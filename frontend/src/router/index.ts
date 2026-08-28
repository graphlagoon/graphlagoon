import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

// Use '/' for route base path - Vite's BASE_URL (/static/) is only for asset paths
const routerBase = window.__GRAPH_LAGOON_CONFIG__?.router_base || '/';

const router = createRouter({
  history: createWebHistory(routerBase),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      redirect: '/contexts',
    },
    {
      path: '/contexts',
      name: 'contexts',
      component: () => import('@/views/ContextsView.vue'),
    },
    {
      path: '/explorations',
      name: 'explorations',
      component: () => import('@/views/ExplorationsView.vue'),
    },
    {
      path: '/dev/generator',
      name: 'dev-generator',
      component: () => import('@/views/DevGeneratorView.vue'),
      meta: { devOnly: true },
    },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('@/views/AdminView.vue'),
      meta: { superuserOnly: true },
    },
    {
      path: '/graph/:contextId',
      name: 'graph',
      component: () => import('@/views/GraphVisualizationView.vue'),
      props: true,
    },
  ],
});

/**
 * Pure guard decision, exported for tests. The frontend flags are UX only —
 * the backend rejects non-superusers on /api/admin/* and dev-only endpoints
 * regardless of what the router allows.
 */
export function resolveGuard(
  to: { meta: Record<string, unknown> },
  state: { devMode: boolean; isAuthenticated: boolean; isSuperuser: boolean },
): { name: string } | null {
  // In dev mode, require login via authStore
  // In production mode (dev_mode=false), email comes from proxy headers
  if (state.devMode && !to.meta.public && !state.isAuthenticated) {
    return { name: 'login' };
  }
  if (to.meta.superuserOnly && !state.isSuperuser) {
    return { name: 'contexts' };
  }
  if (to.meta.devOnly && !state.devMode) {
    return { name: 'contexts' };
  }
  return null;
}

// Navigation guard for authentication and role-gated pages
router.beforeEach((to, _from, next) => {
  const authStore = useAuthStore();
  const config = window.__GRAPH_LAGOON_CONFIG__;
  const redirect = resolveGuard(to, {
    devMode: config?.dev_mode ?? import.meta.env.DEV,
    isAuthenticated: authStore.isAuthenticated,
    isSuperuser: config?.is_superuser === true,
  });
  if (redirect) next(redirect);
  else next();
});

export default router;
