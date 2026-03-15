<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const authStore = useAuthStore();

const email = ref('');
const error = ref('');

const devMode = computed(() => {
  return window.__GRAPH_LAGOON_CONFIG__?.dev_mode ?? import.meta.env.DEV;
});

onMounted(() => {
  // If not in dev mode, redirect to contexts
  // (authentication will be handled by proxy headers)
  if (!devMode.value) {
    router.push('/contexts');
  }
});

function login() {
  if (!email.value.includes('@')) {
    error.value = 'Please enter a valid email';
    return;
  }

  authStore.login(email.value);
  router.push('/contexts');
}
</script>

<template>
  <div class="login-container">
    <div class="login-card card">
      <div class="brand-header">
        <svg class="brand-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M2 17c2-4 4-6 6-6s4 4 6 4 4-3 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>
          <circle cx="12" cy="12" r="2.5" fill="currentColor" opacity="0.7"/>
        </svg>
        <h1>Graph Lagoon</h1>
      </div>
      <p class="subtitle">Interactive Graph Visualization</p>

      <form @submit.prevent="login">
        <div class="form-group">
          <label for="email">Email</label>
          <input
            id="email"
            v-model="email"
            type="email"
            class="form-control"
            placeholder="your@email.com"
            required
          />
        </div>

        <p v-if="error" class="error-message" data-testid="login-error">{{ error }}</p>

        <button type="submit" class="btn btn-primary btn-block" data-testid="login-submit">
          Login
        </button>
      </form>

      <p v-if="devMode" class="dev-mode-notice">
        Dev Mode: Enter any email to login
      </p>
      <p v-else class="prod-mode-notice">
        Production Mode: Authentication is handled by proxy headers
      </p>
    </div>
  </div>
</template>

<style scoped>
.login-container {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 20px;
}

.login-card {
  width: 100%;
  max-width: 400px;
  text-align: center;
}

.brand-header {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 8px;
}

.brand-icon {
  color: var(--primary-color, #42b883);
  flex-shrink: 0;
}

.login-card h1 {
  color: var(--primary-color);
  margin-bottom: 0;
  font-size: 24px;
}

.subtitle {
  color: var(--text-muted);
  margin-bottom: 24px;
}

.btn-block {
  width: 100%;
}

.dev-mode-notice {
  margin-top: 16px;
  font-size: 12px;
  color: var(--text-muted);
}

.prod-mode-notice {
  margin-top: 16px;
  font-size: 12px;
  color: var(--warning-color, #ff9800);
}
</style>
