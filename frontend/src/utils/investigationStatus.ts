import type { HypothesisStatus, Investigation, InvestigationStatus } from '@/types/investigation';

export const STATUS_LABELS: Record<InvestigationStatus, string> = {
  selecao: 'Awaiting selection',
  analise: 'In analysis',
  decidido: 'Decided',
  arquivado: 'Archived',
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

/** The server's deadline of an open case (F4.4), or null once decided/archived. */
export function deadlineOf(inv: Investigation): { phase: 'selection' | 'analysis'; daysLeft: number } | null {
  return inv.deadline ? { phase: inv.deadline.phase, daysLeft: inv.deadline.days_left } : null;
}
