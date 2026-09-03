<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { useAdminStore } from '@/stores/admin';
import { useToast } from '@/composables/useToast';
import type { AdminPermission, PermissionEffect, PermissionMode } from '@/types/admin';

/**
 * One row per catalog permission: its mode (everyone | restricted) and a
 * chip per group cycling — → ALLOW → DENY → —. Evaluation order (also shown
 * to the admin): superuser bypasses, deny wins, restricted needs an allow
 * match, everyone allows. Each row saves as a full replacement PUT.
 */
const admin = useAdminStore();
const toast = useToast();

interface RowDraft {
  mode: PermissionMode;
  effects: Record<string, PermissionEffect | null>; // group_id → effect
}

const drafts = reactive<Record<string, RowDraft>>({});

function draftFrom(permission: AdminPermission): RowDraft {
  const effects: Record<string, PermissionEffect | null> = {};
  for (const group of admin.groups) effects[group.id] = null;
  for (const rule of permission.rules) effects[rule.group_id] = rule.effect;
  return { mode: permission.mode, effects };
}

// Re-seed drafts whenever the store's permissions or groups change (load,
// save round-trip, group create/delete). Unsaved edits on OTHER rows are kept.
watch(
  () => [admin.permissions, admin.groups] as const,
  () => {
    for (const permission of admin.permissions) {
      const fresh = draftFrom(permission);
      const current = drafts[permission.id];
      if (!current || !isDirty(permission)) {
        drafts[permission.id] = fresh;
      } else {
        // keep the user's edits, but add/remove group columns
        const merged: RowDraft = { mode: current.mode, effects: {} };
        for (const group of admin.groups) {
          merged.effects[group.id] = current.effects[group.id] ?? null;
        }
        drafts[permission.id] = merged;
      }
    }
  },
  { immediate: true, deep: true },
);

function isDirty(permission: AdminPermission): boolean {
  const draft = drafts[permission.id];
  if (!draft) return false;
  const saved = draftFrom(permission);
  if (draft.mode !== saved.mode) return true;
  return Object.keys(draft.effects).some(
    (gid) => (draft.effects[gid] ?? null) !== (saved.effects[gid] ?? null),
  );
}

function cycle(permissionId: string, groupId: string) {
  const draft = drafts[permissionId];
  if (!draft) return;
  const current = draft.effects[groupId] ?? null;
  draft.effects[groupId] = current === null ? 'allow' : current === 'allow' ? 'deny' : null;
}

const hasGroups = computed(() => admin.groups.length > 0);

/** restricted with zero allow rules locks everyone but superusers out. */
function lockoutWarning(permissionId: string): boolean {
  const draft = drafts[permissionId];
  if (!draft || draft.mode !== 'restricted') return false;
  return !Object.values(draft.effects).some((e) => e === 'allow');
}

async function save(permission: AdminPermission) {
  const draft = drafts[permission.id];
  if (!draft) return;
  const rules = Object.entries(draft.effects)
    .filter((entry): entry is [string, PermissionEffect] => entry[1] !== null)
    .map(([group_id, effect]) => ({ group_id, effect }));
  const ok = await admin.savePermission(permission.id, { mode: draft.mode, rules });
  if (ok) toast.success(`Saved ${permission.id}`);
}
</script>

<template>
  <div>
    <div class="search-bar card">
      <h3 class="panel-title">Permissions</h3>
      <span class="muted">deny wins · restricted needs an allow · superusers bypass</span>
    </div>

    <div v-if="admin.loading.permissions && admin.permissions.length === 0" class="loading"></div>
    <div v-else class="card" data-testid="admin-permissions-matrix">
      <div
        v-for="p in admin.permissions"
        :key="p.id"
        class="permission-row"
        :data-permission="p.id"
      >
        <div class="permission-head">
          <div>
            <div class="list-item-title">
              {{ p.label }} <code class="permission-id">{{ p.id }}</code>
            </div>
            <div class="list-item-subtitle">{{ p.description }}</div>
          </div>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :data-testid="`admin-permission-save-${p.id}`"
            :disabled="!isDirty(p) || admin.loading.permissionSave"
            :title="isDirty(p) ? 'Save this permission' : 'No changes'"
            @click="save(p)"
          >
            Save
          </button>
        </div>

        <div class="permission-controls">
          <label class="mode-label">
            Mode
            <select
              v-model="drafts[p.id].mode"
              class="form-control mode-select"
              :data-testid="`admin-permission-mode-${p.id}`"
            >
              <option value="everyone">everyone (default)</option>
              <option value="restricted">restricted</option>
            </select>
          </label>

          <div v-if="hasGroups" class="group-chips">
            <button
              v-for="g in admin.groups"
              :key="g.id"
              type="button"
              class="chip"
              :class="drafts[p.id].effects[g.id] || 'none'"
              :data-testid="`admin-permission-chip-${p.id}-${g.name}`"
              :title="`Click to cycle: — → allow → deny (group ${g.name})`"
              @click="cycle(p.id, g.id)"
            >
              {{ g.name }}
              <span class="chip-effect">{{ drafts[p.id].effects[g.id] ?? '—' }}</span>
            </button>
          </div>
          <span v-else class="muted">Create a group to add rules.</span>
        </div>

        <p v-if="lockoutWarning(p.id)" class="lockout-warning" data-testid="admin-permission-lockout">
          Restricted with no allow rule: only superusers will hold this permission.
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel-title {
  margin: 0;
  flex: 1;
}
.permission-row {
  padding: var(--space-3, 12px) 0;
  border-bottom: 1px solid var(--border-color, #e5e7eb);
}
.permission-row:last-child {
  border-bottom: none;
}
.permission-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3, 12px);
}
.permission-id {
  font-size: var(--text-sm, 0.875rem);
  color: var(--text-secondary);
}
.permission-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3, 12px);
  margin-top: var(--space-2, 8px);
}
.mode-label {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  font-size: var(--text-sm, 0.875rem);
  color: var(--text-secondary);
}
.mode-select {
  width: auto;
}
.group-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2, 8px);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1, 4px);
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--border-color, #d1d5db);
  background: transparent;
  cursor: pointer;
  font-size: var(--text-sm, 0.875rem);
}
.chip.allow {
  border-color: var(--color-success, #059669);
  color: var(--color-success, #059669);
}
.chip.deny {
  border-color: var(--color-danger, #b91c1c);
  color: var(--color-danger, #b91c1c);
}
.chip-effect {
  font-weight: 600;
  text-transform: uppercase;
  font-size: 0.7rem;
}
.lockout-warning {
  margin: var(--space-2, 8px) 0 0;
  color: var(--color-warning, #b45309);
  font-size: var(--text-sm, 0.875rem);
}
</style>
