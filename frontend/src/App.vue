<script setup lang="ts">
import { RouterView } from 'vue-router';
import { useRoute } from 'vue-router';
import { computed } from 'vue';
import ToastContainer from '@/components/ToastContainer.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { useEscapeToCloseModals } from '@/composables/useEscapeToCloseModals';
import { useModalFocus } from '@/composables/useModalFocus';
import { useDocumentTitle } from '@/composables/useDocumentTitle';
import Toolbar from '@/components/Toolbar.vue';

const route = useRoute();

// Don't show toolbar on login page
const showToolbar = computed(() => route.name !== 'login');

// One listener for every modal in the app — see the composable for why.
useEscapeToCloseModals();
useModalFocus();
// The tab names what is open, not just the app.
useDocumentTitle();
</script>

<template>
  <div class="app">
    <Toolbar v-if="showToolbar" />
    <main>
      <RouterView />
    </main>
    <ToastContainer />
    <ConfirmDialog />
  </div>
</template>

<style scoped>
/*
 * A definite 100vh column so full-height views (the graph page) can use
 * `height: 100%` of <main> instead of guessing the toolbar height — the
 * toolbar wraps to two rows under 768px, so any `calc(100vh - Npx)` is wrong
 * somewhere. <main> stays a block (NOT a flex container: auto horizontal
 * margins on a flex item cancel `stretch`, which collapsed the centred list
 * views to their content width). Content taller than the viewport still
 * overflows <main> and scrolls the document exactly as before.
 */
.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

main {
  flex: 1;
  min-height: 0;
}
</style>
