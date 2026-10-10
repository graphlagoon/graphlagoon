/** Human-readable lines for the case journal (append-only, 05 §1). */
import { HYPOTHESIS_STATUS_LABELS, STATUS_LABELS } from '@/utils/investigationStatus';
import type { HypothesisStatus, InvestigationEvent, InvestigationStatus } from '@/types/investigation';

const FIELD_LABELS: Record<string, string> = {
  assignee_email: 'assignee',
  deadline_days: 'deadline',
  alert_at: 'alert date',
  occurred_at: 'occurrence date',
  kind_preset: 'case type',
};

const hyp = (s: string) => HYPOTHESIS_STATUS_LABELS[s as HypothesisStatus] ?? s;
const status = (s: string) => STATUS_LABELS[s as InvestigationStatus] ?? s;
const short = (sha?: string) => String(sha ?? '').slice(0, 8);

/** One line for an annotation's content, by kind. */
function describeAnnotation(kind: string, p: Record<string, any>, nameOf: (id: string) => string): string {
  const v = (p.value ?? {}) as Record<string, any>;
  const targets: string[] = p.targets ?? [];
  const first = targets[0] ? nameOf(targets[0]) : 'the case';
  switch (kind) {
    case 'role': return `${first} as ${v.role ?? 'no role'}`;
    case 'tag': return `tag “${v.tag}” on ${targets.length} ${targets.length === 1 ? 'entity' : 'entities'}`;
    case 'group': return `group “${v.name}” with ${targets.length} ${targets.length === 1 ? 'entity' : 'entities'}`;
    case 'same_as': return `${first} = ${targets[1] ? nameOf(targets[1]) : '?'}`;
    case 'hypothesis': return `hypothesis “${v.text}”${v.status && v.status !== 'open' ? ` (${hyp(v.status)})` : ''}`;
    case 'hypothesis_status': return `hypothesis → ${hyp(v.status)}`;
    case 'typology': return `typology ${v.norm_ref ?? v.typology} on ${targets.length} ${targets.length === 1 ? 'entity' : 'entities'}`;
    case 'status_change': return `case status → ${status(v.to)}`;
    default: return kind;
  }
}

const ANNOTATION_KINDS = ['role', 'tag', 'group', 'same_as', 'hypothesis', 'hypothesis_status', 'typology', 'status_change'];
const ANNOTATION_VERBS: Record<string, string> = {
  set: 'set', suggested: 'suggested', confirmed: 'confirmed', rejected: 'rejected', updated: 'updated', removed: 'removed',
};

/**
 * One line per journal event; unknown kinds fall back to the raw kind.
 * `nameOf` turns an entity id into its label (the view passes the unified graph's).
 */
export function describeEvent(e: InvestigationEvent, nameOf: (id: string) => string = (id) => id): string {
  const p = e.payload as Record<string, any>;
  const [head, verb] = e.kind.split('.');
  if (ANNOTATION_KINDS.includes(head) && verb in ANNOTATION_VERBS) {
    const reason = p.reason ? ` — ${p.reason}` : '';
    return `${ANNOTATION_VERBS[verb]} ${describeAnnotation(head, p, nameOf)}${reason}`;
  }
  switch (e.kind) {
    case 'case.created': return `created the case “${p.title ?? ''}”`;
    case 'case.updated': {
      const fields = Object.keys(p).map((k) => FIELD_LABELS[k] ?? k);
      return `updated ${fields.join(', ') || 'the case'}${p.status ? ` → ${status(p.status)}` : ''}`;
    }
    case 'case.reopened': return `reopened the case (previous decision hash ${short(p.previous_frozen_hash)}…)`;
    case 'case.shared': return `shared with ${p.with} (${p.role ?? p.permission})`;
    case 'case.unshared': return `stopped sharing with ${p.with}`;
    case 'case.transferred': return `transferred the case from ${p.from} to ${p.to}`;
    case 'item.created': return `added ${p.kind}/${p.subkind} “${p.title}”${p.status === 'suggested' ? ' (suggested)' : ''}`;
    case 'item.version_added': return p.run
      ? `ran “${p.title}” · v${p.version} · ${p.run.row_count ?? '?'} rows`
      : `added version ${p.version} of “${p.title}” · hash ${short(p.sha256)}`;
    case 'item.updated': return `edited “${p.title}” (${(p.fields ?? []).join(', ')})`;
    case 'item.deleted': return `removed ${p.kind} “${p.title}”`;
    case 'item.pinned': return `pinned “${p.title}” v${p.version}${p.label ? ` as “${p.label}”` : ''} · hash ${short(p.sha256)}`;
    case 'item.confirmed': return `confirmed the suggested item “${p.title}”`;
    case 'item.rejected': return `rejected the suggested item “${p.title}”`;
    case 'nodes.promoted': return `promoted ${p.nodes} ${p.node_type} node(s) from enrichment table ${p.table}`;
    case 'metric.saved': return `saved metric ${p.metric} as property ${p.property} on ${p.nodes} node(s) of “${p.exploration_title}”`;
    case 'trace.run': return `followed the money (${p.allocation ?? 'fifo'}, ${p.maxHops ?? '?'} layers): ${Math.round((p.coverage ?? 0) * 100)}% reached exits`;
    case 'path.run': return `searched paths ${nameOf(p.source)} → ${nameOf(p.target)} (${p.mode}): ${p.found} found`;
    case 'decision.recorded': return `decided: ${p.outcome === 'comunicar' ? 'communicate to COAF' : 'archive'}${p.actions?.length ? ` (${p.actions.join(', ')})` : ''}`;
    default: return e.kind;
  }
}
