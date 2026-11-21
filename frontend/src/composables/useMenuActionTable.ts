import { ref, computed } from 'vue';
import { api } from '@/services/api';
import { useCancellableQuery, type StepResult } from './useCancellableQuery';
import { getErrorMessage } from '@/utils/errorMessage';
import type {
  MenuActionParameter,
  MenuActionTableResponse,
  MenuActionTarget,
  TableQueryStatusResponse,
} from '@/types/graph';

/** What a right-click table action asks for: everything the server run needs. */
export interface MenuActionTableRequest {
  contextId: string;
  actionId: string;
  label: string;
  target: MenuActionTarget;
  /** Values the browser resolved from the clicked item (full label engine). */
  parameters: Record<string, string>;
}

export const TABLE_ROW_LIMIT = 10_000;
/** The table-query endpoint's ceiling. */
export const MAX_TABLE_ROW_LIMIT = 100_000;

/**
 * Runs a menu table action on the server and follows it to its rows: submit,
 * poll and cancel through the table-query routes (useCancellableQuery). The
 * parameters come back from the server with their values and problems, so the
 * modal shows them without the query-templates store (absent on a case canvas).
 */
export function useMenuActionTable(request: MenuActionTableRequest) {
  const values = ref<Record<string, string>>({ ...request.parameters });
  const rowLimit = ref(TABLE_ROW_LIMIT);
  const parameters = ref<MenuActionParameter[]>([]);
  const problems = ref<Record<string, string>>({});
  const templateName = ref('');
  const columns = ref<string[]>([]);
  const rows = ref<(string | null)[][]>([]);
  const truncated = ref(false);
  const error = ref<string | null>(null);
  const hasRun = ref(false);
  /** The values the rows on screen were run with (what a saved table is labelled with). */
  const ranWith = ref<Record<string, string>>({});
  // The values of the run in flight: they become `ranWith` only when its rows arrive.
  let pending: Record<string, string> = {};

  function clearRows() {
    columns.value = [];
    rows.value = [];
    truncated.value = false;
  }

  function applyResult(result: unknown) {
    hasRun.value = true;
    const r = result as MenuActionTableResponse | TableQueryStatusResponse;
    if ('parameters' in r) {
      // The submit answer: parameters, problems, maybe an error or the rows already.
      parameters.value = r.parameters;
      problems.value = r.problems ?? {};
      templateName.value = r.template_name ?? '';
      // Only the declared parameters: a binding left by a removed one is dropped.
      values.value = Object.fromEntries(r.parameters.map((p) => [p.id, p.value]));
      if (r.status === 'failed') {
        clearRows();
        error.value = r.error?.message ?? 'The query failed';
        return;
      }
      if (r.status === 'needs_parameters') {
        clearRows();
        return;
      }
    }
    if (r.status === 'running') return; // rows arrive with the polls
    error.value = null;
    columns.value = r.columns ?? [];
    rows.value = r.rows ?? [];
    // Same rule as the server's fast path: the warehouse may know of rows it did not return.
    const total = 'total_row_count' in r ? r.total_row_count ?? 0 : 0;
    truncated.value = !!r.truncated || total > (r.row_count ?? rows.value.length);
    ranWith.value = pending;
  }

  const cq = useCancellableQuery({
    submit: async (): Promise<StepResult> => {
      const response = await api.runMenuActionTable(request.contextId, request.actionId, {
        target: request.target,
        parameters: { ...values.value },
        row_limit: rowLimit.value,
      });
      // What runs: the server's values (bindings and defaults filled in).
      pending = Object.fromEntries(response.parameters.map((p) => [p.id, p.value]));
      if (response.status === 'running' && response.statement_id) {
        // Parameters are known now; the rows arrive with the polls.
        applyResult(response);
        return { status: 'running', statementId: response.statement_id };
      }
      return { status: 'succeeded', result: response };
    },
    poll: async (statementId: string): Promise<StepResult> => {
      const s = await api.getTableQueryStatus(request.contextId, statementId, rowLimit.value);
      return { status: s.status, statementId, result: s };
    },
    cancel: (statementId: string) => api.cancelTableQuery(request.contextId, statementId),
    applyResult,
    onError: (e) => {
      hasRun.value = true;
      clearRows();
      error.value = getErrorMessage(e, 'The query failed');
    },
    onCanceled: () => {
      clearRows();
    },
  });

  async function run(): Promise<void> {
    error.value = null;
    problems.value = {};
    await cq.run();
  }

  /** Run again with every row the endpoint allows. */
  async function loadAll(): Promise<void> {
    rowLimit.value = MAX_TABLE_ROW_LIMIT;
    await run();
  }

  const needsParameters = computed(() => Object.keys(problems.value).length > 0);
  /** The inputs no longer match the rows on screen: Run to update. */
  const changed = computed(
    () => hasRun.value && parameters.value.some((p) => (values.value[p.id] ?? '') !== (ranWith.value[p.id] ?? '')),
  );

  return {
    values,
    rowLimit,
    parameters,
    problems,
    needsParameters,
    changed,
    ranWith,
    templateName,
    columns,
    rows,
    truncated,
    error,
    hasRun,
    loading: cq.loading,
    canCancel: cq.canCancel,
    canceled: cq.canceled,
    run,
    loadAll,
    cancel: cq.cancelQuery,
  };
}
