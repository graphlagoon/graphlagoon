<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAdminStore } from '@/stores/admin';
import { useToast } from '@/composables/useToast';
import { confirmAction } from '@/composables/useConfirm';
import GroupEditorModal from '@/components/admin/GroupEditorModal.vue';
import type { AdminGroup, AdminGroupPayload } from '@/types/admin';

/**
 * Permission groups: the principals that permission rules point at. The
 * resolver banner surfaces SCIM lookup failures (stale-on-error means rules
 * keep using the last-known-good membership until refresh/recovery).
 */
const admin = useAdminStore();
const toast = useToast();

const editorOpen = ref(false);
const editing = ref<AdminGroup | null>(null);

const emailSuggestions = computed(() => admin.users.map((u) => u.email));

/** How many permission rules reference each group (from the loaded matrix). */
const rulesByGroup = computed(() => {
  const counts: Record<string, number> = {};
  for (const permission of admin.permissions) {
    for (const rule of permission.rules) {
      counts[rule.group_id] = (counts[rule.group_id] || 0) + 1;
    }
  }
  return counts;
});

function memberSummary(group: AdminGroup): string {
  const emails = group.members.filter((m) => m.kind === 'email').length;
  const databricks = group.members.filter((m) => m.kind === 'databricks_group').length;
  const rules = rulesByGroup.value[group.id] || 0;
  return `${emails} email${emails === 1 ? '' : 's'} · ${databricks} Databricks group${
    databricks === 1 ? '' : 's'
  } · ${rules} rule${rules === 1 ? '' : 's'}`;
}

function openCreate() {
  editing.value = null;
  editorOpen.value = true;
}

function openEdit(group: AdminGroup) {
  editing.value = group;
  editorOpen.value = true;
}

async function onConfirm(payload: AdminGroupPayload) {
  const ok = await admin.saveGroup(payload, editing.value?.id);
  if (ok) {
    editorOpen.value = false;
    toast.success(editing.value ? 'Group updated' : 'Group created');
  }
}

async function onDelete(group: AdminGroup) {
  const rules = rulesByGroup.value[group.id] || 0;
  const ok = await confirmAction({
    title: `Delete group "${group.name}"?`,
    message:
      rules > 0
        ? `${rules} permission rule${rules === 1 ? '' : 's'} referencing it will be removed too.`
        : 'It is not referenced by any permission rule.',
    confirmLabel: 'Delete group',
    danger: true,
  });
  if (!ok) return;
  if (await admin.deleteGroup(group.id)) toast.success(`Deleted "${group.name}"`);
}

async function refreshCache() {
  if (await admin.refreshGroupCache()) toast.success('Membership cache cleared');
}
</script>

<template>
  <div>
    <div
      v-if="admin.resolverStatus && admin.resolverStatus.errors.length > 0"
      class="resolver-banner card"
      data-testid="admin-resolver-banner"
    >
      <strong>Databricks membership lookups are failing.</strong>
      Rules keep using the last-known-good membership; users never resolved
      simply don't match Databricks-group members.
      <ul>
        <li v-for="e in admin.resolverStatus.errors.slice(0, 3)" :key="e.email">
          <code>{{ e.email }}</code>: {{ e.error }}
        </li>
      </ul>
      <button
        type="button"
        class="btn btn-outline btn-sm"
        data-testid="admin-resolver-refresh"
        :disabled="admin.loading.groupCacheRefresh"
        @click="refreshCache"
      >
        {{ admin.loading.groupCacheRefresh ? 'Refreshing…' : 'Refresh cache' }}
      </button>
    </div>

    <div class="search-bar card">
      <h3 class="panel-title">Groups</h3>
      <span class="muted">{{ admin.groups.length }} groups</span>
      <button
        type="button"
        class="btn btn-primary btn-sm"
        data-testid="admin-group-create"
        @click="openCreate"
      >
        + New group
      </button>
    </div>

    <div v-if="admin.loading.groups && admin.groups.length === 0" class="loading"></div>
    <div v-else-if="admin.groups.length === 0" class="empty-state card">
      <h3>No groups yet</h3>
      <p>Create a group, then point permission rules at it below.</p>
    </div>
    <div v-else class="card" data-testid="admin-groups-list">
      <div v-for="g in admin.groups" :key="g.id" class="list-item" :data-group="g.name">
        <div class="list-item-content">
          <div class="list-item-title">{{ g.name }}</div>
          <div class="list-item-subtitle">
            <template v-if="g.description">{{ g.description }} · </template>{{ memberSummary(g) }}
          </div>
        </div>
        <div class="list-item-actions">
          <button type="button" class="btn btn-outline btn-sm" @click="openEdit(g)">Edit</button>
          <button type="button" class="btn btn-outline btn-sm" @click="onDelete(g)">Delete</button>
        </div>
      </div>
    </div>

    <GroupEditorModal
      :open="editorOpen"
      :group="editing"
      :busy="admin.loading.groupSave"
      :suggestions="emailSuggestions"
      @close="editorOpen = false"
      @confirm="onConfirm"
    />
  </div>
</template>

<style scoped>
.panel-title {
  margin: 0;
  flex: 1;
}
.resolver-banner {
  border-left: 3px solid var(--color-warning, #d97706);
  margin-bottom: var(--space-3, 12px);
}
.resolver-banner ul {
  margin: var(--space-2, 8px) 0;
  padding-left: var(--space-4, 16px);
}
</style>
