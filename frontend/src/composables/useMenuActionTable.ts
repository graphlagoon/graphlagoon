import { ref, computed, toRaw } from 'vue';
import { api } from '@/services/api';
import { useGraphStore } from '@/stores/graph';
import { useMetricsStore } from '@/stores/metrics';
import { runTableProgram } from '@/services/tableProgramRunner';
import type { SandboxRun } from '@/services/sandboxRunner';
import type { CanvasTableParam, CanvasTableSource } from '@/types/contextMenuActions';
import {
  neighborhoodParams,
  neighborhoodTable,
  programUsesMetric,
  toTable,
  withNeighborhoodValues,
  type CanvasGraph,
  type CanvasItem,
  type CanvasTableResult,
} from '@/utils/canvasTable';
import type { TableProgramSnapshot } from '@/workers/tableProgramEvaluate';
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
  /**
   * A canvas table (`show-table` action): the rows come from the graph on the
   * canvas, in the browser, not from the warehouse. `target` then carries the
   * canvas ids too.
   */
  canvas?: {
    source: CanvasTableSource;
    item: CanvasItem;
    /** paramId -> binding template, shown next to the bound inputs. */
    bindings?: Record<string, string>;
  };
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

  // ── Canvas tables: computed in the browser from the graph on the canvas ──
  const canvas = request.canvas;
  const canvasLoading = ref(false);
  const canvasCanceled = ref(false);
  let program: SandboxRun | null = null;

  function canvasParams(): CanvasTableParam[] {
    if (!canvas) return [];
    return canvas.source.type === 'neighborhood' ? neighborhoodParams(canvas.source) : canvas.source.params ?? [];
  }

  if (canvas) {
    templateName.value = canvas.source.type === 'neighborhood' ? 'Canvas neighbors' : 'Canvas program';
    parameters.value = canvasParams().map((p) => {
      const given = request.parameters[p.id];
      const binding = canvas.bindings?.[p.id] || null;
      return {
        id: p.id,
        label: p.label || p.id,
        type: p.type === 'select' ? 'select' : 'input',
        options: p.options ?? null,
        required: !!p.required,
        description: p.description ?? null,
        binding,
        value: given ?? p.default ?? '',
        source: given !== undefined ? (binding ? 'binding' : 'given') : 'default',
      };
    });
    values.value = Object.fromEntries(parameters.value.map((p) => [p.id, p.value]));
  }

  function canvasProblems(vals: Record<string, string>): Record<string, string> {
    const found: Record<string, string> = {};
    for (const p of parameters.value) {
      const v = (vals[p.id] ?? '').trim();
      if (p.required && !v) found[p.id] = 'needs a value';
      else if (v && p.type === 'select' && p.options?.length && !p.options.includes(v)) found[p.id] = `must be one of ${p.options.join(', ')}`;
    }
    return found;
  }

  function canvasGraph(): CanvasGraph {
    const graph = useGraphStore();
    return {
      nodes: graph.nodes.map((n) => {
        const raw = toRaw(n);
        return { node_id: raw.node_id, node_type: raw.node_type, properties: toRaw(raw.properties) };
      }),
      edges: graph.edges.map((e) => {
        const raw = toRaw(e);
        return { edge_id: raw.edge_id, src: raw.src, dst: raw.dst, relationship_type: raw.relationship_type, properties: toRaw(raw.properties) };
      }),
    };
  }

  function showCanvasRows(table: CanvasTableResult, vals: Record<string, string>) {
    columns.value = table.columns;
    rows.value = table.rows;
    truncated.value = table.truncated;
    ranWith.value = vals;
  }

  async function runCanvas(): Promise<void> {
    if (!canvas) return;
    program?.cancel();
    hasRun.value = true;
    canvasCanceled.value = false;
    const vals = Object.fromEntries(parameters.value.map((p) => [p.id, values.value[p.id] ?? '']));
    problems.value = canvasProblems(vals);
    if (Object.keys(problems.value).length) {
      clearRows();
      return;
    }
    const metrics = useMetricsStore();
    if (canvas.source.type === 'neighborhood') {
      try {
        showCanvasRows(
          neighborhoodTable(canvasGraph(), canvas.item, withNeighborhoodValues(canvas.source, vals), metrics.metricResolver, rowLimit.value),
          vals,
        );
      } catch (e) {
        clearRows();
        error.value = getErrorMessage(e, 'The table failed');
      }
      return;
    }
    const code = canvas.source.code;
    const graph = canvasGraph();
    const withValues = programUsesMetric(code);
    const snapshot: TableProgramSnapshot = {
      ...graph,
      // The request sits in a ref (a reactive proxy): send a plain copy, the worker clones it.
      item: JSON.parse(JSON.stringify(canvas.item)),
      params: vals,
      selectedNodeIds: Array.from(useGraphStore().selectedNodeIds),
      metrics: [...metrics.nodeMetrics, ...metrics.edgeMetrics].map((m) => ({
        id: m.id,
        name: m.name,
        target: m.target as 'node' | 'edge',
        valueType: m.valueType,
        ...(withValues ? { values: Array.from(toRaw(m.values).entries()) } : {}),
      })),
    };
    const current = runTableProgram(code, snapshot);
    program = current;
    canvasLoading.value = true;
    const outcome = await current.outcome;
    if (program !== current) return; // a newer run took over
    program = null;
    canvasLoading.value = false;
    if (!outcome.ok) {
      clearRows();
      if (outcome.canceled) canvasCanceled.value = true;
      else error.value = outcome.error;
      return;
    }
    try {
      showCanvasRows(toTable(outcome.result, rowLimit.value), vals);
    } catch (e) {
      clearRows();
      error.value = getErrorMessage(e, 'The program returned something that is not a table');
    }
  }

  async function run(): Promise<void> {
    error.value = null;
    problems.value = {};
    if (canvas) return runCanvas();
    await cq.run();
  }

  function cancel(): void {
    if (program) program.cancel();
    else void cq.cancelQuery();
  }

  /** Run again with every row the endpoint allows. */
  async function loadAll(): Promise<void> {
    rowLimit.value = MAX_TABLE_ROW_LIMIT;
    await run();
  }

  const needsParameters = computed(() => Object.keys(problems.value).length > 0);
  /** The inputs no longer match the rows on screen: Run to update. */
  const changed = computed(
    () => hasRun.value && columns.value.length > 0 && parameters.value.some((p) => (values.value[p.id] ?? '') !== (ranWith.value[p.id] ?? '')),
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
    loading: computed(() => cq.loading.value || canvasLoading.value),
    canCancel: computed(() => cq.canCancel.value || canvasLoading.value),
    canceled: computed(() => cq.canceled.value || canvasCanceled.value),
    /** Rows from the graph on the canvas (instant, what is loaded) rather than the warehouse. */
    isCanvas: !!canvas,
    run,
    loadAll,
    cancel,
  };
}
