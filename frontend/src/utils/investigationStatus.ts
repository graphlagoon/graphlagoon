import type {
  DecisionAction,
  DecisionOutcome,
  HypothesisStatus,
  Investigation,
  InvestigationStatus,
} from '@/types/investigation';

export const STATUS_LABELS: Record<InvestigationStatus, string> = {
  selecao: 'Awaiting selection',
  analise: 'In analysis',
  decidido: 'Decided',
  arquivado: 'Archived',
};

/** Status changes a person makes through PATCH (F1, 05 §3); the server answers 409 to any other. */
export const STATUS_TRANSITIONS: Record<InvestigationStatus, Exclude<InvestigationStatus, 'decidido'>[]> = {
  selecao: ['analise', 'arquivado'],
  analise: ['selecao', 'arquivado'],
  decidido: ['arquivado'],
  arquivado: ['analise'],
};

export const DECISION_OUTCOME_LABELS: Record<DecisionOutcome, string> = {
  comunicar: 'Communicate to COAF via Siscoaf',
  arquivar: 'Archive with a rationale',
};

export const DECISION_ACTION_LABELS: Record<DecisionAction, string> = {
  dict: 'Flag the accounts in DICT',
  spa: 'Notify the SPA (24 h)',
  bloqueio_cautelar: 'Request a precautionary block',
};

export const HYPOTHESIS_STATUS_LABELS: Record<HypothesisStatus, string> = {
  aberta: 'open',
  sustentada: 'supported',
  refutada: 'refuted',
};

/** Circ. 3.978: each phase (selection, then analysis) has 45 days. */
export const PHASE_DAYS = 45;
/** Under this many days left the deadline turns orange (T1). */
export const URGENT_DAYS = 7;

/** `#0412`-style short id for titles and journal lines (never a raw UUID). */
export function caseNumber(id: string): string {
  return `#${id.replace(/-/g, '').slice(0, 6)}`;
}

/** The server's deadline of an open case (F4.4), or null once decided/archived. */
export function deadlineOf(inv: Investigation): { phase: 'selection' | 'analysis'; daysLeft: number } | null {
  return inv.deadline ? { phase: inv.deadline.phase, daysLeft: inv.deadline.days_left } : null;
}
