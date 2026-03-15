<script setup lang="ts">
import { useToast } from '@/composables/useToast';
import { Info, CheckCircle, AlertTriangle, XCircle } from 'lucide-vue-next';

const { toasts, remove } = useToast();
</script>

<template>
  <Teleport to="body">
    <div class="toast-container">
      <TransitionGroup name="toast">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="toast"
          :class="toast.type"
          role="alert"
          @click="remove(toast.id)"
        >
          <span class="toast-icon">
            <Info v-if="toast.type === 'info'" :size="14" />
            <CheckCircle v-else-if="toast.type === 'success'" :size="14" />
            <AlertTriangle v-else-if="toast.type === 'warning'" :size="14" />
            <XCircle v-else-if="toast.type === 'error'" :size="14" />
          </span>
          <span class="toast-message">{{ toast.message }}</span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-container {
  position: fixed;
  bottom: var(--space-5);
  right: var(--space-5);
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);
  cursor: pointer;
  pointer-events: auto;
  min-width: 220px;
  max-width: 400px;
  border-left: 4px solid transparent;
}

.toast.info    { border-left-color: var(--color-info-border); }
.toast.success { border-left-color: var(--color-success-border); }
.toast.warning { border-left-color: var(--color-warning-border); }
.toast.error   { border-left-color: var(--color-error-border); }

.toast-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.toast.info    .toast-icon { color: var(--color-info-border); }
.toast.success .toast-icon { color: var(--color-success-border); }
.toast.warning .toast-icon { color: var(--color-warning-border); }
.toast.error   .toast-icon { color: var(--color-error-border); }

.toast-message {
  font-size: var(--text-base);
  color: var(--color-text);
  flex: 1;
}

/* Transitions */
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(100px);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(100px);
}
</style>
