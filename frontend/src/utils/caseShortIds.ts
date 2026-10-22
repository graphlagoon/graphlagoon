/**
 * Short ids of a case's material — G3, Q2, T1, D4, N2 (05 §3: never a raw UUID). They are
 * written in notes and rationales, so they must not move: numbered by creation within each kind,
 * over every item the case ever had (removed ones keep their number), never by display order.
 */
import type { CaseItem, ItemKind } from '@/types/investigation';

export const ITEM_PREFIX: Record<ItemKind, string> = { graph: 'G', query: 'Q', table: 'T', document: 'D', note: 'N' };

export function caseShortIds(all: CaseItem[]): Map<string, string> {
  const counters: Partial<Record<ItemKind, number>> = {};
  const ordered = all
    .filter((i) => i.subkind !== 'brief')
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.created_at ?? '').localeCompare(b.item.created_at ?? '') || a.index - b.index);
  return new Map(ordered.map(({ item }) => [item.id, `${ITEM_PREFIX[item.kind]}${(counters[item.kind] = (counters[item.kind] ?? 0) + 1)}`]));
}

/** Evidence numbers E1, E2, … by pin order over every item, keyed `${itemId}:${version}`. */
export function evidenceNumbers(all: CaseItem[]): Map<string, string> {
  const pins = all
    .flatMap((i) => i.pinned.map((v) => ({ key: `${i.id}:${v.version}`, at: v.pinned_at ?? '' })))
    .sort((a, b) => a.at.localeCompare(b.at));
  return new Map(pins.map((p, n) => [p.key, `E${n + 1}`]));
}
