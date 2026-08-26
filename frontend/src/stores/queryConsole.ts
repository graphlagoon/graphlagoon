import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/services/api';
import { extractErrorDetails as extractApiErrorDetails } from '@/utils/errorMessage';
import { useGraphStore } from '@/stores/graph';
import { useToast } from '@/composables/useToast';
import {
  capabilitiesFor,
  resolveDatasourceType,
} from '@/composables/useDatasourceCapabilities';
import {
  type ColMeta,
  buildGenericColumns,
  buildGenericRows,
} from '@/composables/useTableColumns';
import {
  useCancellableQuery,
  type StepResult,
} from '@/composables/useCancellableQuery';
import type {
  TableQueryMode,
  QueryMetadata,
  TableQueryResponse,
  TableQueryStatusResponse,
} from '@/types/graph';

/**
 * Dev-only console tracer for the Query Console execution lifecycle. Gated on
 * import.meta.env.DEV so it is tree-shaken out of production builds. Lets you
 * confirm in the browser console that submit → poll → render actually happens,
 * with chunk/row counts for each step.
 */
function qcLog(step: string, data?: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  // eslint-disable-next-line no-console
  console.log(
    `%c[QueryConsole]%c ${step}`,
    'color:#7c3aed;font-weight:bold',
    'color:inherit',
    data ?? '',
  );
}

/** Structured error, shaped to feed the shared QueryErrorModal. */
export interface QueryErrorInfo {
  message: string;
  code?: string;
  exceptionType?: string;
  traceback?: string[];
  query?: string;
}

/** Shape the shared extractor's output to feed the QueryErrorModal. */
function extractErrorDetails(e: unknown, fallback: string): QueryErrorInfo {
  const d = extractApiErrorDetails(e, fallback);
  return {
    message: d.message,
    code: d.code,
    exceptionType: d.exceptionType,
    traceback: d.traceback,
    // Prefer the failing transpiled SQL when present (cypher mode).
    query: d.query || d.transpiledSql,
  };
}

/**
 * Standalone store for the Query Console: run a generic OpenCypher/SQL query
 * and hold its tabular result. Kept separate from the (already large) graph
 * store — it only borrows `currentContext` and `ctePrefilter` from it. The
 * submit → poll → cancel lifecycle is delegated to the shared
 * {@link useCancellableQuery} composable (also used by the graph flow).
 */
export const useQueryConsoleStore = defineStore('queryConsole', () => {
  // Drawer open state (lifted here so other components — e.g. running a
  // table-mode template — can open the console).
  const isOpen = ref(false);

  // Input
  const mode = ref<TableQueryMode>('cypher');
  const cypherQuery = ref('');
  const sqlQuery = ref('');

  // Result (typed grid data + faithful raw result for export)
  const columns = ref<ColMeta[]>([]);
  const rows = ref<Record<string, unknown>[]>([]);
  const rawColumns = ref<string[]>([]);
  const rawRows = ref<(string | null)[][]>([]);
  const rowCount = ref(0);
  const truncated = ref(false);
  const transpiledSql = ref<string | null>(null);
  const metadata = ref<QueryMetadata | null>(null);
  const error = ref<QueryErrorInfo | null>(null);
  const hasRun = ref(false);

  function open() {
    isOpen.value = true;
  }
  function close() {
    isOpen.value = false;
  }
  function toggle() {
    isOpen.value = !isOpen.value;
  }

  /** Populate the grid + raw-export state from a completed result. */
  function applyResult(resultUnknown: unknown) {
    const result = resultUnknown as
      | TableQueryResponse
      | TableQueryStatusResponse;
    const cols = buildGenericColumns(result.columns, result.rows);
    columns.value = cols;
    rows.value = buildGenericRows(result.rows, cols);
    rawColumns.value = result.columns;
    rawRows.value = result.rows;
    rowCount.value = result.row_count;
    truncated.value = result.truncated;
    hasRun.value = true;
    qcLog('✔ rendered result', {
      rows: result.row_count,
      cols: cols.length,
      chunks: result.total_chunk_count ?? 1,
      total_rows: result.total_row_count ?? result.row_count,
      truncated: result.truncated,
    });
  }

  /** Drop any result state (on error/cancel), keeping metadata untouched. */
  function clearResultRows() {
    columns.value = [];
    rows.value = [];
    rawColumns.value = [];
    rawRows.value = [];
    rowCount.value = 0;
    truncated.value = false;
  }

  // Rendering mode for the CURRENT submit. Normally mirrors the graph store's
  // option; the CTE fallback overrides it to 'cte' for the retry run only, so
  // the saved option is never touched.
  let submitRenderingMode: 'cte' | 'procedural' = 'procedural';

  const cq = useCancellableQuery({
    submit: async (): Promise<StepResult> => {
      const graphStore = useGraphStore();
      const contextId = graphStore.currentContext!.id;
      const query = (
        mode.value === 'cypher' ? cypherQuery.value : sqlQuery.value
      ).trim();
      // A backend that runs Cypher natively rejects every option below, so
      // they are omitted entirely rather than sent and 400'd.
      const transpiles = capabilitiesFor(
        resolveDatasourceType(graphStore.currentContext),
      ).supportsTranspile;
      const resp = await api.executeTableQuery(contextId, {
        query,
        mode: mode.value,
        ...(transpiles && graphStore.ctePrefilter
          ? { cte_prefilter: graphStore.ctePrefilter }
          : {}),
        // Transpile options (cypher mode only) shared with the graph panel.
        ...(transpiles && mode.value === 'cypher'
          ? {
              vlp_rendering_mode: submitRenderingMode,
              materialization_strategy: graphStore.materializationStrategy,
              ...(submitRenderingMode === 'procedural'
                ? {
                    procedural_optimizations: {
                      ...graphStore.proceduralOptimizations,
                    },
                  }
                : {}),
            }
          : {}),
      });
      transpiledSql.value = resp.transpiled_sql ?? null;
      metadata.value = resp.metadata ?? null;
      // Keep the SQL editor in sync with what actually ran, so switching to the
      // SQL tab shows the real generated SQL (same convention as GraphQueryPanel).
      if (resp.transpiled_sql) sqlQuery.value = resp.transpiled_sql;
      return {
        status: resp.status ?? 'succeeded',
        statementId: resp.statement_id,
        result: resp,
      };
    },
    poll: async (statementId: string): Promise<StepResult> => {
      const graphStore = useGraphStore();
      const contextId = graphStore.currentContext!.id;
      const s = await api.getTableQueryStatus(contextId, statementId);
      return { status: s.status, statementId, result: s };
    },
    cancel: async (statementId: string): Promise<void> => {
      const graphStore = useGraphStore();
      const contextId = graphStore.currentContext?.id;
      if (contextId) await api.cancelTableQuery(contextId, statementId);
    },
    applyResult,
    onError: (e) => {
      error.value = extractErrorDetails(e, 'Query failed');
      clearResultRows();
      transpiledSql.value = null;
      metadata.value = null;
      hasRun.value = true;
    },
    onCanceled: () => {
      clearResultRows();
      hasRun.value = true;
    },
    onLog: qcLog,
  });

  async function runQuery(): Promise<void> {
    const graphStore = useGraphStore();
    const contextId = graphStore.currentContext?.id;
    if (!contextId) {
      error.value = { message: 'No active context' };
      hasRun.value = true;
      return;
    }
    const query = (
      mode.value === 'cypher' ? cypherQuery.value : sqlQuery.value
    ).trim();
    if (!query) return;

    error.value = null;
    submitRenderingMode = graphStore.vlpRenderingMode;
    await cq.run();
    // CTE fallback, same contract as the graph path: a failed procedural
    // cypher run is retried once in CTE (WITH RECURSIVE) mode. On the table
    // endpoint this matters even more — procedural mode emits a BEGIN…END SQL
    // script that the endpoint's read-only SELECT validation rejects outright,
    // so without the fallback a procedural table query can never run.
    if (
      error.value !== null &&
      !cq.canceled.value &&
      mode.value === 'cypher' &&
      capabilitiesFor(resolveDatasourceType(graphStore.currentContext))
        .supportsTranspile &&
      submitRenderingMode === 'procedural' &&
      graphStore.cteFallbackEnabled
    ) {
      if (!graphStore.cteFallbackSilent) {
        useToast().warning(
          'Procedural query failed — retrying in CTE (WITH RECURSIVE) mode…',
          5000,
        );
      }
      error.value = null;
      submitRenderingMode = 'cte';
      await cq.run();
      if (
        error.value === null &&
        !cq.canceled.value &&
        !graphStore.cteFallbackSilent
      ) {
        useToast().warning(
          'Result produced by the CTE fallback — the procedural transpile failed for this query.',
          6000,
        );
      }
    }
  }

  /** Cancel the in-flight query, releasing warehouse compute. No-op if idle. */
  async function cancelQuery(): Promise<void> {
    await cq.cancelQuery();
  }



  /** Dismiss the current error (keeps the last result, if any). */
  function clearError() {
    error.value = null;
  }

  /** Drop the current result (e.g. on close). */
  function resetResult() {
    cq.reset();
    columns.value = [];
    rows.value = [];
    rawColumns.value = [];
    rawRows.value = [];
    rowCount.value = 0;
    truncated.value = false;
    transpiledSql.value = null;
    metadata.value = null;
    error.value = null;
    hasRun.value = false;
  }

  return {
    isOpen,
    mode,
    cypherQuery,
    sqlQuery,
    columns,
    rows,
    rawColumns,
    rawRows,
    rowCount,
    truncated,
    transpiledSql,
    metadata,
    // lifecycle state from the shared composable
    loading: cq.loading,
    statementId: cq.statementId,
    canceled: cq.canceled,
    chunkProgress: cq.chunkProgress,
    canCancel: cq.canCancel,
    error,
    hasRun,
    open,
    close,
    toggle,
    runQuery,
    cancelQuery,
    clearError,
    resetResult,
  };
});
