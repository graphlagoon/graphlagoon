<script setup lang="ts">
import { computed, ref, watch } from 'vue';

/**
 * Ownership transfer confirmation. The server validates the e-mail again
 * (no wildcards, no public sentinel) — this is only the friendly first pass.
 */
const props = defineProps<{
  open: boolean;
  kind: 'context' | 'exploration';
  title: string;
  currentOwner: string;
  busy?: boolean;
  /** Known users for the datalist suggestions. */
  suggestions?: string[];
}>();

const emit = defineEmits<{
  close: [];
  confirm: [newOwner: string];
}>();

const newOwner = ref('');

watch(
  () => props.open,
  (open) => {
    if (open) newOwner.value = '';
  },
);

const trimmed = computed(() => newOwner.value.trim());
const validationError = computed(() => {
  const v = trimmed.value;
  if (!v) return null;
  if (v === '*' || v.startsWith('*@')) return 'Owner must be a single user, not a wildcard';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'Enter a valid e-mail';
  if (v.toLowerCase() === props.currentOwner.toLowerCase()) return 'Already the owner';
  return null;
});
const canConfirm = computed(() => !!trimmed.value && !validationError.value && !props.busy);

function submit() {
  if (canConfirm.value) emit('confirm', trimmed.value);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-overlay" data-testid="admin-transfer-modal" @click.self="emit('close')">
      <div class="modal">
        <div class="modal-header">
          <h2>Transfer {{ kind }}</h2>
          <button class="modal-close" aria-label="Close" @click="emit('close')">&times;</button>
        </div>

        <form @submit.prevent="submit">
          <p class="transfer-summary">
            <strong>{{ title }}</strong> is owned by <code>{{ currentOwner }}</code>.
            The new owner gets full control; the previous owner keeps no implicit access.
          </p>

          <div class="form-group">
            <label for="transfer-owner">New owner e-mail</label>
            <input
              id="transfer-owner"
              v-model="newOwner"
              type="email"
              class="form-control"
              list="admin-transfer-suggestions"
              data-testid="admin-transfer-input"
              placeholder="someone@company.com"
              autocomplete="off"
            />
            <datalist id="admin-transfer-suggestions">
              <option v-for="s in suggestions || []" :key="s" :value="s" />
            </datalist>
            <p v-if="validationError" class="form-error" data-testid="admin-transfer-error">
              {{ validationError }}
            </p>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" @click="emit('close')">Cancel</button>
            <button
              type="submit"
              class="btn btn-primary"
              data-testid="admin-transfer-confirm"
              :disabled="!canConfirm"
            >
              {{ busy ? 'Transferring…' : 'Transfer ownership' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.transfer-summary {
  margin: 0 0 var(--space-4, 16px);
  color: var(--text-secondary);
  line-height: 1.5;
}
.form-error {
  margin-top: var(--space-1, 4px);
  color: var(--color-danger, #b91c1c);
  font-size: var(--text-sm, 0.875rem);
}
</style>
