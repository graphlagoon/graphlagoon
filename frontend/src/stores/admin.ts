import { defineStore } from 'pinia';
import { ref } from 'vue';
import type {
  AdminConfigEntry,
  AdminGroup,
  AdminGroupPayload,
  AdminHealth,
  AdminOverview,
  AdminPermission,
  AdminPermissionUpdate,
  AdminUser,
  AuditEntry,
  PermissionInspection,
  ResolverStatus,
} from '@/types/admin';
import type { Exploration, GraphContext } from '@/types/graph';
import { api } from '@/services/api';
import { getErrorMessage } from '@/utils/errorMessage';

/**
 * Admin area state. One loader per tab so a failing warehouse probe or a
 * slow audit page never blocks the overview. Every call goes to /api/admin/*
 * (superuser-only server-side) except the contexts/explorations listings,
 * which reuse the regular endpoints — they already return everything to a
 * superuser.
 */
export const useAdminStore = defineStore('admin', () => {
  const overview = ref<AdminOverview | null>(null);
  const warehouseHealth = ref<AdminHealth | null>(null);
  const config = ref<AdminConfigEntry[]>([]);
  const users = ref<AdminUser[]>([]);
  const usersTotal = ref(0);
  const contexts = ref<GraphContext[]>([]);
  const explorations = ref<Exploration[]>([]);
  const audit = ref<AuditEntry[]>([]);
  const auditTotal = ref(0);
  const auditActions = ref<string[]>([]);
  const groups = ref<AdminGroup[]>([]);
  const permissions = ref<AdminPermission[]>([]);
  const resolverStatus = ref<ResolverStatus | null>(null);
  const inspection = ref<PermissionInspection | null>(null);

  const loading = ref<Record<string, boolean>>({});
  const error = ref<string | null>(null);

  async function run<T>(key: string, fn: () => Promise<T>, fallback: string): Promise<T | undefined> {
    loading.value = { ...loading.value, [key]: true };
    error.value = null;
    try {
      return await fn();
    } catch (e: unknown) {
      error.value = getErrorMessage(e, fallback);
      console.error(`admin: ${fallback}`, e);
      return undefined;
    } finally {
      loading.value = { ...loading.value, [key]: false };
    }
  }

  async function fetchOverview() {
    const result = await run('overview', () => api.getAdminOverview(), 'Failed to load overview');
    if (result) overview.value = result;
  }

  async function probeWarehouse() {
    const result = await run('warehouse', () => api.probeWarehouse(), 'Warehouse probe failed');
    if (result) warehouseHealth.value = result;
  }

  async function fetchConfig() {
    const result = await run('config', () => api.getAdminConfig(), 'Failed to load config');
    if (result) config.value = result;
  }

  async function fetchUsers(params: { q?: string; page?: number; page_size?: number } = {}) {
    const result = await run('users', () => api.getAdminUsers(params), 'Failed to load users');
    if (result) {
      users.value = result.items;
      usersTotal.value = result.total;
    }
  }

  async function fetchContexts() {
    const result = await run('contexts', () => api.getGraphContexts(), 'Failed to load contexts');
    if (result) contexts.value = result;
  }

  async function fetchExplorations() {
    const result = await run('explorations', () => api.getAllExplorations(), 'Failed to load explorations');
    if (result) explorations.value = result;
  }

  async function fetchAudit(params: { page?: number; page_size?: number; user?: string; action?: string } = {}) {
    const result = await run('audit', () => api.getAuditLog(params), 'Failed to load audit log');
    if (result) {
      audit.value = result.items;
      auditTotal.value = result.total;
      auditActions.value = result.actions;
    }
  }

  async function fetchGroups() {
    const result = await run('groups', () => api.getAdminGroups(), 'Failed to load groups');
    if (result) {
      groups.value = result.items;
      resolverStatus.value = result.resolver;
    }
  }

  async function saveGroup(payload: AdminGroupPayload, groupId?: string): Promise<boolean> {
    const result = await run(
      'groupSave',
      () => (groupId ? api.updateAdminGroup(groupId, payload) : api.createAdminGroup(payload)),
      'Failed to save group',
    );
    if (!result) return false;
    if (groupId) {
      groups.value = groups.value.map((g) => (g.id === groupId ? result : g));
    } else {
      groups.value = [...groups.value, result].sort((a, b) => a.name.localeCompare(b.name));
    }
    return true;
  }

  async function deleteGroup(groupId: string): Promise<boolean> {
    const ok = await run(
      'groupDelete',
      async () => (await api.deleteAdminGroup(groupId), true),
      'Failed to delete group',
    );
    if (ok) {
      groups.value = groups.value.filter((g) => g.id !== groupId);
      // Rules referencing the group cascaded away server-side.
      permissions.value = permissions.value.map((p) => ({
        ...p,
        rules: p.rules.filter((r) => r.group_id !== groupId),
      }));
    }
    return !!ok;
  }

  async function fetchPermissions() {
    const result = await run(
      'permissions',
      () => api.getAdminPermissions(),
      'Failed to load permissions',
    );
    if (result) {
      permissions.value = result.items;
      resolverStatus.value = result.resolver;
    }
  }

  async function savePermission(permissionId: string, payload: AdminPermissionUpdate): Promise<boolean> {
    const result = await run(
      'permissionSave',
      () => api.putAdminPermission(permissionId, payload),
      'Failed to save permission',
    );
    if (!result) return false;
    permissions.value = permissions.value.map((p) => (p.id === permissionId ? result : p));
    return true;
  }

  async function inspectPermissions(email: string) {
    const result = await run(
      'inspect',
      () => api.inspectAdminPermissions(email),
      'Inspection failed',
    );
    if (result) inspection.value = result;
  }

  async function refreshGroupCache(email?: string): Promise<boolean> {
    const result = await run(
      'groupCacheRefresh',
      () => api.refreshAdminGroupCache(email),
      'Cache refresh failed',
    );
    if (result) resolverStatus.value = result;
    return !!result;
  }

  async function transferContext(contextId: string, newOwner: string): Promise<boolean> {
    const result = await run(
      'transfer',
      () => api.transferContextOwnership(contextId, newOwner),
      'Transfer failed',
    );
    if (!result) return false;
    contexts.value = contexts.value.map((c) =>
      c.id === contextId ? { ...c, owner_email: result.owner_email } : c,
    );
    return true;
  }

  async function transferExploration(explorationId: string, newOwner: string): Promise<boolean> {
    const result = await run(
      'transfer',
      () => api.transferExplorationOwnership(explorationId, newOwner),
      'Transfer failed',
    );
    if (!result) return false;
    explorations.value = explorations.value.map((e) =>
      e.id === explorationId ? { ...e, owner_email: result.owner_email } : e,
    );
    return true;
  }

  async function deleteContext(contextId: string): Promise<boolean> {
    const ok = await run('delete', async () => (await api.deleteGraphContext(contextId), true), 'Delete failed');
    if (ok) contexts.value = contexts.value.filter((c) => c.id !== contextId);
    return !!ok;
  }

  async function deleteExploration(explorationId: string): Promise<boolean> {
    const ok = await run(
      'delete',
      async () => (await api.deleteExploration(explorationId), true),
      'Delete failed',
    );
    if (ok) explorations.value = explorations.value.filter((e) => e.id !== explorationId);
    return !!ok;
  }

  async function clearEnvironment(confirm: string): Promise<boolean> {
    const result = await run('clear', () => api.clearEnvironment(confirm), 'Clear failed');
    if (!result) return false;
    contexts.value = [];
    explorations.value = [];
    return true;
  }

  return {
    overview,
    warehouseHealth,
    config,
    users,
    usersTotal,
    contexts,
    explorations,
    audit,
    auditTotal,
    auditActions,
    groups,
    permissions,
    resolverStatus,
    inspection,
    loading,
    error,
    fetchOverview,
    probeWarehouse,
    fetchConfig,
    fetchUsers,
    fetchContexts,
    fetchExplorations,
    fetchAudit,
    fetchGroups,
    saveGroup,
    deleteGroup,
    fetchPermissions,
    savePermission,
    inspectPermissions,
    refreshGroupCache,
    transferContext,
    transferExploration,
    deleteContext,
    deleteExploration,
    clearEnvironment,
  };
});
