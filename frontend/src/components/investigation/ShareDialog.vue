<script setup lang="ts">
/** Nominal sharing of a case (F1): named e-mails or an admin-managed group, read or write;
 * wildcards are refused; the owner manages the list. */
import { computed, ref, watch } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { getErrorMessage } from '@/utils/errorMessage';
import { confirmAction } from '@/composables/useConfirm';
import { useShareableGroups } from '@/composables/useShareableGroups';
import { groupShareValue, shareKind, shareLabel } from '@/utils/shareTargets';
import type { ShareRole } from '@/types/investigation';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const store = useInvestigationStore();
const email = ref('');
const kind = ref<'person' | 'group'>('person');
const groupId = ref('');
const role = ref<ShareRole>('reader');
const busy = ref(false);
const error = ref<string | null>(null);
const { groups, state: groupsState, load: loadGroups, nameOf } = useShareableGroups();

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    kind.value = 'person';
    groupId.value = '';
    void loadGroups();
  },
  { immediate: true },
);

/** The value to send: a group's canonical `group:<uuid>` or the typed e-mail. */
const target = computed(() => (kind.value === 'group' ? (groupId.value ? groupShareValue(groupId.value) : '') : email.value.trim()));

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
  const value = target.value;
  if (!value || busy.value) return;
  if (await run(() => store.shareInvestigation(value, role.value), 'Failed to share')) {
    email.value = '';
    groupId.value = '';
  }
}

async function unshare(target: string) {
  const ok = await confirmAction({
    title: `Stop sharing with ${shareLabel(target, nameOf)}?`,
    message: 'They lose access to the case at once; the journal keeps what they did.',
    confirmLabel: 'Remove access',
    danger: true,
  });
  if (ok) await run(() => store.unshareInvestigation(target), 'Failed to remove the share');
}

/** Changing a share's role: the share endpoint updates an existing one. */
function changeRole(target: string, next: ShareRole) {
  void run(() => store.shareInvestigation(target, next), 'Failed to change the role');
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
        Named people or a group managed by an admin: no wildcards, no domains (a case is need-to-know). Readers
        see the case; writers also change it. The owner ({{ store.current.owner_email }}) always manages it.
      </p>
      <p v-if="store.caseType?.notice" class="notice" data-testid="share-notice">{{ store.caseType.notice }}</p>
      <fieldset v-if="groups.length" class="share-kind" data-testid="share-kind">
        <legend>Share with</legend>
        <label><input v-model="kind" type="radio" value="person" /> A person</label>
        <label><input v-model="kind" type="radio" value="group" /> A group</label>
      </fieldset>
      <p v-else-if="groupsState === 'failed'" class="hint">Groups could not be loaded; you can still share with a person.</p>
      <form class="share-form" @submit.prevent="share">
        <select v-if="kind === 'group'" v-model="groupId" class="form-control" aria-label="Group" data-testid="share-group" required>
          <option value="" disabled>Choose a group…</option>
          <option v-for="g in groups" :key="g.id" :value="g.id" :title="g.description ?? ''">{{ g.name }}</option>
        </select>
        <input
          v-else
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
        <button type="submit" class="btn btn-primary" :disabled="busy || !target" data-testid="share-submit">
          Share
        </button>
      </form>
      <p v-if="error" class="error-message">{{ error }}</p>
      <ul class="share-list" data-testid="share-list">
        <li v-for="s in store.current.shared_with" :key="s.email" :data-testid="`share-row-${s.email}`">
          <span>
            <span v-if="shareKind(s.email) === 'group'" class="badge-group">Group</span>
            {{ shareLabel(s.email, nameOf, groupsState) }}
          </span>
          <select
            class="perm"
            :value="s.role"
            :disabled="busy"
            :aria-label="`Role of ${s.email}`"
            :data-testid="`share-role-${s.email}`"
            @change="changeRole(s.email, ($event.target as HTMLSelectElement).value as ShareRole)"
          >
            <option value="reader">can read</option>
            <option value="editor">can write</option>
          </select>
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
.notice {
  margin: 0 0 12px;
  padding: 8px 10px;
  border-left: 3px solid var(--color-deadline-warn);
  background: var(--bg-secondary);
  font-size: 13px;
}

.share-dialog {
  max-width: 520px;
}

.hint {
  margin: 0 16px 12px;
  font-size: 12px;
  color: var(--text-muted);
}

.share-kind {
  display: flex;
  gap: 16px;
  margin: 0 16px 8px;
  padding: 0;
  border: none;
  font-size: 13px;
}

.share-kind legend {
  padding: 0;
  margin-bottom: 4px;
  font-weight: 600;
}

.share-kind label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.badge-group {
  display: inline-block;
  margin-right: 4px;
  padding: 1px 6px;
  border-radius: 4px;
  background: #6a1b9a;
  color: white;
  font-size: 11px;
}

.share-form {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 8px;
  margin: 0 16px;
}

@media (max-width: 480px) {
  /* The target (an e-mail or a group name) must stay readable on a phone. */
  .share-form {
    grid-template-columns: 1fr;
  }
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
