<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AdminGroup, AdminGroupPayload, GroupMemberKind } from '@/types/admin';

/**
 * Create/edit a permission group. The server re-validates (name uniqueness,
 * email shape, lowercasing) — this is only the friendly first pass, like
 * TransferOwnershipModal.
 */
const props = defineProps<{
  open: boolean;
  /** null ⇒ creating a new group. */
  group: AdminGroup | null;
  busy?: boolean;
  /** Known user emails for the datalist suggestions. */
  suggestions?: string[];
}>();

const emit = defineEmits<{
  close: [];
  confirm: [payload: AdminGroupPayload];
}>();

interface MemberRow {
  kind: GroupMemberKind;
  value: string;
}

const name = ref('');
const description = ref('');
const members = ref<MemberRow[]>([]);
const newKind = ref<GroupMemberKind>('email');
const newValue = ref('');

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    name.value = props.group?.name ?? '';
    description.value = props.group?.description ?? '';
    members.value = (props.group?.members ?? []).map((m) => ({ kind: m.kind, value: m.value }));
    newKind.value = 'email';
    newValue.value = '';
  },
);

function addMember() {
  const value = newValue.value.trim().toLowerCase();
  if (!value) return;
  if (members.value.some((m) => m.kind === newKind.value && m.value === value)) {
    newValue.value = '';
    return;
  }
  members.value = [...members.value, { kind: newKind.value, value }];
  newValue.value = '';
}

function removeMember(index: number) {
  members.value = members.value.filter((_, i) => i !== index);
}

const validationError = computed(() => {
  if (!name.value.trim()) return null;
  if (name.value.trim().length > 100) return 'Name must be at most 100 characters';
  const badEmail = members.value.find(
    (m) => m.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.value),
  );
  if (badEmail) return `"${badEmail.value}" is not a valid e-mail`;
  return null;
});
const canConfirm = computed(() => !!name.value.trim() && !validationError.value && !props.busy);

function submit() {
  if (!canConfirm.value) return;
  emit('confirm', {
    name: name.value.trim(),
    description: description.value.trim() || null,
    members: members.value.map((m) => ({ kind: m.kind, value: m.value })),
  });
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-overlay" data-testid="admin-group-modal" @click.self="emit('close')">
      <div class="modal">
        <div class="modal-header">
          <h2>{{ group ? `Edit group: ${group.name}` : 'New group' }}</h2>
          <button class="modal-close" aria-label="Close" @click="emit('close')">&times;</button>
        </div>

        <form @submit.prevent="submit">
          <div class="form-group">
            <label for="group-name">Name</label>
            <input
              id="group-name"
              v-model="name"
              type="text"
              class="form-control"
              data-testid="admin-group-name"
              placeholder="graph-builders"
              autocomplete="off"
            />
          </div>

          <div class="form-group">
            <label for="group-description">Description</label>
            <input
              id="group-description"
              v-model="description"
              type="text"
              class="form-control"
              data-testid="admin-group-description"
              placeholder="Who is in it, and why"
              autocomplete="off"
            />
          </div>

          <div class="form-group">
            <label>Members</label>
            <p class="member-hint">
              Emails match exactly; a Databricks group grants membership to its
              direct workspace members (resolved via SCIM, cached ~10 min).
            </p>
            <div
              v-for="(m, i) in members"
              :key="`${m.kind}:${m.value}`"
              class="member-row"
              data-testid="admin-group-member-row"
            >
              <span class="badge" :class="m.kind === 'email' ? 'badge-secondary' : 'badge-info'">
                {{ m.kind === 'email' ? 'email' : 'databricks group' }}
              </span>
              <span class="member-value">{{ m.value }}</span>
              <button
                type="button"
                class="btn btn-outline btn-sm"
                :aria-label="`Remove ${m.value}`"
                @click="removeMember(i)"
              >
                &times;
              </button>
            </div>

            <div class="member-add">
              <select v-model="newKind" class="form-control member-kind" data-testid="admin-group-member-kind">
                <option value="email">email</option>
                <option value="databricks_group">databricks group</option>
              </select>
              <input
                v-model="newValue"
                type="text"
                class="form-control"
                data-testid="admin-group-member-value"
                :list="newKind === 'email' ? 'admin-group-member-suggestions' : undefined"
                :placeholder="newKind === 'email' ? 'someone@company.com' : 'workspace group name'"
                autocomplete="off"
                @keydown.enter.prevent="addMember"
              />
              <datalist id="admin-group-member-suggestions">
                <option v-for="s in suggestions || []" :key="s" :value="s" />
              </datalist>
              <button
                type="button"
                class="btn btn-outline btn-sm"
                data-testid="admin-group-member-add"
                @click="addMember"
              >
                Add
              </button>
            </div>

            <p v-if="validationError" class="form-error" data-testid="admin-group-error">
              {{ validationError }}
            </p>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" @click="emit('close')">Cancel</button>
            <button
              type="submit"
              class="btn btn-primary"
              data-testid="admin-group-confirm"
              :disabled="!canConfirm"
            >
              {{ busy ? 'Saving…' : group ? 'Save group' : 'Create group' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.member-hint {
  margin: 0 0 var(--space-2, 8px);
  color: var(--text-secondary);
  font-size: var(--text-sm, 0.875rem);
}
.member-row {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  padding: var(--space-1, 4px) 0;
}
.member-value {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.member-add {
  display: flex;
  gap: var(--space-2, 8px);
  margin-top: var(--space-2, 8px);
}
.member-kind {
  max-width: 11rem;
}
.form-error {
  margin-top: var(--space-1, 4px);
  color: var(--color-danger, #b91c1c);
  font-size: var(--text-sm, 0.875rem);
}
</style>
