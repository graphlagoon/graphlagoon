/**
 * Pure helpers behind AdminView.vue — kept out of the SFC so
 * AdminView.logic.test.ts tests the real functions (see the note at the top
 * of ContextsView.logic.test.ts about testing copies).
 */

import type { AdminConfigEntry, AdminOverview, AdminUser, AuditEntry } from '@/types/admin';
import type { Exploration, GraphContext } from '@/types/graph';
import { fuzzyMatch } from '@/utils/contextForm';

export const CLEAR_CONFIRMATION = 'CLEAR ALL';

/** Contexts filtered by an owner (exact e-mail) and/or free text. */
export function filterContexts(
  contexts: GraphContext[],
  opts: { owner?: string | null; query?: string },
): GraphContext[] {
  const owner = (opts.owner || '').trim().toLowerCase();
  const query = (opts.query || '').trim();
  return contexts.filter((ctx) => {
    if (owner && ctx.owner_email.toLowerCase() !== owner) return false;
    if (!query) return true;
    const text = [ctx.title, ctx.description || '', ctx.owner_email, (ctx.tags || []).join(' ')].join(' ');
    return fuzzyMatch(text, query);
  });
}

/** Explorations filtered by owner and/or free text (title, owner, context title). */
export function filterExplorations(
  explorations: Exploration[],
  contextTitles: Map<string, string>,
  opts: { owner?: string | null; query?: string },
): Exploration[] {
  const owner = (opts.owner || '').trim().toLowerCase();
  const query = (opts.query || '').trim();
  return explorations.filter((exp) => {
    if (owner && exp.owner_email.toLowerCase() !== owner) return false;
    if (!query) return true;
    const text = [exp.title, exp.owner_email, contextTitles.get(exp.graph_context_id) || ''].join(' ');
    return fuzzyMatch(text, query);
  });
}

/** Config entries filtered by key / env var / value text. */
export function filterConfig(entries: AdminConfigEntry[], query: string): AdminConfigEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      e.key.toLowerCase().includes(q) ||
      e.env_var.toLowerCase().includes(q) ||
      formatConfigValue(e).toLowerCase().includes(q),
  );
}

/** Human display of a config value; secrets are already redacted server-side. */
export function formatConfigValue(entry: AdminConfigEntry): string {
  const v = entry.value;
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Relative "3 min ago" / "2 d ago" for activity columns; never throws. */
export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'never';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'unknown';
  const diff = Math.max(0, now.getTime() - then.getTime());
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days} d ago`;
  return then.toISOString().slice(0, 10);
}

/** Users sorted for the Users tab: superusers first, then by activity. */
export function sortUsers(users: AdminUser[]): AdminUser[] {
  return [...users].sort((a, b) => {
    if (a.is_superuser !== b.is_superuser) return a.is_superuser ? -1 : 1;
    const ta = a.last_seen_at || a.created_at || '';
    const tb = b.last_seen_at || b.created_at || '';
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a.email.localeCompare(b.email);
  });
}

/** Whether the user owns nothing — the "left the company?" candidates. */
export function isIdleUser(user: AdminUser): boolean {
  return user.contexts_owned === 0 && user.explorations_owned === 0;
}

/** One-line human summary of an audit entry's metadata. */
export function describeAudit(entry: AuditEntry): string {
  const m = entry.metadata || {};
  switch (entry.action) {
    case 'context.transfer':
    case 'exploration.transfer':
      return `"${m.title ?? entry.resource_id}" from ${m.from} to ${m.to}`;
    case 'context.share':
    case 'exploration.share':
      return `with ${m.with} (${m.permission})${m.updated ? ' — updated' : ''}`;
    case 'context.unshare':
    case 'exploration.unshare':
      return `removed ${m.with}`;
    case 'context.delete':
    case 'exploration.delete':
      return `"${m.title ?? entry.resource_id}" (owner ${m.owner ?? '?'})`;
    case 'precomputed.publish':
    case 'precomputed.delete':
    case 'preset.delete':
      return `${m.name ?? '?'}${m.provider ? ` via ${m.provider}` : ''}`;
    case 'admin.clear_all':
      return `cleared: ${Array.isArray(m.cleared) ? m.cleared.join(', ') : '?'}`;
    default: {
      const keys = Object.keys(m);
      return keys.length ? keys.map((k) => `${k}=${String(m[k])}`).join(', ') : '';
    }
  }
}

/** Feature flags worth a card: every boolean in the public config. */
export function flagEntries(overview: AdminOverview | null): Array<{ key: string; value: boolean }> {
  if (!overview) return [];
  return Object.entries(overview.public_config)
    .filter(([, v]) => typeof v === 'boolean')
    .map(([key, value]) => ({ key, value: value as boolean }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** The confirmation input enables the destructive button only on exact match. */
export function canClearEnvironment(input: string, devMode: boolean): boolean {
  return devMode && input === CLEAR_CONFIRMATION;
}
