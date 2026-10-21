/** Investigations v2 (cases): see docs/dev/plans/investigation/05-plano-v2.md §1. */
import type { EdgeSemantics, ExplorationState, GraphSnapshot, IdentityKey, TemplateParameter } from '@/types/graph';
import type { MappingReport } from '@/utils/fileMapping';

/** 06 §1: a case closes only by a decision that closes it; reopening goes back to analysis. */
export type InvestigationStatus = 'open' | 'analysis' | 'closed';
/** A person writes `confirmed`; an agent's writes of `settings.agent_suggest_kinds` arrive `suggested`. */
export type WriteStatus = 'suggested' | 'confirmed' | 'rejected';
export type AuthorKind = 'human' | 'agent';
export type ShareRole = 'reader' | 'editor';

export interface Investigation {
  id: string;
  title: string;
  description?: string | null;
  /** Slug of an admin-defined case type (06 §1), or the built-in "general". */
  case_type: string;
  /** Values of the case type's fields. */
  fields: Record<string, unknown>;
  /** The alert or ticket that opened the case. */
  external_ref?: string | null;
  status: InvestigationStatus;
  /** Free label from the case type's `stages` ("Waiting for documents"), no semantics. */
  stage?: string | null;
  owner_email: string;
  assignee_email?: string | null;
  occurred_at?: string | null;
  alert_at?: string | null;
  /** {open, analysis} hours, copied from the case type; editable per case. */
  sla_hours?: Record<string, number> | null;
  /** Computed by the server; null without an SLA or once closed. */
  deadline?: CaseDeadline | null;
  tags: string[];
  /** identity_keys, edge_semantics, enrichment_tables, agent_suggest_kinds, label_templates, vocabularies */
  settings: Record<string, unknown>;
  /** View only: layout, pins, views, groups_closed. */
  state: Record<string, unknown>;
  /** Append-only, oldest first (06 §1). */
  decisions: InvestigationDecision[];
  /** While closed: the hash of the decision that closed the case. */
  frozen_hash?: string | null;
  frozen_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  shared_with: { email: string; role: ShareRole }[];
  has_write_access: boolean;
  can_manage: boolean;
  /** Only on the list endpoint (the queue). */
  item_count?: number | null;
  suggested_count?: number | null;
}

export interface CaseDeadline {
  phase: 'open' | 'analysis';
  due_at: string;
  hours_left: number;
  days_left: number;
  /** Hours of the phases counted so far (the bar's 100%). */
  total_hours: number;
  /** Under 20% of the SLA left (or overdue). */
  urgent: boolean;
  overdue: boolean;
}

/** A page of the queue; `counts` are over every case the caller reads. */
export interface InvestigationPage {
  items: Investigation[];
  total: number;
  limit: number;
  offset: number;
  counts: Partial<Record<InvestigationStatus | 'total' | 'urgent' | 'overdue' | 'suggested', number>>;
}

/** `GET /api/investigations` filters (06 §2b); `fields` become `field.<id>=<op>:<value>`. */
export interface QueueParams {
  /** One status or several, comma separated (`open,analysis`). */
  status?: string;
  assignee?: string;
  case_type?: string;
  external_ref?: string;
  exploration_id?: string;
  q?: string;
  deadline?: 'urgent' | 'overdue';
  suggested?: boolean;
  fields?: Record<string, string>;
  sort?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Case types (06 §1): what the org investigates, defined in the admin area
// ---------------------------------------------------------------------------

export interface CaseTypeOutcome {
  id: string;
  label: string;
  description?: string | null;
  closes_case: boolean;
  requires_review: boolean;
}

export interface CaseTypeAction {
  id: string;
  label: string;
  due_hours?: number | null;
}

export type CaseFieldType = 'text' | 'number' | 'money' | 'date' | 'enum';

export interface CaseTypeField {
  id: string;
  label: string;
  type: CaseFieldType;
  options: string[];
  required: boolean;
  in_queue: boolean;
}

export interface CaseTypeStarterQuery {
  title: string;
  language: 'sql' | 'cypher';
  query: string;
  description?: string | null;
  parameters?: Record<string, unknown>[];
}

/** A table seen as a chart: `x` and `series` name its columns. */
export interface TableChartSpec {
  type: 'line' | 'bar';
  x: string;
  series: string[];
}

export interface ItemState {
  chart?: TableChartSpec | null;
}

export interface CaseTypeTraceDefaults {
  max_hops?: number | null;
  max_dwell_hours?: number | null;
  min_amount?: number | null;
  allocation?: 'fifo' | 'lifo' | 'proportional' | 'libr' | 'total' | null;
  stop_types?: string[] | null;
}

export interface CaseTypeSpec {
  label: string;
  description?: string | null;
  vocabularies: { roles: string[]; tags: string[]; link_attributes: string[] };
  roles_multi: boolean;
  outcomes: CaseTypeOutcome[];
  actions: CaseTypeAction[];
  stages: string[];
  fields: CaseTypeField[];
  sla_hours: { open?: number | null; analysis?: number | null };
  retention_years?: number | null;
  notice?: string | null;
  agent_suggest_kinds?: string[] | null;
  playbook?: string | null;
  starter_queries: CaseTypeStarterQuery[];
  report_templates: string[];
  /** What "Follow the money" starts with on this type's cases. */
  analysis_defaults?: { trace?: CaseTypeTraceDefaults };
}

export interface CaseType extends CaseTypeSpec {
  slug: string;
  builtin: boolean;
  updated_at?: string | null;
}

export interface DecisionEvidence {
  item_id: string;
  version: number;
  sha256: string;
}

/** Recorded by a person; each one hashes the journal up to its own event (06 §1). */
export interface InvestigationDecision {
  id: string;
  /** The case type's outcome id; null for a free outcome (a type without catalog). */
  outcome: string | null;
  /** Snapshot of the outcome's label: editing the catalog later does not rewrite history. */
  outcome_label: string;
  closes_case: boolean;
  /** Entity uids the decision is about; empty = the whole case. */
  targets: string[];
  task_ids: string[];
  rationale: string;
  evidence: DecisionEvidence[];
  reviewer_email?: string | null;
  /** Four eyes: pending until another person approves or rejects it. */
  review: 'pending' | 'approved' | 'rejected' | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  review_note?: string | null;
  decided_by: string;
  decided_at: string;
  hash: string;
  /** When it closed the case (at once, or when its review approved it). */
  closed_at?: string | null;
  proposal_id?: string | null;
  proposed_by?: { author_kind: AuthorKind; author_email: string } | null;
}

export interface DecisionTaskRequest {
  action?: string;
  title?: string;
  assignee?: string;
  assignee_kind?: 'human' | 'agent';
  agent_name?: string;
  due_at?: string;
}

/** `POST /api/investigations/{id}/decisions`. */
export interface DecisionRequest {
  /** One of the type's outcomes, or… */
  outcome?: string;
  /** …a free outcome when the type has none. */
  outcome_label?: string;
  closes_case?: boolean;
  targets?: string[];
  tasks?: DecisionTaskRequest[];
  rationale: string;
  /** The pinned versions it rests on; every pinned version when omitted. */
  evidence?: { item_id: string; version: number }[];
  reviewer_email?: string;
  /** The agent's draft (a `decision_proposal` annotation) this decision takes up. */
  proposal_id?: string;
}

/** `GET …/export?format=`; the printed report is the print of the dossier. */
export type InvestigationExportFormat = 'json' | 'csv';

export interface CreateInvestigationRequest {
  title: string;
  description?: string;
  case_type?: string;
  fields?: Record<string, unknown>;
  external_ref?: string;
  assignee_email?: string;
  tags?: string[];
  alert_at?: string;
  occurred_at?: string;
}

/** `PATCH /api/investigations/{id}`: every field optional; status must follow the transitions (409 otherwise). */
export interface UpdateInvestigationRequest {
  title?: string;
  description?: string | null;
  case_type?: string;
  /** Merged into the case's fields; a null removes one. */
  fields?: Record<string, unknown>;
  assignee_email?: string | null;
  /** Only a decision closes a case. */
  status?: Exclude<InvestigationStatus, 'closed'>;
  stage?: string | null;
  occurred_at?: string | null;
  alert_at?: string | null;
  sla_hours?: Record<string, number> | null;
  tags?: string[];
  settings?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Items: everything in the case, with versions and an author (05 §1)
// ---------------------------------------------------------------------------

export type ItemKind = 'graph' | 'table' | 'query' | 'document' | 'note';
export type GraphSubkind = 'exploration_ref' | 'snapshot' | 'selection' | 'derived' | 'view';
export type TableSubkind = 'result' | 'csv' | 'enrichment' | 'metrics';
export type QuerySubkind = 'sql' | 'cypher';
export type DocumentSubkind = 'upload' | 'markdown' | 'link' | 'brief';
export type NoteSubkind = 'free' | 'anchored';
export type ItemSubkind = GraphSubkind | TableSubkind | QuerySubkind | DocumentSubkind | NoteSubkind;

/** A saved query of the case: `:name` parameters declared like a template's. */
export interface CaseQuerySpec {
  text: string;
  language: 'sql' | 'cypher';
  parameters: TemplateParameter[];
  output: 'table' | 'graph';
}

/** How a `table` item reaches the canvas or the inspector; of the case, never a context. */
export type ItemMapping =
  | { as: 'graph'; spec: Record<string, unknown>; extra_item_ids?: string[] }
  | { as: 'enrichment'; spec: FileEnrichmentSpec };

export interface ItemProvenance {
  context_id?: string;
  exploration_id?: string;
  query_item_id?: string;
  run_id?: string;
  /** trace | paths | links | er | metrics… for analysis results. */
  tool?: string;
  params?: Record<string, unknown>;
  parent_item_id?: string;
  tool_call_id?: string;
  filename?: string;
  [key: string]: unknown;
}

export interface ItemAnchor {
  entity_ids?: string[];
  edge_ids?: string[];
  item_id?: string;
}

export interface CaseItemVersion {
  id: string;
  item_id: string;
  version: number;
  sha256: string;
  size_bytes: number;
  content_type: string;
  has_text: boolean;
  /** {statement_id, started_at, duration_ms, row_count, params, run_by, author_kind, output} of a query run. */
  run?: Record<string, unknown> | null;
  created_by: string;
  author_kind: AuthorKind;
  created_at?: string | null;
  pinned_at?: string | null;
  pinned_by?: string | null;
  pin_label?: string | null;
}

export interface CaseItem {
  id: string;
  kind: ItemKind;
  subkind: ItemSubkind;
  title: string;
  description?: string | null;
  tags: string[];
  status: WriteStatus;
  author_kind: AuthorKind;
  author_email: string;
  agent_token_id?: string | null;
  provenance: ItemProvenance;
  exploration_id?: string | null;
  context_id?: string | null;
  query?: CaseQuerySpec | null;
  mapping?: ItemMapping | null;
  anchor?: ItemAnchor | null;
  /** View only, never a version (06 P5): a table seen as a chart. */
  state?: ItemState | null;
  current_version: number;
  position: number;
  created_at?: string | null;
  updated_at?: string | null;
  deleted_at?: string | null;
  /** False when the item's graph context is not readable by the caller. */
  accessible: boolean;
  latest?: CaseItemVersion | null;
  /** Pinned versions = the evidence. */
  pinned: CaseItemVersion[];
}

export interface CreateItemRequest {
  kind: ItemKind;
  subkind: ItemSubkind;
  title?: string;
  description?: string;
  tags?: string[];
  provenance?: ItemProvenance;
  exploration_id?: string;
  context_id?: string;
  query?: CaseQuerySpec;
  mapping?: ItemMapping;
  anchor?: ItemAnchor;
  state?: ItemState | null;
  /** Version 1: text (markdown, notes, csv) or JSON (snapshots, results). */
  content?: string;
  content_json?: unknown;
}

export interface UpdateItemRequest {
  title?: string;
  description?: string | null;
  tags?: string[];
  mapping?: ItemMapping | null;
  query?: CaseQuerySpec;
  anchor?: ItemAnchor | null;
  state?: ItemState | null;
  position?: number;
}

/** `POST …/items/compare`: two tables (or two runs of one query) diffed by key. */
export interface TableDiff {
  key_column: string;
  columns: { left: string[]; right: string[]; shared: string[] };
  counts: { left: number; right: number; only_left: number; only_right: number; changed: number; same: number };
  only_left: unknown[][];
  only_right: unknown[][];
  changed: { key: string; fields: Record<string, { left: unknown; right: unknown }> }[];
  truncated: boolean;
  left: { item_id: string; title: string; version: number };
  right: { item_id: string; title: string; version: number };
}

export interface ItemSearchHit extends CaseItem {
  match: 'title' | 'text';
  snippet?: string | null;
}

/** `GET …/items/{id}/snapshot`: what one graph item puts on the canvas. */
export interface ItemSnapshotPayload {
  item_id: string;
  title: string;
  context_id: string | null;
  snapshot: GraphSnapshot | null;
  identity_keys: IdentityKey[];
  edge_semantics: EdgeSemantics | null;
  exploration?: { id: string; title: string; state: ExplorationState } | null;
  report?: MappingReport & { truncated_edges: number };
  /** A derived item (links analysis, a saved selection): node ids are unified ids already. */
  unified?: boolean;
}

/** `value` of a `group` annotation (05 §5). */
export interface GroupValue {
  name: string;
  /** Hex color, or an index into the 8-color group palette. */
  color?: string | number;
  /** How it was made: selection | property:<name> | role | tag | community | component. */
  by?: string;
}

/** Content of a `graph/view` item: chips, layout and closed groups (05 §5). */
export interface CaseViewContent {
  filters: {
    sources: string[];
    roles: string[];
    tags: string[];
    groups: string[];
    types: string[];
    window: [number, number] | null;
  };
  layout: string;
  groups_closed: string[];
}

export interface CaseBrief {
  item: CaseItem | null;
  text: string;
}

// ---------------------------------------------------------------------------
// Annotations over entities or items
// ---------------------------------------------------------------------------

export type AnnotationKind =
  | 'role'
  | 'tag'
  | 'group'
  | 'same_as'
  | 'hypothesis'
  | 'hypothesis_status'
  | 'status_change'
  | 'task'
  | 'decision_proposal';
export type HypothesisStatus = 'open' | 'supported' | 'refuted';
export type TaskState = 'open' | 'done' | 'cancelled';

/** `value` of a `task` annotation (06 §1): a follow-up for a person or an agent. */
export interface TaskValue {
  title: string;
  state: TaskState;
  assignee_kind: 'human' | 'agent';
  /** A person's e-mail. */
  assignee?: string | null;
  /** The agent token's name that picks it up; empty = any agent. */
  agent_name?: string | null;
  due_at?: string | null;
  /** The case type's action it came from. */
  action?: string | null;
  decision_id?: string | null;
}

/** `GET /api/investigations/entities/cases?uid=`: a case where the entity is present or of interest (06 P7). */
export interface EntityCase {
  investigation_id: string;
  title: string;
  status: InvestigationStatus;
  case_type: string;
  case_type_label: string;
  updated_at?: string | null;
  /** On the case's unified graph (else only annotated or decided on). */
  present: boolean;
  label?: string | null;
  node_type?: string | null;
  roles: string[];
  tags: string[];
  groups: string[];
  tasks: string[];
  decisions: { id: string; outcome_label: string; decided_at: string; review?: string | null; closes_case: boolean }[];
}

/** `GET /api/investigations/tasks`: a task with its case. */
export interface CaseTaskRow extends CaseAnnotation {
  investigation_id: string;
  case_title: string;
  case_status: InvestigationStatus;
  overdue: boolean;
}

export interface CaseAnnotation {
  id: string;
  kind: AnnotationKind;
  /** Unified entity ids (role, tag, group, same_as) or annotation/item ids. */
  targets: string[];
  value: Record<string, any>;
  reason?: string | null;
  status: WriteStatus;
  author_kind: AuthorKind;
  author_email: string;
  agent_token_id?: string | null;
  confirmed_by?: string | null;
  confirmed_at?: string | null;
  created_at?: string | null;
}

export interface CreateAnnotationRequest {
  kind: AnnotationKind;
  targets?: string[];
  value?: Record<string, unknown>;
  reason?: string;
}

/** Journal entry: append-only, oldest first. */
export interface InvestigationEvent {
  id: string;
  at: string;
  actor_email: string;
  /** 'agent' when an agent token acted on behalf of actor_email. */
  actor_kind?: AuthorKind;
  agent_name?: string | null;
  kind: string;
  payload: Record<string, unknown>;
}

/** How a `table` item with `mapping.as = enrichment` joins the case's nodes (`FileEnrichmentSpec` on the server). */
export interface FileEnrichmentSpec {
  version?: 1;
  kind?: 'enrichment';
  name: string;
  input: { delimiter: string; header: boolean; columns?: string[]; encoding?: string | null };
  key_column: string;
  columns: string[];
  match_node_types: string[];
  match_source: 'node_id' | { kind: 'prop'; name: string };
  /** Node key → its first N digits (a company id → its group prefix, to match a related table). */
  key_digits?: number | null;
}
