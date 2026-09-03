/**
 * Admin area (superuser only) — mirrors api/graphlagoon/models/schemas.py
 * "Admin area" section. Everything here is served by /api/admin/*, which
 * rejects non-superusers server-side; the frontend flag only hides the UI.
 */

export interface AdminHealth {
  status: string;
  latency_ms: number | null;
  detail: string | null;
}

export interface AdminCounts {
  users: number;
  contexts: number;
  explorations: number;
  query_templates: number;
  audit_entries: number;
  groups: number;
}

export interface AdminStorage {
  exploration_snapshots: string;
  precomputed_graphs: string;
  style_presets: string;
}

export interface AdminOverview {
  version: string;
  dev_mode: boolean;
  databricks_mode: boolean;
  persistence_backend: 'memory' | 'postgres' | 'lakebase' | string;
  alembic_version: string | null;
  counts: AdminCounts;
  superusers: string[];
  storage: AdminStorage;
  /** Same payload as GET /api/config (flags, datasources, share domains…). */
  public_config: Record<string, unknown>;
  health: Record<string, AdminHealth>;
}

export interface AdminConfigEntry {
  key: string;
  env_var: string;
  value: unknown;
  kind: 'public' | 'secret';
}

export interface AdminUser {
  email: string;
  display_name: string | null;
  created_at: string | null;
  last_seen_at: string | null;
  is_superuser: boolean;
  contexts_owned: number;
  explorations_owned: number;
}

export interface AdminUserPage {
  items: AdminUser[];
  total: number;
  page: number;
  page_size: number;
}

export interface TransferOwnershipResponse {
  id: string;
  previous_owner_email: string;
  owner_email: string;
}

export interface AuditEntry {
  id: string;
  user_email: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string | null;
}

export interface AuditPage {
  items: AuditEntry[];
  total: number;
  page: number;
  page_size: number;
  /** Every known action name, for the filter dropdown. */
  actions: string[];
}

export interface ClearEnvironmentResponse {
  status: string;
  cleared: string[];
  warehouse: unknown;
}

export type AdminTab =
  | 'overview'
  | 'config'
  | 'users'
  | 'contexts'
  | 'explorations'
  | 'groups'
  | 'audit'
  | 'danger';

// --- Groups & permissions (mirrors the schemas.py block of the same name) ---

export type GroupMemberKind = 'email' | 'databricks_group';

export interface AdminGroupMember {
  id?: string;
  kind: GroupMemberKind;
  value: string;
}

export interface AdminGroup {
  id: string;
  name: string;
  description?: string | null;
  members: AdminGroupMember[];
  created_at?: string | null;
  updated_at?: string | null;
}

export interface AdminGroupPayload {
  name: string;
  description?: string | null;
  members: Array<{ kind: GroupMemberKind; value: string }>;
}

/** Health of the Databricks SCIM membership resolver (drives the banner). */
export interface ResolverStatus {
  mode: 'databricks' | 'stub';
  ttl_seconds: number;
  cached_users: number;
  errors: Array<{ email?: string; error?: string; at?: number }>;
}

export interface AdminGroupsResponse {
  items: AdminGroup[];
  resolver: ResolverStatus;
}

export type PermissionEffect = 'allow' | 'deny';
export type PermissionMode = 'everyone' | 'restricted';

export interface AdminPermissionRule {
  group_id: string;
  group_name: string;
  effect: PermissionEffect;
}

export interface AdminPermission {
  id: string;
  label: string;
  description: string;
  mode: PermissionMode;
  rules: AdminPermissionRule[];
}

export interface AdminPermissionsResponse {
  items: AdminPermission[];
  resolver: ResolverStatus;
}

export interface AdminPermissionUpdate {
  mode: PermissionMode;
  rules: Array<{ group_id: string; effect: PermissionEffect }>;
}

export interface PermissionInspection {
  email: string;
  is_superuser: boolean;
  resolved_databricks_groups: string[];
  resolution: { source: string; error?: string | null };
  group_memberships: Array<{ group_id: string; name: string; via: string }>;
  permissions: Array<{
    id: string;
    label: string;
    mode: PermissionMode;
    allowed: boolean;
    reason: string;
    matched?: { effect: PermissionEffect; group_id: string; group_name: string } | null;
  }>;
}
