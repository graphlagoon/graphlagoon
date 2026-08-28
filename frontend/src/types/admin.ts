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

export type AdminTab = 'overview' | 'config' | 'users' | 'contexts' | 'explorations' | 'audit' | 'danger';
