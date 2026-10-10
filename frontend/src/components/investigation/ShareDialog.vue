<script setup lang="ts">
/** Nominal sharing of a case (F1): named e-mails only, read or write; the owner manages the list. */
import { ref } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { getErrorMessage } from '@/utils/errorMessage';
import type { ShareRole } from '@/types/investigation';

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const store = useInvestigationStore();
const email = ref('');
const role = ref<ShareRole>('reader');
const busy = ref(false);
const error = ref<string | null>(null);

async function run(action: () => Promise<unknown>, fallback: string) {
  busy.value = true;
  error.value = null;
  try {
    await action();
    return true;
  } catch (e) {
    error.value = getErrorMessage(e, fallback);
    return false;
  } finally {
    busy.value = false;
  }
}

async function share() {
  const target = email.value.trim();
  if (!target || busy.value) return;
  if (await run(() => store.shareInvestigation(target, role.value), 'Failed to share')) email.value = '';
}

function unshare(target: string) {
  void run(() => store.unshareInvestigation(target), 'Failed to remove the share');
}
</script>

<template>
  <div v-if="open && store.current" class="modal-overlay" @click.self="emit('close')">
    <div class="modal share-dialog" data-testid="share-dialog">
      <div class="modal-header">
        <h2>Share “{{ store.current.title }}”</h2>
        <button class="modal-close" aria-label="Close" @click="emit('close')">&times;</button>
      </div>
      <p class="hint">
        Named people only: no wildcards, no domains (tipping-off prohibition). Readers see the case; writers also
        change it. The owner ({{ store.current.owner_email }}) always manages it.
      </p>
      <form class="share-form" @submit.prevent="share">
        <input
          v-model="email"
          type="email"
          class="form-control"
          placeholder="person@company.com"
          data-testid="share-email"
          required
        />
        <select v-model="role" class="form-control" data-testid="share-permission">
          <option value="reader">can read</option>
          <option value="editor">can write</option>
        </select>
        <button type="submit" class="btn btn-primary" :disabled="busy || !email.trim()" data-testid="share-submit">
          Share
        </button>
      </form>
      <p v-if="error" class="error-message">{{ error }}</p>
      <ul class="share-list" data-testid="share-list">
        <li v-for="s in store.current.shared_with" :key="s.email" :data-testid="`share-row-${s.email}`">
          <span>{{ s.email }}</span>
          <span class="perm">{{ s.role === 'editor' ? 'can write' : 'can read' }}</span>
          <button
            type="button"
            class="link-btn"
            :disabled="busy"
            :data-testid="`share-remove-${s.email}`"
            @click="unshare(s.email)"
          >
            remove
          </button>
        </li>
        <li v-if="!store.current.shared_with.length" class="hint">Not shared with anyone yet.</li>
      </ul>
      <div class="modal-footer">
        <button type="button" class="btn btn-outline" @click="emit('close')">Done</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.share-dialog {
  max-width: 520px;
}

.hint {
  margin: 0 16px 12px;
  font-size: 12px;
  color: var(--text-muted);
}

.share-form {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 8px;
  margin: 0 16px;
}

.error-message {
  margin: 8px 16px 0;
}

.share-list {
  margin: 12px 16px 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
}

.share-list li {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-color);
}

.share-list li span:first-child {
  flex: 1;
}

.perm {
  color: var(--text-muted);
}

.link-btn {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--color-primary);
  cursor: pointer;
}
</style>
