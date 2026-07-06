import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useQueryConsoleStore } from '@/stores/queryConsole';
import { useGraphStore } from '@/stores/graph';

// Mock api service
vi.mock('@/services/api', () => ({
  api: {
    executeTableQuery: vi.fn(),
    getTableQueryStatus: vi.fn(),
    cancelTableQuery: vi.fn(),
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
      metadata: { total_ms: 42.5, transpilation_ms: 8.1 },
    } as any);

    const store = useQueryConsoleStore();
    store.mode = 'cypher';
    store.cypherQuery = 'MATCH (n) RETURN n.name, n.age';
    await store.runQuery();

    expect(api.executeTableQuery).toHaveBeenCalledWith('ctx-1', {
      query: 'MATCH (n) RETURN n.name, n.age',
      mode: 'cypher',
      vlp_rendering_mode: 'cte',
      materialization_strategy: 'numbered_views',
    });
    expect(store.columns.map(c => c.header)).toEqual(['name', 'age']);
    expect(store.rows).toHaveLength(2);
    expect(store.rows[0].col_1).toBe(30); // numeric coercion
    expect(store.rowCount).toBe(2);
    expect(store.truncated).toBe(false);
    expect(store.transpiledSql).toBe('SELECT name, age ...');
    // the SQL editor mirrors what actually ran, so switching to the SQL tab
    // never shows stale/placeholder text (mirrors GraphQueryPanel's convention)
    expect(store.sqlQuery).toBe('SELECT name, age ...');
    // metadata is kept (footer shows exec time)
    expect(store.metadata?.total_ms).toBe(42.5);
    expect(store.metadata?.transpilation_ms).toBe(8.1);
    // raw result kept for faithful JSON/copy export
    expect(store.rawColumns).toEqual(['name', 'age']);
    expect(store.rawRows).toEqual([['Alice', '30'], ['Bob', '25']]);
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
      vlp_rendering_mode: 'cte',
      materialization_strategy: 'numbered_views',
    });
  });

  it('overwrites a stale SQL editor with the freshly transpiled SQL on each cypher run', async () => {
    withContext();
    const store = useQueryConsoleStore();
    store.sqlQuery = 'SELECT * FROM nodes LIMIT 100'; // stale placeholder from a previous session

    vi.mocked(api.executeTableQuery).mockResolvedValue({
      columns: ['x'], rows: [['1']], row_count: 1, truncated: false,
      transpiled_sql: 'SELECT node_id AS x FROM cat.schema.nodes',
    } as any);
    store.cypherQuery = 'MATCH (n) RETURN n.node_id AS x';
    await store.runQuery();
    expect(store.sqlQuery).toBe('SELECT node_id AS x FROM cat.schema.nodes');

    // Running a second, different cypher query replaces it again — no leftover.
    vi.mocked(api.executeTableQuery).mockResolvedValue({
      columns: ['y'], rows: [['2']], row_count: 1, truncated: false,
      transpiled_sql: 'SELECT age AS y FROM cat.schema.nodes',
    } as any);
    store.cypherQuery = 'MATCH (n) RETURN n.age AS y';
    await store.runQuery();
    expect(store.sqlQuery).toBe('SELECT age AS y FROM cat.schema.nodes');
  });

  it('does not touch sqlQuery when running raw SQL (no transpiled_sql in the response)', async () => {
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

    expect(store.sqlQuery).toBe('SELECT 1 AS c'); // unchanged, no transpiled_sql to sync
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

  it('extracts the structured backend error and clears the result', async () => {
    withContext();
    vi.mocked(api.executeTableQuery).mockRejectedValue({
      response: {
        data: {
          detail: {
            error: {
              code: 'INVALID_SQL_QUERY',
              message: 'Transpiled SQL failed validation',
              details: { transpiled_sql: 'SELECT ...', traceback: ['line 1', 'line 2'] },
            },
          },
        },
      },
    });

    const store = useQueryConsoleStore();
    store.cypherQuery = 'MATCH (n) RETURN n.node_id';
    await store.runQuery();

    expect(store.error?.message).toBe('Transpiled SQL failed validation');
    expect(store.error?.code).toBe('INVALID_SQL_QUERY');
    expect(store.error?.query).toBe('SELECT ...'); // falls back to transpiled_sql
    expect(store.error?.traceback).toEqual(['line 1', 'line 2']);
    expect(store.columns).toEqual([]);
    expect(store.rows).toEqual([]);
    expect(store.metadata).toBeNull();
    expect(store.hasRun).toBe(true);
    expect(store.loading).toBe(false);
  });

  it('sets an error when there is no active context', async () => {
    // no context set
    const store = useQueryConsoleStore();
    store.cypherQuery = 'MATCH (n) RETURN n.node_id';
    await store.runQuery();

    expect(store.error?.message).toBe('No active context');
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

describe('queryConsole store — cancellable poll flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls a running statement until it succeeds, then applies the rows', async () => {
    withContext();
    // Submit comes back RUNNING with a statement_id (query still executing).
    vi.mocked(api.executeTableQuery).mockResolvedValue({
      status: 'running',
      statement_id: 'stmt-1',
      transpiled_sql: 'SELECT ...',
      metadata: { transpilation_ms: 5 },
    } as any);
    // First poll still running, second poll succeeds with data.
    vi.mocked(api.getTableQueryStatus)
      .mockResolvedValueOnce({ status: 'running', statement_id: 'stmt-1' } as any)
      .mockResolvedValueOnce({
        status: 'succeeded',
        statement_id: 'stmt-1',
        columns: ['c'],
        rows: [['1'], ['2']],
        row_count: 2,
        truncated: false,
      } as any);

    const store = useQueryConsoleStore();
    store.mode = 'sql';
    store.sqlQuery = 'SELECT c FROM t';
    const p = store.runQuery();

    // Flush submit; the store should now expose the statement_id (Cancel shows).
    await vi.advanceTimersByTimeAsync(0);
    expect(store.statementId).toBe('stmt-1');
    expect(store.loading).toBe(true);

    // Advance past both polls (first ~300ms, then ~1200ms) → succeeds.
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    expect(api.getTableQueryStatus).toHaveBeenCalledTimes(2);
    expect(store.rowCount).toBe(2);
    expect(store.rows).toHaveLength(2);
    expect(store.loading).toBe(false);
    expect(store.statementId).toBeNull();
    expect(store.canceled).toBe(false);
  });

  it('cancelQuery cancels the in-flight statement and stops polling', async () => {
    withContext();
    vi.mocked(api.executeTableQuery).mockResolvedValue({
      status: 'running',
      statement_id: 'stmt-2',
      transpiled_sql: 'SELECT ...',
    } as any);
    vi.mocked(api.getTableQueryStatus).mockResolvedValue({
      status: 'running',
      statement_id: 'stmt-2',
    } as any);
    vi.mocked(api.cancelTableQuery).mockResolvedValue(undefined as any);

    const store = useQueryConsoleStore();
    store.mode = 'sql';
    store.sqlQuery = 'SELECT c FROM t';
    const p = store.runQuery();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.statementId).toBe('stmt-2');

    await store.cancelQuery();

    expect(api.cancelTableQuery).toHaveBeenCalledWith('ctx-1', 'stmt-2');
    expect(store.canceled).toBe(true);
    expect(store.loading).toBe(false);
    expect(store.statementId).toBeNull();

    // The poll loop must not repopulate state after cancellation.
    const pollsBefore = vi.mocked(api.getTableQueryStatus).mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(vi.mocked(api.getTableQueryStatus).mock.calls.length).toBe(pollsBefore);
    expect(store.canceled).toBe(true);
    await p;
  });

  it('surfaces a backend-reported cancellation from a poll', async () => {
    withContext();
    vi.mocked(api.executeTableQuery).mockResolvedValue({
      status: 'running',
      statement_id: 'stmt-3',
    } as any);
    vi.mocked(api.getTableQueryStatus).mockResolvedValueOnce({
      status: 'canceled',
      statement_id: 'stmt-3',
    } as any);

    const store = useQueryConsoleStore();
    store.mode = 'sql';
    store.sqlQuery = 'SELECT c FROM t';
    const p = store.runQuery();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1500);
    await p;

    expect(store.canceled).toBe(true);
    expect(store.loading).toBe(false);
    expect(store.rowCount).toBe(0);
  });

  it('cancels the orphaned statement when cancelled during the initial submit', async () => {
    withContext();
    vi.mocked(api.executeTableQuery).mockResolvedValue({
      status: 'running',
      statement_id: 'stmt-4',
    } as any);
    vi.mocked(api.cancelTableQuery).mockResolvedValue(undefined as any);

    const store = useQueryConsoleStore();
    store.mode = 'sql';
    store.sqlQuery = 'SELECT c FROM t';
    const p = store.runQuery(); // submit in flight, no statement_id yet
    // User clicks Cancel before the submit resolves.
    await store.cancelQuery();
    expect(store.canceled).toBe(true);
    expect(store.loading).toBe(false);

    // Submit resolves late → runQuery's guard cancels the orphaned statement
    // so it does not keep burning warehouse compute, and never starts polling.
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(api.cancelTableQuery).toHaveBeenCalledWith('ctx-1', 'stmt-4');
    expect(api.getTableQueryStatus).not.toHaveBeenCalled();
  });

  it('cancelQuery is a no-op when nothing is in flight', async () => {
    withContext();
    const store = useQueryConsoleStore();
    await store.cancelQuery();
    expect(api.cancelTableQuery).not.toHaveBeenCalled();
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
    store.rawRows = [['x']];
    store.rowCount = 1;
    store.hasRun = true;
    store.resetResult();
    expect(store.rows).toEqual([]);
    expect(store.rawRows).toEqual([]);
    expect(store.rowCount).toBe(0);
    expect(store.hasRun).toBe(false);
  });

  it('open/close/toggle control the drawer state', () => {
    const store = useQueryConsoleStore();
    expect(store.isOpen).toBe(false);
    store.open();
    expect(store.isOpen).toBe(true);
    store.close();
    expect(store.isOpen).toBe(false);
    store.toggle();
    expect(store.isOpen).toBe(true);
  });

  it('clearError dismisses the error but keeps results', () => {
    const store = useQueryConsoleStore();
    store.error = { message: 'boom' };
    store.rows = [{ col_0: 'x' }];
    store.clearError();
    expect(store.error).toBeNull();
    expect(store.rows).toEqual([{ col_0: 'x' }]);
  });
});
