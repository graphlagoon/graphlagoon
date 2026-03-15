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
      path: '/graph/:contextId',
      name: 'graph',
      component: () => import('@/views/GraphVisualizationView.vue'),
      props: true,
    },
  ],
});

// Navigation guard for authentication
router.beforeEach((to, _from, next) => {
  const authStore = useAuthStore();
  const devMode = window.__GRAPH_LAGOON_CONFIG__?.dev_mode ?? import.meta.env.DEV;

  // In dev mode, require login via authStore
  // In production mode (dev_mode=false), email comes from proxy headers
  if (devMode && !to.meta.public && !authStore.isAuthenticated) {
    next({ name: 'login' });
  } else {
    next();
  }
});

export default router;
