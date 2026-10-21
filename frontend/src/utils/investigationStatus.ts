/**
 * Labels for the case enums (05 §1, §3 "Legibilidade"). These maps are the only
 * place the UI spells a status, an item or annotation kind, a decision or a
 * hypothesis state; domain words (roles, case types, outcomes) come from the
 * org's case types (06 §1).
 */
import type {
  AnnotationKind,
  HypothesisStatus,
  InvestigationDecision,
  Investigation,
  InvestigationStatus,
  ItemKind,
  TaskState,
  TaskValue,
  WriteStatus,
} from '@/types/investigation';

export const STATUS_LABELS: Record<InvestigationStatus, string> = {
  open: 'Open',
  analysis: 'In analysis',
  closed: 'Closed',
};

/** Status changes a person makes through PATCH (06 §1); only a decision closes, only reopen leaves closed. */
export const STATUS_TRANSITIONS: Record<InvestigationStatus, Exclude<InvestigationStatus, 'closed'>[]> = {
  open: ['analysis'],
  analysis: ['open'],
  closed: [],
};

export const REVIEW_LABELS: Record<NonNullable<InvestigationDecision['review']>, string> = {
  pending: 'waiting for review',
  approved: 'approved',
  rejected: 'rejected',
};

export const HYPOTHESIS_STATUS_LABELS: Record<HypothesisStatus, string> = {
  open: 'open',
  supported: 'supported',
  refuted: 'refuted',
};

export const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  graph: 'Graph',
  query: 'Query',
  table: 'Table',
  document: 'Document',
  note: 'Note',
};

/** Plural headings of the material list. */
export const ITEM_KIND_PLURALS: Record<ItemKind, string> = {
  graph: 'Graphs',
  query: 'Queries',
  table: 'Tables',
  document: 'Documents',
  note: 'Notes',
};

export const ANNOTATION_KIND_LABELS: Record<AnnotationKind, string> = {
  role: 'role',
  tag: 'tag',
  group: 'group',
  same_as: 'same as',
  hypothesis: 'hypothesis',
  hypothesis_status: 'hypothesis status',
  status_change: 'status change',
  task: 'task',
  decision_proposal: 'decision proposal',
};

export const TASK_STATE_LABELS: Record<TaskState, string> = {
  open: 'open',
  done: 'done',
  cancelled: 'cancelled',
};

/** An open task past its due time. */
export function taskOverdue(value: Pick<TaskValue, 'state' | 'due_at'>, now = Date.now()): boolean {
  return value.state === 'open' && !!value.due_at && new Date(value.due_at).getTime() < now;
}

export const WRITE_STATUS_LABELS: Record<WriteStatus, string> = {
  suggested: 'suggested',
  confirmed: 'confirmed',
  rejected: 'rejected',
};

/** SLA phases (06 §1): the open phase, then analysis. */
export const PHASE_LABELS: Record<'open' | 'analysis', string> = {
  open: 'open',
  analysis: 'analysis',
};

export const AUTHOR_KIND_LABELS = { human: 'person', agent: 'agent' } as const;

export const itemKindLabel = (kind: string) => ITEM_KIND_LABELS[kind as ItemKind] ?? kind;
export const annotationKindLabel = (kind: string) => ANNOTATION_KIND_LABELS[kind as AnnotationKind] ?? kind;
export const statusLabel = (status: string) => STATUS_LABELS[status as InvestigationStatus] ?? status;

/** `#0412`-style short id for titles and journal lines (never a raw UUID). */
export function caseNumber(id: string): string {
  return `#${id.replace(/-/g, '').slice(0, 6)}`;
}

/** "Mule network · #0412aa": how a case is named anywhere outside its own header. */
export function caseTitle(inv: Pick<Investigation, 'id' | 'title'>): string {
  return `${inv.title} · ${caseNumber(inv.id)}`;
}

export interface Deadline {
  phase: 'open' | 'analysis';
  hoursLeft: number;
  daysLeft: number;
  /** Hours of the phases counted so far (the bar's 100%). */
  totalHours: number;
  dueAt: string;
  /** Under 20% of the SLA left, or overdue (the server decides). */
  urgent: boolean;
  overdue: boolean;
}

/** The server's deadline of an open case, or null without an SLA / once closed. */
export function deadlineOf(inv: Investigation): Deadline | null {
  const d = inv.deadline;
  if (!d) return null;
  return {
    phase: d.phase,
    hoursLeft: d.hours_left,
    daysLeft: d.days_left,
    totalHours: d.total_hours ?? Math.max(d.hours_left, 1),
    dueAt: d.due_at,
    urgent: !!d.urgent,
    overdue: !!d.overdue,
  };
}

/** "open · 31 d" / "analysis · 14 h" (under two days) / "analysis · overdue by 2 d". */
export function deadlineText(d: Deadline): string {
  const phase = PHASE_LABELS[d.phase];
  const span = (h: number) => (h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`);
  return d.hoursLeft < 0 ? `${phase} · overdue by ${span(-d.hoursLeft)}` : `${phase} · ${span(d.hoursLeft)}`;
}

/** Share of the SLA already used, 0–100, for the deadline bar. */
export function deadlineElapsed(d: Deadline): number {
  return Math.min(100, Math.max(0, ((d.totalHours - d.hoursLeft) / d.totalHours) * 100));
}
