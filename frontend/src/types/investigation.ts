/** Investigations (cases): see docs/dev/plans/investigation/03-arquitetura.md §3. */
import type { ExplorationState, GraphSnapshot } from '@/types/graph';

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
