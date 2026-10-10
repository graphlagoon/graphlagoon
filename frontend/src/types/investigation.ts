/** Investigations v2 (cases): see docs/dev/plans/investigation/05-plano-v2.md §1. */
import type { EdgeSemantics, ExplorationState, GraphSnapshot, IdentityKey, TemplateParameter } from '@/types/graph';
import type { MappingReport } from '@/utils/fileMapping';

export type InvestigationStatus = 'open' | 'analysis' | 'decided' | 'archived';
export type KindPreset = 'credito' | 'garantia' | 'pix_med' | 'lavagem' | 'lojista' | 'fraude_sintetica' | 'livre';
/** A person writes `confirmed`; an agent's writes of `settings.agent_suggest_kinds` arrive `suggested`. */
export type WriteStatus = 'suggested' | 'confirmed' | 'rejected';
export type AuthorKind = 'human' | 'agent';
export type ShareRole = 'reader' | 'editor';

export interface Investigation {
  id: string;
  title: string;
  description?: string | null;
  kind_preset: KindPreset;
  status: InvestigationStatus;
  owner_email: string;
  assignee_email?: string | null;
  occurred_at?: string | null;
  alert_at?: string | null;
  /** {open, analysis} days; overrides the preset's phases (Pix/MED: 45 + 45 from alert_at). */
  deadline_days?: Record<string, number> | null;
  /** Computed by the server; null without phases or once decided/archived. */
  deadline?: { phase: 'open' | 'analysis'; due_at: string; days_left: number } | null;
  tags: string[];
  /** identity_keys, edge_semantics, enrichment_tables, agent_suggest_kinds, label_templates, vocabularies */
  settings: Record<string, unknown>;
  /** View only: layout, pins, views, groups_closed. */
  state: Record<string, unknown>;
  decision?: InvestigationDecision | null;
  /** sha256 of the journal and the pinned versions at the decision. */
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

export type DecisionOutcome = 'comunicar' | 'arquivar';
export type DecisionAction = 'dict' | 'spa' | 'bloqueio_cautelar';

/** Recorded once by a person; the case is read-only afterwards. */
export interface InvestigationDecision {
  outcome: DecisionOutcome;
  actions: DecisionAction[];
  rationale: string;
  decided_by: string;
  decided_at: string;
}

/** `GET …/export?format=`; the laudo is the print of the dossier. */
export type InvestigationExportFormat = 'json' | 'csv' | 'simba' | 'siscoaf';

export interface CreateInvestigationRequest {
  title: string;
  description?: string;
  kind_preset?: KindPreset;
  assignee_email?: string;
  tags?: string[];
  alert_at?: string;
  occurred_at?: string;
}

/** `PATCH /api/investigations/{id}`: every field optional; status must follow the transitions (409 otherwise). */
export interface UpdateInvestigationRequest {
  title?: string;
  description?: string | null;
  kind_preset?: KindPreset;
  assignee_email?: string | null;
  status?: Exclude<InvestigationStatus, 'decided'>;
  occurred_at?: string | null;
  alert_at?: string | null;
  deadline_days?: Record<string, number> | null;
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
  /** trace | paths | typologies | er | metrics… for analysis results. */
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
  position?: number;
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
  | 'typology'
  | 'status_change';
export type HypothesisStatus = 'open' | 'supported' | 'refuted';

export interface CaseAnnotation {
  id: string;
  kind: AnnotationKind;
  /** Unified entity ids (role, tag, group, same_as, typology) or annotation/item ids. */
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
  /** Node key → its digits, first N (CNPJ → CNPJ básico for the QSA). */
  key_digits?: number | null;
}
