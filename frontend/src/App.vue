<script setup lang="ts">
import { RouterView } from 'vue-router';
import { useRoute } from 'vue-router';
import { computed } from 'vue';
import ToastContainer from '@/components/ToastContainer.vue';
import Toolbar from '@/components/Toolbar.vue';

const route = useRoute();

// Don't show toolbar on login page
const showToolbar = computed(() => route.name !== 'login');
</script>

<template>
  <div class="app">
    <Toolbar v-if="showToolbar" />
    <main>
      <RouterView />
    </main>
    <ToastContainer />
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

main {
  flex: 1;
}
</style>
