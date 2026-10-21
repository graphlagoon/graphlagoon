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
  investigations?: number;
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
  | 'investigations'
  | 'agents'
  | 'library'
  | 'case-types'
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

/** Personal agent token (03-arquitetura §8.2); the secret is never listed. */
export interface AgentToken {
  id: string;
  owner_email: string;
  name: string;
  /** "user" (every case the owner reads) or "case" (only investigation_ids). */
  scope?: 'user' | 'case';
  investigation_ids?: string[];
  created_at: string;
  expires_at: string;
  revoked_at?: string | null;
  /** Last request with the token (bumped at most once a minute). */
  last_used_at?: string | null;
  active: boolean;
}

// --- Org library (05 §6; superusers write, everyone reads) ---

/**
 * `GET /api/org/authoring` (06): what writing case types and library docs needs.
 * The admin area's help and its "Ask an AI" prompts are built from it, so they
 * follow the code.
 */
export interface OrgAuthoring {
  /** JSON Schema of `CaseTypeSpec` (pydantic). */
  case_type_schema: Record<string, unknown>;
  report_placeholders: { key: string; description: string }[];
  mapping: {
    converters: string[];
    normalizers: string[];
    when_ops: string[];
    /** JSON Schema of an enrichment mapping's `spec`. */
    enrichment_schema: Record<string, unknown>;
  };
  suggest_kinds: { all: string[]; default: string[] };
  agent_tools: { name: string; summary: string }[];
}

export interface OrgLibraryDoc {
  slug: string;
  title: string;
  /** template: a report with {{placeholders}}; mapping: a file mapping as JSON ({as, spec}). */
  kind: 'playbook' | 'template' | 'mapping';
  body: string;
  updated_at?: string | null;
  /** The built-in playbook, not edited yet (deleting a stored one restores it). */
  seeded: boolean;
}

