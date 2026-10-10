/**
 * Enum labels for the case (05 §1: English enums on the wire, labels here).
 * The map is the only place the UI spells a status, a preset or a hypothesis state.
 */
import type {
  DecisionAction,
  DecisionOutcome,
  HypothesisStatus,
  Investigation,
  InvestigationStatus,
  KindPreset,
} from '@/types/investigation';

export const STATUS_LABELS: Record<InvestigationStatus, string> = {
  open: 'Open',
  analysis: 'In analysis',
  decided: 'Decided',
  archived: 'Archived',
};

/** Status changes a person makes through PATCH (05 §3); the server answers 409 to any other. */
export const STATUS_TRANSITIONS: Record<InvestigationStatus, Exclude<InvestigationStatus, 'decided'>[]> = {
  open: ['analysis', 'archived'],
  analysis: ['open', 'archived'],
  decided: ['archived'],
  archived: ['analysis'],
};

export const KIND_PRESET_LABELS: Record<KindPreset, string> = {
  livre: 'Free',
  credito: 'Credit (economic group)',
  garantia: 'Collateral escape',
  pix_med: 'Pix with MED',
  lavagem: 'Money laundering',
  lojista: 'Merchant review',
  fraude_sintetica: 'Synthetic fraud',
};

export const DECISION_OUTCOME_LABELS: Record<DecisionOutcome, string> = {
  comunicar: 'Communicate to COAF via Siscoaf',
  arquivar: 'Archive with a rationale',
  medida: 'Precautionary measure (block, hold)',
  parecer: 'Opinion only (no communication)',
};

export const DECISION_ACTION_LABELS: Record<DecisionAction, string> = {
  dict: 'Flag the accounts in DICT',
  spa: 'Notify the SPA (24 h)',
  bloqueio_cautelar: 'Request a precautionary block',
};

export const HYPOTHESIS_STATUS_LABELS: Record<HypothesisStatus, string> = {
  open: 'open',
  supported: 'supported',
  refuted: 'refuted',
};

/** Circ. 3.978: each Pix/MED phase (open, then analysis) has 45 days. */
export const PHASE_DAYS = 45;
/** Under this many days left the deadline turns orange (T1). */
export const URGENT_DAYS = 7;

/** `#0412`-style short id for titles and journal lines (never a raw UUID). */
export function caseNumber(id: string): string {
  return `#${id.replace(/-/g, '').slice(0, 6)}`;
}

/** The server's deadline of an open case, or null without phases / once decided or archived. */
export function deadlineOf(inv: Investigation): { phase: 'open' | 'analysis'; daysLeft: number } | null {
  return inv.deadline ? { phase: inv.deadline.phase, daysLeft: inv.deadline.days_left } : null;
}
