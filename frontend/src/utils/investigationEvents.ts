/** Human-readable lines for the case journal and proposals (T2, T11). */
import { ROLE_LABELS } from '@/utils/graphAppearance';
import { HYPOTHESIS_STATUS_LABELS, STATUS_LABELS } from '@/utils/investigationStatus';
import type { InvestigationEvent, InvestigationProposal } from '@/types/investigation';

const MATCH_VERB: Record<string, string> = { aceito: 'accept', recusado: 'reject', adiado: 'defer' };
const MATCH_DONE: Record<string, string> = { aceito: 'accepted', recusado: 'rejected', adiado: 'deferred' };

/** One line for what a proposal would change. */
export function describeProposal(p: Pick<InvestigationProposal, 'kind' | 'payload'>): string {
  const d = p.payload as Record<string, any>;
  switch (p.kind) {
    case 'role': return `mark ${d.entity} as ${d.role ? ROLE_LABELS[d.role as keyof typeof ROLE_LABELS] ?? d.role : 'no role'}`;
    case 'status': return `set the case status to ${STATUS_LABELS[d.status as keyof typeof STATUS_LABELS] ?? d.status}`;
    case 'typology': return `set the typology to ${d.typology}`;
    case 'match': return `${MATCH_VERB[d.status] ?? d.status} match ${d.match_id}: ${d.reason_text}`;
    case 'hypothesis': return `add the hypothesis “${d.text}”${d.status && d.status !== 'aberta' ? ` as ${hyp(d.status)}` : ''}${evidenceText(d)}`;
    case 'hypothesis_status': return `mark ${d.hypothesis_id} as ${hyp(d.status)}${evidenceText(d)}`;
    default: return p.kind;
  }
}

const hyp = (s: string) => HYPOTHESIS_STATUS_LABELS[s as keyof typeof HYPOTHESIS_STATUS_LABELS] ?? s;
const evidenceText = (d: Record<string, any>) =>
  [d.evidence_for?.length ? `for: ${d.evidence_for.length} evidence` : '', d.evidence_against?.length ? `against: ${d.evidence_against.length} evidence` : '']
    .filter(Boolean)
    .map((x) => ` (${x})`)
    .join('');

const FIELD_LABELS: Record<string, string> = {
  assignee_email: 'assignee',
  deadline_days_override: 'deadline',
  alert_at: 'alert date',
  occurred_at: 'occurrence date',
};

/**
 * One line per journal event; unknown kinds fall back to the raw kind.
 * `nameOf` turns an entity id into its label (the view passes the unified graph's).
 */
export function describeEvent(e: InvestigationEvent, nameOf: (id: string) => string = (id) => id): string {
  const p = e.payload as Record<string, any>;
  switch (e.kind) {
    case 'case.created': return `created the case “${p.title ?? ''}”`;
    case 'case.updated': {
      const fields = Object.keys(p).map((k) => FIELD_LABELS[k] ?? k);
      const status = p.status ? ` → ${STATUS_LABELS[p.status as keyof typeof STATUS_LABELS] ?? p.status}` : '';
      return `updated ${fields.join(', ') || 'the case'}${status}`;
    }
    case 'case.reopened': return `reopened the case (previous decision hash ${String(p.previous_frozen_hash ?? '').slice(0, 8)}…)`;
    case 'case.shared': return `shared with ${p.with} (${p.permission})`;
    case 'case.unshared': return `stopped sharing with ${p.with}`;
    case 'source.added': return p.files
      ? `added file graph “${p.title}”: ${p.nodes} nodes, ${p.edges} edges${p.truncated_edges ? ` (${p.truncated_edges} edges over the ceiling dropped)` : ''}`
      : `added source “${p.title}” (${p.mode})`;
    case 'file.mapped': return `set the mapping “${p.name}” of ${p.filename}`;
    case 'source.removed': return `removed source “${p.title}”`;
    case 'role.changed': return `marked ${nameOf(p.entity)} as ${p.to ? ROLE_LABELS[p.to] ?? p.to : 'no role'}`;
    case 'pin.changed': return `${p.pinned ? 'pinned' : 'unpinned'} ${nameOf(p.entity)}`;
    case 'note.created': return `noted on ${p.anchor?.id ? nameOf(p.anchor.id) : 'the case'}: “${p.body}”`;
    case 'note.updated': return 'edited a note';
    case 'note.deleted': return 'deleted a note';
    case 'evidence.created': return `froze evidence “${p.title}” (${p.kind}) · hash ${String(p.sha256 ?? '').slice(0, 8)}`;
    case 'hypothesis.created': return `added hypothesis ${p.id}: “${p.text}”`;
    case 'hypothesis.updated': return `updated hypothesis ${p.id}${p.status ? `: ${hyp(p.from_status)} → ${hyp(p.status)}` : ''}`;
    case 'artifact.created': return `uploaded “${p.name}” v1`;
    case 'artifact.version_added': return `uploaded “${p.name}” v${p.version}`;
    case 'artifact.approved': return `approved “${p.name}” v${p.version}`;
    case 'proposal.created': return `proposed: ${describeProposal({ kind: p.kind, payload: p.payload ?? {} })}`;
    case 'proposal.accepted': return `accepted the proposal: ${describeProposal({ kind: p.kind, payload: p.payload ?? {} })}`;
    case 'proposal.rejected': return `rejected the proposal: ${describeProposal({ kind: p.kind, payload: p.payload ?? {} })} (${p.reason})`;
    case 'nodes.promoted': return `promoted ${p.nodes} ${p.node_type} node(s) from enrichment table ${p.table}`;
    case 'metric.saved': return `saved metric ${p.metric} as property ${p.property} on ${p.nodes} node(s) of “${p.exploration_title}”`;
    case 'typology.accepted': return `accepted the typology badge ${p.normRef} (${p.label}) on ${p.hits} ${p.hits === 1 ? 'entity' : 'entities'}`;
    case 'match.suggested': return `found ${p.count} entity match suggestion(s)`;
    case 'decision.recorded': return `decided: ${p.outcome === 'comunicar' ? 'communicate to COAF' : 'archive'}${p.actions?.length ? ` (${p.actions.join(', ')})` : ''}; froze ${p.frozen_sources?.length ?? 0} live source(s)`;
    case 'match.decided': return `${MATCH_DONE[p.status] ?? p.status} the match ${nameOf(p.left?.uid)} = ${nameOf(p.right?.uid)}: “${p.reason}”`;
    default: return e.kind;
  }
}
