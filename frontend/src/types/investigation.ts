/** Investigations (cases): see docs/dev/plans/investigation/03-arquitetura.md §3. */
import type { ExplorationState, GraphSnapshot } from '@/types/graph';
import type { MappingReport } from '@/utils/fileMapping';

export type InvestigationStatus = 'selecao' | 'analise' | 'decidido' | 'arquivado';

export interface Investigation {
  id: string;
  title: string;
  description?: string | null;
  owner_email: string;
  assignee_email?: string | null;
  status: InvestigationStatus;
  typology?: string | null;
  origin?: string | null;
  selected_at?: string | null;
  state: Record<string, unknown>;
  decision?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
  shared_with: { email: string; permission: 'read' | 'write' }[];
  has_write_access: boolean;
  can_manage: boolean;
  /** Only on the list endpoint (the queue). */
  source_count?: number | null;
}

export interface CreateInvestigationRequest {
  title: string;
  description?: string;
  typology?: string;
  origin?: string;
  assignee_email?: string;
}

export type SourceMode = 'live' | 'frozen';

/** `accessible: false` carries only title, context title and owner (restricted placeholder). */
export interface InvestigationSource {
  id: string;
  kind: 'exploration' | 'file';
  position: number;
  title_snapshot: string;
  context_title?: string | null;
  owner_email?: string | null;
  accessible: boolean;
  exploration_id?: string | null;
  context_id?: string | null;
  mode?: SourceMode | null;
  frozen_sha256?: string | null;
  added_by?: string | null;
  added_at?: string | null;
}

/** `GET …/sources/{sid}/snapshot`: the exploration state plus its saved graph snapshot. */
export interface SourceSnapshotPayload {
  exploration: {
    id: string;
    title: string;
    graph_context_id: string;
    owner_email: string;
    state: ExplorationState;
  };
  snapshot: GraphSnapshot | null;
}

/** Role of an entity in the case: drives the node fill (T2 legend). */
export type InvestigationRole = 'victim' | 'mule' | 'exit' | 'discarded';

/** Journal entry (03 §3.4): immutable, hash-chained, oldest first. */
export interface InvestigationEvent {
  id: string;
  at: string;
  actor_email: string;
  /** 'agent' when an agent token acted on behalf of actor_email (03 §8.1). */
  actor_kind?: 'human' | 'agent';
  agent_name?: string | null;
  kind: string;
  payload: Record<string, unknown>;
  prev_hash?: string | null;
  hash: string;
}

export interface InvestigationNote {
  id: string;
  anchor: { kind?: 'node' | 'edge' | 'evidence' | 'none'; id?: string | null };
  body: string;
  author_email: string;
  created_at?: string | null;
  updated_at?: string | null;
}

/** Who wrote an artifact version or a proposal (03 §2.2 `actor`). */
export interface InvestigationActor {
  kind: 'human' | 'agent';
  email: string;
  agent_name?: string | null;
  token_id?: string | null;
}

export type ArtifactKind = 'slides' | 'doc' | 'report' | 'image' | 'data' | 'other';

/** Immutable version in the case space (T10); approving is human-only. */
export interface ArtifactVersion {
  version: number;
  sha256: string;
  size_bytes: number;
  content_type: string;
  status: 'draft' | 'approved';
  actor: InvestigationActor;
  source_evidence_ids: string[];
  note?: string | null;
  created_at?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
}

export interface InvestigationArtifact {
  id: string;
  name: string;
  kind: ArtifactKind;
  current_version: number;
  created_at?: string | null;
  /** html and svg: never rendered inline (XSS). */
  download_only: boolean;
  /** Newest first. */
  versions: ArtifactVersion[];
}

export type FileRole = 'graph' | 'enrichment' | 'attachment';

/** A file uploaded to the case (F2.3), stored by its sha256. */
export interface InvestigationFile {
  id: string;
  filename: string;
  role: FileRole;
  sha256: string;
  size_bytes: number;
  content_type?: string | null;
  mapping?: Record<string, unknown> | null;
  context_id?: string | null;
  uploaded_by: string;
  uploaded_at?: string | null;
}

/** How an `enrichment` file joins the case's nodes (F2.6, `FileEnrichmentSpec` on the server). */
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

/** `POST …/files/{fid}/context` (F2.5). */
export interface FileContextResult {
  source: InvestigationSource;
  file: InvestigationFile;
  context_id: string;
  exploration_id: string;
  report: MappingReport & { truncated_edges: number };
}

export type ProposalKind = 'role' | 'match' | 'hypothesis' | 'hypothesis_status' | 'typology' | 'status';

/** A change an agent proposes; a person accepts or rejects it (T11, 03 §8.4). */
export interface InvestigationProposal {
  id: string;
  kind: ProposalKind;
  payload: Record<string, unknown>;
  rationale?: string | null;
  actor: InvestigationActor;
  status: 'pending' | 'accepted' | 'rejected';
  created_at?: string | null;
  decided_by?: string | null;
  decided_at?: string | null;
  decision_note?: string | null;
}
