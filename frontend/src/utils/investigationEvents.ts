/** Human-readable lines for the case journal and proposals (T2, T11). */
import { ROLE_LABELS } from '@/utils/graphAppearance';
import { STATUS_LABELS } from '@/utils/investigationStatus';
import type { InvestigationEvent, InvestigationProposal } from '@/types/investigation';

/** One line for what a proposal would change. */
export function describeProposal(p: Pick<InvestigationProposal, 'kind' | 'payload'>): string {
  const d = p.payload as Record<string, any>;
  switch (p.kind) {
    case 'role': return `mark ${d.entity} as ${d.role ? ROLE_LABELS[d.role as keyof typeof ROLE_LABELS] ?? d.role : 'no role'}`;
    case 'status': return `set the case status to ${STATUS_LABELS[d.status as keyof typeof STATUS_LABELS] ?? d.status}`;
    case 'typology': return `set the typology to ${d.typology}`;
    default: return p.kind;
  }
}

/** One line per journal event; unknown kinds fall back to the raw kind. */
export function describeEvent(e: InvestigationEvent): string {
  const p = e.payload as Record<string, any>;
  switch (e.kind) {
    case 'case.created': return `created the case “${p.title ?? ''}”`;
    case 'case.updated': return `updated ${Object.keys(p).join(', ') || 'the case'}`;
    case 'case.shared': return `shared with ${p.with} (${p.permission})`;
    case 'case.unshared': return `stopped sharing with ${p.with}`;
    case 'source.added': return p.files
      ? `added file graph “${p.title}”: ${p.nodes} nodes, ${p.edges} edges${p.truncated_edges ? ` (${p.truncated_edges} edges over the ceiling dropped)` : ''}`
      : `added source “${p.title}” (${p.mode})`;
    case 'file.mapped': return `set the mapping “${p.name}” of ${p.filename}`;
    case 'source.removed': return `removed source “${p.title}”`;
    case 'role.changed': return `marked ${p.entity} as ${p.to ? ROLE_LABELS[p.to] ?? p.to : 'no role'}`;
    case 'pin.changed': return `${p.pinned ? 'pinned' : 'unpinned'} ${p.entity}`;
    case 'note.created': return `noted on ${p.anchor?.id ?? 'the case'}: “${p.body}”`;
    case 'note.updated': return 'edited a note';
    case 'note.deleted': return 'deleted a note';
    case 'artifact.created': return `uploaded “${p.name}” v1`;
    case 'artifact.version_added': return `uploaded “${p.name}” v${p.version}`;
    case 'artifact.approved': return `approved “${p.name}” v${p.version}`;
    case 'proposal.created': return `proposed: ${describeProposal({ kind: p.kind, payload: p.payload ?? {} })}`;
    case 'proposal.accepted': return `accepted the proposal: ${describeProposal({ kind: p.kind, payload: p.payload ?? {} })}`;
    case 'proposal.rejected': return `rejected the proposal: ${describeProposal({ kind: p.kind, payload: p.payload ?? {} })} (${p.reason})`;
    case 'nodes.promoted': return `promoted ${p.nodes} ${p.node_type} node(s) from enrichment table ${p.table}`;
    default: return e.kind;
  }
}
