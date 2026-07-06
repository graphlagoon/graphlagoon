import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/services/api';
import { useGraphStore } from '@/stores/graph';
import {
  type ColMeta,
  buildGenericColumns,
  buildGenericRows,
} from '@/composables/useTableColumns';
import type { TableQueryMode } from '@/types/graph';

/** Pull a human-readable message out of the backend error envelope
 * ({ detail: { error: { message } } }) or a plain axios/Error. */
function extractMessage(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'response' in e) {
    const detail = (e as { response?: { data?: { detail?: unknown } } })
      .response?.data?.detail;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail === 'object' && 'error' in detail) {
      const err = (detail as { error?: { message?: string } }).error;
      return err?.message || fallback;
    }
  }
  if (e instanceof Error) return e.message;
  return fallback;
}

/**
 * Standalone store for the Query Console: run a generic OpenCypher/SQL query
 * and hold its tabular result. Kept separate from the (already large) graph
 * store — it only borrows `currentContext` and `ctePrefilter` from it.
 */
export const useQueryConsoleStore = defineStore('queryConsole', () => {
  // Input
  const mode = ref<TableQueryMode>('cypher');
  const cypherQuery = ref('');
  const sqlQuery = ref('');

  // Result
  const columns = ref<ColMeta[]>([]);
  const rows = ref<Record<string, unknown>[]>([]);
  const rowCount = ref(0);
  const truncated = ref(false);
  const transpiledSql = ref<string | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const hasRun = ref(false);

  async function runQuery(): Promise<void> {
    const graphStore = useGraphStore();
    const contextId = graphStore.currentContext?.id;
    if (!contextId) {
      error.value = 'No active context';
      return;
    }
    const query = (mode.value === 'cypher' ? cypherQuery.value : sqlQuery.value).trim();
    if (!query) return;

    loading.value = true;
    error.value = null;
    try {
      const resp = await api.executeTableQuery(contextId, {
        query,
        mode: mode.value,
        ...(graphStore.ctePrefilter ? { cte_prefilter: graphStore.ctePrefilter } : {}),
      });
      const cols = buildGenericColumns(resp.columns, resp.rows);
      columns.value = cols;
      rows.value = buildGenericRows(resp.rows, cols);
      rowCount.value = resp.row_count;
      truncated.value = resp.truncated;
      transpiledSql.value = resp.transpiled_sql ?? null;
      hasRun.value = true;
    } catch (e) {
      error.value = extractMessage(e, 'Query failed');
      columns.value = [];
      rows.value = [];
      rowCount.value = 0;
      truncated.value = false;
      transpiledSql.value = null;
      hasRun.value = true;
    } finally {
      loading.value = false;
    }
  }

  /** Clear the editor for the active mode. */
  function clearQuery() {
    if (mode.value === 'cypher') cypherQuery.value = '';
    else sqlQuery.value = '';
  }

  /** Drop the current result (e.g. on close). */
  function resetResult() {
    columns.value = [];
    rows.value = [];
    rowCount.value = 0;
    truncated.value = false;
    transpiledSql.value = null;
    error.value = null;
    hasRun.value = false;
  }

  return {
    mode,
    cypherQuery,
    sqlQuery,
    columns,
    rows,
    rowCount,
    truncated,
    transpiledSql,
    loading,
    error,
    hasRun,
    runQuery,
    clearQuery,
    resetResult,
  };
});
