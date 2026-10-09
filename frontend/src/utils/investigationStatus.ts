import type { Investigation, InvestigationStatus } from '@/types/investigation';

export const STATUS_LABELS: Record<InvestigationStatus, string> = {
  selecao: 'Awaiting selection',
  analise: 'In analysis',
  decidido: 'Decided',
  arquivado: 'Archived',
};

const DAY_MS = 86_400_000;
/** Circ. 3.978: 45 days to select, 45 more to analyse. */
const PHASE_DAYS = 45;

/**
 * Deadline of an open case, or null once decided/archived.
 * shortcut: counted from created_at/selected_at on the client; F4.4 moves
 * deadlines to the server with the event date and SLA settings.
 */
export function deadlineOf(
  inv: Investigation,
  now: number = Date.now(),
): { phase: 'selection' | 'analysis'; daysLeft: number } | null {
  const phase = inv.status === 'selecao' ? 'selection' : inv.status === 'analise' ? 'analysis' : null;
  if (!phase) return null;
  const start = phase === 'analysis' ? (inv.selected_at ?? inv.created_at) : inv.created_at;
  if (!start) return null;
  const daysLeft = Math.ceil((new Date(start).getTime() + PHASE_DAYS * DAY_MS - now) / DAY_MS);
  return { phase, daysLeft };
}
