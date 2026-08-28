<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { AlertTriangle } from 'lucide-vue-next';
import { useConfirm, settlePending, setConfirmHostMounted } from '@/composables/useConfirm';

/**
 * The one confirm dialog for the whole app (see useConfirm.ts). Mounted in
 * App.vue; opens whenever `confirmAction()` is awaited anywhere.
 */
const { pending } = useConfirm();
const cancelRef = ref<HTMLButtonElement | null>(null);
const acceptRef = ref<HTMLButtonElement | null>(null);

onMounted(() => setConfirmHostMounted(true));
onUnmounted(() => setConfirmHostMounted(false));

// Destructive questions focus Cancel (Enter must not delete by reflex);
// neutral ones focus the accept button so Enter is the fast path.
watch(pending, async (p) => {
  if (!p) return;
  await nextTick();
  (p.danger ? cancelRef.value : acceptRef.value)?.focus();
});

function onKeydown(e: KeyboardEvent) {
  if (!pending.value) return;
  if (e.key === 'Escape') {
    e.stopPropagation();
    settlePending(false);
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="pending"
      class="confirm-overlay"
      data-testid="confirm-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      :aria-describedby="pending.message ? 'confirm-dialog-message' : undefined"
      @click.self="settlePending(false)"
      @keydown="onKeydown"
    >
      <div class="confirm-dialog" :class="{ danger: pending.danger }">
        <div class="confirm-body">
          <AlertTriangle v-if="pending.danger" :size="20" class="confirm-icon" aria-hidden="true" />
          <div>
            <h2 id="confirm-dialog-title" class="confirm-title">{{ pending.title }}</h2>
            <p v-if="pending.message" id="confirm-dialog-message" class="confirm-message">
              {{ pending.message }}
            </p>
          </div>
        </div>
        <div class="confirm-actions">
          <button
            ref="cancelRef"
            type="button"
            class="btn btn-ghost"
            data-testid="confirm-dialog-cancel"
            @click="settlePending(false)"
          >
            {{ pending.cancelLabel ?? 'Cancel' }}
          </button>
          <button
            ref="acceptRef"
            type="button"
            class="btn"
            :class="pending.danger ? 'btn-danger' : 'btn-primary'"
            data-testid="confirm-dialog-accept"
            @click="settlePending(true)"
          >
            {{ pending.confirmLabel ?? 'Confirm' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Above every other modal: a confirm can be asked from inside one
   (StylePresetModal → delete preset), and above the context menu. */
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 10002;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  padding: var(--space-4);
}

.confirm-dialog {
  width: min(420px, 100%);
  background: var(--color-surface);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xl);
  padding: var(--space-5);
}

.confirm-body {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
}

.confirm-icon {
  color: var(--color-error);
  flex-shrink: 0;
  margin-top: 2px;
}

.confirm-title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-md);
  font-weight: var(--font-semibold);
  color: var(--color-text);
  overflow-wrap: anywhere;
}

.confirm-message {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-5);
}

.btn-ghost {
  background: transparent;
  color: var(--color-text);
  border: 1px solid var(--color-border);
}
.btn-ghost:hover {
  background: var(--color-bg-muted);
}
</style>
