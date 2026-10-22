/**
 * Links out of a case (UX-1). An exploration attached to a case opens on its own page, with
 * `?case=` so the explorer shows "← Case" and saving there keeps it attached — the same URL the
 * MCP `create_exploration` tool hands an agent.
 */
import type { CaseItem } from '@/types/investigation';

export function explorationUrl(item: Pick<CaseItem, 'context_id' | 'exploration_id'>, caseId: string): string | null {
  if (!item.context_id || !item.exploration_id) return null;
  const query = new URLSearchParams({ exploration: item.exploration_id, case: caseId });
  return `/graph/${item.context_id}?${query}`;
}
