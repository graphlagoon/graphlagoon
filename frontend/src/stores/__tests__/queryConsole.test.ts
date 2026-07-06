import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useQueryConsoleStore } from '@/stores/queryConsole';
import { useGraphStore } from '@/stores/graph';

// Mock api service
vi.mock('@/services/api', () => ({
  api: {
    executeTableQuery: vi.fn(),
  },
}));

import { api } from '@/services/api';

function withContext() {
  const graph = useGraphStore();
  graph.currentContext = { id: 'ctx-1', title: 'Test' } as any;
  return graph;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('queryConsole store — runQuery', () => {
  it('builds columns/rows from a successful tabular response', async () => {
    withContext();
    vi.mocked(api.executeTableQuery).mockResolvedValue({
      columns: ['name', 'age'],
      rows: [
        ['Alice', '30'],
        ['Bob', '25'],
      ],
      row_count: 2,
      truncated: false,
      transpiled_sql: 'SELECT name, age ...',
    } as any);

    const store = useQueryConsoleStore();
    store.mode = 'cypher';
    store.cypherQuery = 'MATCH (n) RETURN n.name, n.age';
    await store.runQuery();

    expect(api.executeTableQuery).toHaveBeenCalledWith('ctx-1', {
      query: 'MATCH (n) RETURN n.name, n.age',
      mode: 'cypher',
    });
    expect(store.columns.map(c => c.header)).toEqual(['name', 'age']);
    expect(store.rows).toHaveLength(2);
    expect(store.rows[0].col_1).toBe(30); // numeric coercion
    expect(store.rowCount).toBe(2);
    expect(store.truncated).toBe(false);
    expect(store.transpiledSql).toBe('SELECT name, age ...');
    expect(store.error).toBeNull();
    expect(store.hasRun).toBe(true);
    expect(store.loading).toBe(false);
  });

  it('passes cte_prefilter from the graph store when set', async () => {
    const graph = withContext();
    graph.ctePrefilter = 'node_type = "Person"';
    vi.mocked(api.executeTableQuery).mockResolvedValue({
      columns: [],
      rows: [],
      row_count: 0,
      truncated: false,
    } as any);

    const store = useQueryConsoleStore();
    store.cypherQuery = 'MATCH (n) RETURN n.node_id';
    await store.runQuery();

    expect(api.executeTableQuery).toHaveBeenCalledWith('ctx-1', {
      query: 'MATCH (n) RETURN n.node_id',
      mode: 'cypher',
      cte_prefilter: 'node_type = "Person"',
    });
  });

  it('runs raw SQL in sql mode', async () => {
    withContext();
    vi.mocked(api.executeTableQuery).mockResolvedValue({
      columns: ['c'],
      rows: [['1']],
      row_count: 1,
      truncated: false,
    } as any);

    const store = useQueryConsoleStore();
    store.mode = 'sql';
    store.sqlQuery = 'SELECT 1 AS c';
    await store.runQuery();

    expect(api.executeTableQuery).toHaveBeenCalledWith('ctx-1', {
      query: 'SELECT 1 AS c',
      mode: 'sql',
    });
    expect(store.rowCount).toBe(1);
  });

  it('flags truncation', async () => {
    withContext();
    vi.mocked(api.executeTableQuery).mockResolvedValue({
      columns: ['c'],
      rows: [['x']],
      row_count: 1,
      truncated: true,
    } as any);

    const store = useQueryConsoleStore();
    store.cypherQuery = 'MATCH (n) RETURN n.node_id';
    await store.runQuery();

    expect(store.truncated).toBe(true);
  });

  it('extracts the backend error message and clears the result', async () => {
    withContext();
    vi.mocked(api.executeTableQuery).mockRejectedValue({
      response: { data: { detail: { error: { message: 'Transpiled SQL failed validation' } } } },
    });

    const store = useQueryConsoleStore();
    store.cypherQuery = 'MATCH (n) RETURN n.node_id';
    await store.runQuery();

    expect(store.error).toBe('Transpiled SQL failed validation');
    expect(store.columns).toEqual([]);
    expect(store.rows).toEqual([]);
    expect(store.hasRun).toBe(true);
    expect(store.loading).toBe(false);
  });

  it('sets an error when there is no active context', async () => {
    // no context set
    const store = useQueryConsoleStore();
    store.cypherQuery = 'MATCH (n) RETURN n.node_id';
    await store.runQuery();

    expect(store.error).toBe('No active context');
    expect(api.executeTableQuery).not.toHaveBeenCalled();
  });

  it('does nothing for an empty query', async () => {
    withContext();
    const store = useQueryConsoleStore();
    store.mode = 'cypher';
    store.cypherQuery = '   ';
    await store.runQuery();

    expect(api.executeTableQuery).not.toHaveBeenCalled();
  });
});

describe('queryConsole store — helpers', () => {
  it('clearQuery clears only the active mode editor', () => {
    const store = useQueryConsoleStore();
    store.cypherQuery = 'MATCH ...';
    store.sqlQuery = 'SELECT ...';
    store.mode = 'cypher';
    store.clearQuery();
    expect(store.cypherQuery).toBe('');
    expect(store.sqlQuery).toBe('SELECT ...');
  });

  it('resetResult drops the current result', () => {
    const store = useQueryConsoleStore();
    store.rows = [{ col_0: 'x' }];
    store.rowCount = 1;
    store.hasRun = true;
    store.resetResult();
    expect(store.rows).toEqual([]);
    expect(store.rowCount).toBe(0);
    expect(store.hasRun).toBe(false);
  });
});
