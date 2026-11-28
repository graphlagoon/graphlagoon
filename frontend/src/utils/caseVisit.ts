/**
 * When this browser last opened a case, kept per case in localStorage. The journal
 * draws its "your last visit" line from it and the material list marks what came
 * after it (an agent's uploads, mostly) until the person opens each item.
 */
import { reactive } from 'vue';

const KEY = (id: string) => `gl:case:${id}:lastVisit`;
const previous = reactive<Record<string, string | null>>({});
const opened = reactive(new Set<string>());

/** Starts a visit: returns the time of the one before (null on a first visit) and stamps now. */
export function beginVisit(caseId: string, now: string = new Date().toISOString()): string | null {
  let last: string | null = null;
  try {
    last = localStorage.getItem(KEY(caseId));
    localStorage.setItem(KEY(caseId), now);
  } catch {
    last = null;
  }
  previous[caseId] = last;
  opened.clear();
  return last;
}

/** The visit before this one, once `beginVisit` ran for the case (reactive). */
export function lastVisit(caseId: string | null | undefined): string | null {
  return (caseId && previous[caseId]) || null;
}

/** The person opened this item in this visit: it is no longer new. */
export function markOpened(itemId: string) {
  opened.add(itemId);
}

/** Someone else's item (or version) that arrived after the last visit and was not opened yet. */
export function isNewItem(
  item: { id: string; author_email?: string | null; author_kind?: string; created_at?: string | null; latest?: { created_at?: string | null; created_by?: string | null; author_kind?: string } | null },
  caseId: string | null | undefined,
  me: string | null | undefined,
): boolean {
  const last = lastVisit(caseId);
  if (!last || opened.has(item.id)) return false;
  const at = item.latest?.created_at ?? item.created_at;
  if (!at || at <= last) return false;
  const kind = item.latest?.author_kind ?? item.author_kind;
  const by = item.latest?.created_by ?? item.author_email;
  return kind === 'agent' || by !== me;
}
