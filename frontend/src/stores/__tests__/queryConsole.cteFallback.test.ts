/**
 * CTE fallback on the Query Console (table) path.
 *
 * Same contract as the graph path (see graph.cteFallback.test.ts), with one
 * extra motivation: the table endpoint's read-only SELECT validation rejects
 * the BEGIN…END SQL script that procedural mode emits, so a procedural cypher
 * table query ALWAYS fails — without the fallback it can never run at all.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useQueryConsoleStore } from '@/stores/queryConsole';
import { useGraphStore } from '@/stores/graph';

const { warningSpy } = vi.hoisted(() => ({ warningSpy: vi.fn() }));

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    toasts: { value: [] },
    show: vi.fn(),
    remove: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: warningSpy,
    error: vi.fn(),
  }),
}));

vi.mock('@/services/api', () => ({
  api: {
    executeTableQuery: vi.fn(),
    getTableQueryStatus: vi.fn(),
    cancelTableQuery: vi.fn(),
  },
}));

import { api } from '@/services/api';

const OK_RESULT = {
  columns: ['name'],
  rows: [['Alice']],
  row_count: 1,
  truncated: false,
  transpiled_sql: 'CTE SQL',
} as any;

const SCRIPT_REJECTED = {
  response: {
    data: {
      detail: {
        error: {
          code: 'INVALID_SQL_QUERY',
          message: 'SQL syntax error: Unexpected token. BEGIN DECLARE …',
          details: {},
        },
      },
    },
  },
};

function withContext() {
  const graph = useGraphStore();
  graph.currentContext = { id: 'ctx-1', title: 'Test' } as any;
  return graph;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('queryConsole store — CTE fallback', () => {
  it('is silent by default — the fallback runs without any toasts', async () => {
    withContext();
    vi.mocked(api.executeTableQuery)
      .mockRejectedValueOnce(SCRIPT_REJECTED)
      .mockResolvedValueOnce(OK_RESULT);

    const store = useQueryConsoleStore();
    store.mode = 'cypher';
    store.cypherQuery = 'MATCH (n) RETURN n';
    await store.runQuery();

    expect(api.executeTableQuery).toHaveBeenCalledTimes(2);
    expect(store.error).toBeNull();
    expect(warningSpy).not.toHaveBeenCalled();
  });

  it('retries a failed procedural cypher run in CTE mode and warns (silent off)', async () => {
    const graph = withContext();
    graph.cteFallbackSilent = false;
    vi.mocked(api.executeTableQuery)
      .mockRejectedValueOnce(SCRIPT_REJECTED)
      .mockResolvedValueOnce(OK_RESULT);

    const store = useQueryConsoleStore();
    store.mode = 'cypher';
    store.cypherQuery = 'MATCH (a)-[r*1..3]->(b) RETURN b.name';
    await store.runQuery();

    expect(api.executeTableQuery).toHaveBeenCalledTimes(2);
    const first = vi.mocked(api.executeTableQuery).mock.calls[0][1];
    const second = vi.mocked(api.executeTableQuery).mock.calls[1][1];
    expect(first.vlp_rendering_mode).toBe('procedural');
    expect(first.procedural_optimizations).toBeDefined();
    expect(second.vlp_rendering_mode).toBe('cte');
    expect(second.procedural_optimizations).toBeUndefined();

    expect(store.error).toBeNull();
    expect(store.rows).toHaveLength(1);
    expect(store.transpiledSql).toBe('CTE SQL');
    expect(warningSpy).toHaveBeenCalledTimes(2);
    expect(warningSpy.mock.calls[0][0]).toContain('retrying in CTE');
    expect(warningSpy.mock.calls[1][0]).toContain('CTE fallback');
  });

  it('keeps the stored rendering mode as procedural after a fallback', async () => {
    const graph = withContext();
    vi.mocked(api.executeTableQuery)
      .mockRejectedValueOnce(SCRIPT_REJECTED)
      .mockResolvedValueOnce(OK_RESULT);

    const store = useQueryConsoleStore();
    store.mode = 'cypher';
    store.cypherQuery = 'MATCH (n) RETURN n';
    await store.runQuery();

    expect(graph.vlpRenderingMode).toBe('procedural');
  });

  it('a later run still tries procedural first (the override is per-run)', async () => {
    withContext();
    vi.mocked(api.executeTableQuery)
      .mockRejectedValueOnce(SCRIPT_REJECTED)
      .mockResolvedValue(OK_RESULT);

    const store = useQueryConsoleStore();
    store.mode = 'cypher';
    store.cypherQuery = 'MATCH (n) RETURN n';
    await store.runQuery(); // fails procedural → falls back to cte
    await store.runQuery(); // must start from procedural again

    expect(
      vi.mocked(api.executeTableQuery).mock.calls[2][1].vlp_rendering_mode,
    ).toBe('procedural');
  });

  it('surfaces the CTE error when the fallback also fails, retrying only once', async () => {
    const graph = withContext();
    graph.cteFallbackSilent = false;
    vi.mocked(api.executeTableQuery).mockRejectedValue(SCRIPT_REJECTED);

    const store = useQueryConsoleStore();
    store.mode = 'cypher';
    store.cypherQuery = 'MATCH (n) RETURN n';
    await store.runQuery();

    expect(api.executeTableQuery).toHaveBeenCalledTimes(2);
    expect(store.error).not.toBeNull();
    expect(warningSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the toggle is off', async () => {
    const graph = withContext();
    graph.cteFallbackEnabled = false;
    vi.mocked(api.executeTableQuery).mockRejectedValue(SCRIPT_REJECTED);

    const store = useQueryConsoleStore();
    store.mode = 'cypher';
    store.cypherQuery = 'MATCH (n) RETURN n';
    await store.runQuery();

    expect(api.executeTableQuery).toHaveBeenCalledTimes(1);
    expect(store.error).not.toBeNull();
    expect(warningSpy).not.toHaveBeenCalled();
  });

  it('does not retry when the query already ran in CTE mode', async () => {
    const graph = withContext();
    graph.vlpRenderingMode = 'cte';
    vi.mocked(api.executeTableQuery).mockRejectedValue(SCRIPT_REJECTED);

    const store = useQueryConsoleStore();
    store.mode = 'cypher';
    store.cypherQuery = 'MATCH (n) RETURN n';
    await store.runQuery();

    expect(api.executeTableQuery).toHaveBeenCalledTimes(1);
  });

  it('does not retry raw SQL failures — there is nothing to re-transpile', async () => {
    withContext();
    vi.mocked(api.executeTableQuery).mockRejectedValue(SCRIPT_REJECTED);

    const store = useQueryConsoleStore();
    store.mode = 'sql';
    store.sqlQuery = 'SELECT broken FROM nowhere';
    await store.runQuery();

    expect(api.executeTableQuery).toHaveBeenCalledTimes(1);
    expect(warningSpy).not.toHaveBeenCalled();
  });

  it('does not retry a successful procedural run', async () => {
    withContext();
    vi.mocked(api.executeTableQuery).mockResolvedValue(OK_RESULT);

    const store = useQueryConsoleStore();
    store.mode = 'cypher';
    store.cypherQuery = 'MATCH (n) RETURN n';
    await store.runQuery();

    expect(api.executeTableQuery).toHaveBeenCalledTimes(1);
    expect(warningSpy).not.toHaveBeenCalled();
  });
});
