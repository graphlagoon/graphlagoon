import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import Aura from '@primevue/themes/aura';
import App from './App.vue';
import router from './router';
import './assets/main.css';

async function bootstrap() {
  // In dev mode (Vite), fetch config from backend API since it's not injected via template
  if (!window.__GRAPH_LAGOON_CONFIG__ && import.meta.env.DEV) {
    try {
      const apiUrl = import.meta.env.VITE_API_URL || '';
      // Send the dev identity so user-dependent flags (is_superuser) are
      // computed for the logged-in user, not the backend's dev fallback.
      const email = localStorage.getItem('userEmail');
      const res = await fetch(`${apiUrl}/api/config`, {
        headers: email ? { 'X-Forwarded-Email': email } : {},
      });
      if (res.ok) {
        window.__GRAPH_LAGOON_CONFIG__ = await res.json();
      }
    } catch {
      // Backend not available — config stays undefined (safe defaults)
    }
  }

  const app = createApp(App);

  app.use(createPinia());
  app.use(router);
  app.use(PrimeVue, {
    theme: {
      preset: Aura,
      options: {
        darkModeSelector: '.dark-mode',
        cssLayer: {
          name: 'primevue',
          order: 'primevue',
        },
      },
    },
  });

  app.mount('#app');
}

bootstrap();
