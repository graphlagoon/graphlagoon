/**
 * Pure logic behind AdminView.vue, imported from utils/adminView (the real
 * functions the view uses — not copies).
 */
import { describe, it, expect } from 'vitest';
import {
  canClearEnvironment,
  describeAudit,
  filterConfig,
  filterContexts,
  filterExplorations,
  flagEntries,
  formatConfigValue,
  formatRelative,
  isIdleUser,
  sortUsers,
} from '@/utils/adminView';
import type { AdminUser } from '@/types/admin';

const ctx = (id: string, owner: string, title: string, tags: string[] = []) =>
  ({ id, owner_email: owner, title, tags, description: '' }) as any;

describe('filterContexts / filterExplorations', () => {
  const contexts = [ctx('1', 'a@x.com', 'Fraud ring', ['fraud']), ctx('2', 'b@x.com', 'Supply chain')];

  it('filters by owner exactly (case-insensitive)', () => {
    expect(filterContexts(contexts, { owner: 'A@X.COM' }).map((c) => c.id)).toEqual(['1']);
  });

  it('fuzzy-matches title, owner and tags', () => {
    expect(filterContexts(contexts, { query: 'fraud' }).map((c) => c.id)).toEqual(['1']);
    expect(filterContexts(contexts, { query: 'b@x' }).map((c) => c.id)).toEqual(['2']);
  });

  it('returns everything without filters', () => {
    expect(filterContexts(contexts, {})).toHaveLength(2);
  });

  it('explorations can match on their context title', () => {
    const explorations = [
      { id: 'e1', owner_email: 'a@x.com', title: 'Hub', graph_context_id: '2' },
      { id: 'e2', owner_email: 'a@x.com', title: 'Ego', graph_context_id: '1' },
    ] as any;
    const titles = new Map([['2', 'Supply chain'], ['1', 'Fraud ring']]);
    expect(filterExplorations(explorations, titles, { query: 'supply' }).map((e) => e.id)).toEqual(['e1']);
    expect(filterExplorations(explorations, titles, { owner: 'nobody@x.com' })).toEqual([]);
  });
});

describe('config helpers', () => {
  const entries = [
    { key: 'dev_mode', env_var: 'GRAPH_LAGOON_DEV_MODE', value: true, kind: 'public' as const },
    { key: 'databricks_token', env_var: 'GRAPH_LAGOON_DATABRICKS_TOKEN', value: 'set', kind: 'secret' as const },
    { key: 'port', env_var: 'GRAPH_LAGOON_PORT', value: 8000, kind: 'public' as const },
  ];

  it('formats booleans, numbers, objects and empties', () => {
    expect(formatConfigValue(entries[0])).toBe('true');
    expect(formatConfigValue(entries[2])).toBe('8000');
    expect(formatConfigValue({ ...entries[2], value: null })).toBe('—');
    expect(formatConfigValue({ ...entries[2], value: { a: 1 } })).toBe('{"a":1}');
  });

  it('filters by key, env var or value', () => {
    expect(filterConfig(entries, 'TOKEN').map((e) => e.key)).toEqual(['databricks_token']);
    expect(filterConfig(entries, '8000').map((e) => e.key)).toEqual(['port']);
    expect(filterConfig(entries, '')).toHaveLength(3);
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-08-28T12:00:00Z');
  it('handles never / unknown / ranges', () => {
    expect(formatRelative(null, now)).toBe('never');
    expect(formatRelative('garbage', now)).toBe('unknown');
    expect(formatRelative('2026-08-28T11:59:40Z', now)).toBe('just now');
    expect(formatRelative('2026-08-28T11:30:00Z', now)).toBe('30 min ago');
    expect(formatRelative('2026-08-27T12:00:00Z', now)).toBe('24 h ago');
    expect(formatRelative('2026-08-20T12:00:00Z', now)).toBe('8 d ago');
    expect(formatRelative('2026-01-01T12:00:00Z', now)).toBe('2026-01-01');
  });
});

describe('users', () => {
  const user = (email: string, extra: Partial<AdminUser> = {}): AdminUser => ({
    email,
    display_name: email,
    created_at: '2026-01-01T00:00:00Z',
    last_seen_at: null,
    is_superuser: false,
    contexts_owned: 0,
    explorations_owned: 0,
    ...extra,
  });

  it('sorts superusers first, then most recently seen', () => {
    const sorted = sortUsers([
      user('c@x.com', { last_seen_at: '2026-08-01T00:00:00Z' }),
      user('a@x.com', { is_superuser: true }),
      user('b@x.com', { last_seen_at: '2026-08-20T00:00:00Z' }),
    ]);
    expect(sorted.map((u) => u.email)).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  it('flags users who own nothing', () => {
    expect(isIdleUser(user('a@x.com'))).toBe(true);
    expect(isIdleUser(user('a@x.com', { contexts_owned: 1 }))).toBe(false);
  });
});

describe('describeAudit', () => {
  const entry = (action: string, metadata: Record<string, unknown>) =>
    ({ id: '1', user_email: 'u', action, resource_type: null, resource_id: 'rid', metadata, created_at: null });

  it('renders each known action', () => {
    expect(describeAudit(entry('context.transfer', { title: 'T', from: 'a', to: 'b' }))).toBe('"T" from a to b');
    expect(describeAudit(entry('context.share', { with: '*', permission: 'read' }))).toBe('with * (read)');
    expect(describeAudit(entry('context.share', { with: 'x', permission: 'write', updated: true }))).toContain('updated');
    expect(describeAudit(entry('exploration.unshare', { with: 'x' }))).toBe('removed x');
    expect(describeAudit(entry('context.delete', { title: 'T', owner: 'o' }))).toBe('"T" (owner o)');
    expect(describeAudit(entry('precomputed.publish', { name: 'n', provider: 'volume' }))).toBe('n via volume');
    expect(describeAudit(entry('admin.clear_all', { cleared: ['users', 'graph_contexts'] }))).toBe('cleared: users, graph_contexts');
    expect(describeAudit(entry('group.create', { name: 'builders', members: 3 }))).toBe('"builders" (3 members)');
    expect(describeAudit(entry('group.update', { name: 'builders', members: 1 }))).toBe('"builders" (1 member)');
    expect(describeAudit(entry('group.delete', { name: 'builders', rules_removed: 2 }))).toBe('"builders" — 2 rule(s) removed');
    expect(describeAudit(entry('group.delete', { name: 'builders' }))).toBe('"builders"');
    expect(describeAudit(entry('permission.update', { permission: 'context.create', mode: 'restricted', rules: 1 }))).toBe('context.create: restricted, 1 rule(s)');
  });

  it('falls back to key=value for unknown actions', () => {
    expect(describeAudit(entry('future.action', { a: 1, b: 'x' }))).toBe('a=1, b=x');
    expect(describeAudit(entry('future.action', {}))).toBe('');
  });
});

describe('flagEntries / canClearEnvironment', () => {
  it('lists every boolean of the public config, sorted', () => {
    const flags = flagEntries({ public_config: { style_presets_enabled: true, dev_mode: false, version: '1' } } as any);
    expect(flags).toEqual([
      { key: 'dev_mode', value: false },
      { key: 'style_presets_enabled', value: true },
    ]);
    expect(flagEntries(null)).toEqual([]);
  });

  it('requires the exact confirmation and dev mode', () => {
    expect(canClearEnvironment('CLEAR ALL', true)).toBe(true);
    expect(canClearEnvironment('clear all', true)).toBe(false);
    expect(canClearEnvironment('CLEAR ALL', false)).toBe(false);
  });
});
