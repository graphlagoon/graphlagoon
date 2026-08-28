import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/services/api', () => ({
  api: {
    getAdminOverview: vi.fn(),
    probeWarehouse: vi.fn(),
    getAdminConfig: vi.fn(),
    getAdminUsers: vi.fn(),
    getGraphContexts: vi.fn(),
    getAllExplorations: vi.fn(),
    getAuditLog: vi.fn(),
    transferContextOwnership: vi.fn(),
    transferExplorationOwnership: vi.fn(),
    deleteGraphContext: vi.fn(),
    deleteExploration: vi.fn(),
    clearEnvironment: vi.fn(),
  },
}));

import { api } from '@/services/api';
import { useAdminStore } from '@/stores/admin';

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('admin store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('loads the overview', async () => {
    mocked.getAdminOverview.mockResolvedValue({ version: '1.0', counts: { users: 3 } });
    const store = useAdminStore();
    await store.fetchOverview();
    expect(store.overview?.version).toBe('1.0');
    expect(store.loading.overview).toBe(false);
    expect(store.error).toBeNull();
  });

  it('surfaces the backend error envelope without throwing', async () => {
    mocked.getAdminOverview.mockRejectedValue({
      response: { data: { detail: { error: { code: 'FORBIDDEN', message: 'restricted to superusers' } } } },
    });
    const store = useAdminStore();
    await store.fetchOverview();
    expect(store.overview).toBeNull();
    expect(store.error).toContain('restricted to superusers');
  });

  it('transfer updates the owner in place and reports success', async () => {
    mocked.getGraphContexts.mockResolvedValue([
      { id: 'c1', owner_email: 'a@x.com', title: 'A' },
      { id: 'c2', owner_email: 'b@x.com', title: 'B' },
    ]);
    mocked.transferContextOwnership.mockResolvedValue({ id: 'c1', previous_owner_email: 'a@x.com', owner_email: 'z@x.com' });
    const store = useAdminStore();
    await store.fetchContexts();
    expect(await store.transferContext('c1', 'z@x.com')).toBe(true);
    expect(mocked.transferContextOwnership).toHaveBeenCalledWith('c1', 'z@x.com');
    expect(store.contexts.map((c) => c.owner_email)).toEqual(['z@x.com', 'b@x.com']);
  });

  it('transfer failure keeps the list untouched', async () => {
    mocked.getAllExplorations.mockResolvedValue([{ id: 'e1', owner_email: 'a@x.com', title: 'E' }]);
    mocked.transferExplorationOwnership.mockRejectedValue(new Error('nope'));
    const store = useAdminStore();
    await store.fetchExplorations();
    expect(await store.transferExploration('e1', 'z@x.com')).toBe(false);
    expect(store.explorations[0].owner_email).toBe('a@x.com');
    expect(store.error).toBe('nope');
  });

  it('delete removes the item locally', async () => {
    mocked.getGraphContexts.mockResolvedValue([{ id: 'c1', owner_email: 'a@x.com', title: 'A' }]);
    mocked.deleteGraphContext.mockResolvedValue(undefined);
    const store = useAdminStore();
    await store.fetchContexts();
    expect(await store.deleteContext('c1')).toBe(true);
    expect(store.contexts).toEqual([]);
  });

  it('audit page stores items, total and the action catalogue', async () => {
    mocked.getAuditLog.mockResolvedValue({ items: [{ id: '1', action: 'context.delete' }], total: 7, page: 1, page_size: 50, actions: ['context.delete'] });
    const store = useAdminStore();
    await store.fetchAudit({ page: 1 });
    expect(store.audit).toHaveLength(1);
    expect(store.auditTotal).toBe(7);
    expect(store.auditActions).toEqual(['context.delete']);
  });

  it('clearEnvironment passes the confirmation and empties local lists', async () => {
    mocked.clearEnvironment.mockResolvedValue({ status: 'cleared', cleared: ['memory'] });
    const store = useAdminStore();
    store.contexts = [{ id: 'c1' } as any];
    expect(await store.clearEnvironment('CLEAR ALL')).toBe(true);
    expect(mocked.clearEnvironment).toHaveBeenCalledWith('CLEAR ALL');
    expect(store.contexts).toEqual([]);
  });
});
