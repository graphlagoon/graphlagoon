/**
 * Custom (user-defined) metrics
 *
 * A writer of a context can persist small JavaScript snippets that are
 * evaluated per node or per edge inside a sandboxed, dedicated Web Worker
 * (see workers/customMetricWorker.ts) with a hard timeout. The result is a
 * regular ComputedMetric (id `custom:<definitionId>`) whose values may be
 * numbers, strings or booleans.
 *
 * The backend returns `metric_definitions` only to users with write access,
 * so a read-only user never receives — let alone runs — another user's code.
 */

import type { MetricValue, MetricValueType } from './metrics';

export type { MetricValue, MetricValueType };

export type MetricTarget = 'node' | 'edge';

/** Persisted on graph_contexts.metric_definitions (writers only). */
export interface CustomMetricDefinition {
  /** uuid; the metric id is `custom:<id>` — stable across reloads */
  id: string;
  /** 1..80 chars, unique per context (case-insensitive) */
  name: string;
  target: MetricTarget;
  value_type: MetricValueType;
  /** body of `function(item, ctx) { ... }`; ≤ 20 000 chars */
  code: string;
  description?: string;
  /**
   * Evaluate automatically whenever the graph loads — in every writer's
   * browser. Off by default (nothing runs without someone asking); also
   * subject to the server flag `custom_metrics_auto_run_enabled`.
   */
  auto_run?: boolean;
  /** Show as a Data Table column. Persisted with the definition (context-level). */
  show_in_table?: boolean;
}

export const CUSTOM_METRIC_ID_PREFIX = 'custom:';
export const customMetricId = (definitionId: string): string =>
  `${CUSTOM_METRIC_ID_PREFIX}${definitionId}`;
export const isCustomMetricId = (id: string): boolean =>
  id.startsWith(CUSTOM_METRIC_ID_PREFIX);
export const CUSTOM_ALGORITHM_ID = 'custom';

export const CUSTOM_METRIC_TIMEOUT_MS = 10_000;
export const CUSTOM_METRIC_MAX_STRING_LENGTH = 500;
export const CUSTOM_METRIC_MAX_CODE_LENGTH = 20_000;
export const CUSTOM_METRIC_MAX_NAME_LENGTH = 80;
export const CUSTOM_METRIC_MAX_DESCRIPTION_LENGTH = 500;
export const CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS = 750;
export const CUSTOM_METRIC_TEST_SAMPLE_SIZE = 50;
/** Items between PROGRESS messages inside the worker */
export const CUSTOM_METRIC_PROGRESS_EVERY = 5_000;

// ---------------------------------------------------------------------------
// What user code receives — plain, structured-clone-safe objects
// ---------------------------------------------------------------------------

export interface CustomMetricNodeItem {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface CustomMetricEdgeItem {
  id: string;
  relationship_type: string;
  src: string;
  dst: string;
  properties: Record<string, unknown>;
}

export type CustomMetricItem = CustomMetricNodeItem | CustomMetricEdgeItem;

export interface CustomMetricGraphSummary {
  nodeCount: number;
  edgeCount: number;
  /** 2E / N (0 for an empty graph) */
  meanDegree: number;
  /** E / (N (N - 1)) for a directed graph (0 when N < 2) */
  density: number;
}

/**
 * Everything the worker needs to evaluate every definition of one run.
 * Cloned once per recompute cycle (not per definition). Adjacency indexes
 * are built inside the worker from `edges`, never cloned.
 */
export interface CustomMetricSnapshot {
  nodes: CustomMetricNodeItem[];
  edges: CustomMetricEdgeItem[];
  /** nodeId -> degree (from graphStore.nodeDegrees) */
  degrees: [string, number][];
  /** metric name -> [itemId, value][] — built-in + algorithm metrics, never custom ones */
  metrics: Record<string, [string, MetricValue][]>;
  /** metric id -> metric name, so ctx.metric() can resolve by id too */
  metricIdToName: Record<string, string>;
  /** algorithm id -> name of its most recent run */
  metricsByAlgorithm: Record<string, string>;
  /** nodeId -> community id (from the community store, when computed) */
  communities: [string, number][];
  summary: CustomMetricGraphSummary;
}

/** The `ctx` argument seen by user code. */
export interface CustomMetricContext {
  /** this node's degree (nodes only; undefined for edges) */
  degree: number | undefined;
  degreeOf(id: string): number;
  /** undirected, deduped */
  neighbors(id: string): string[];
  outNeighbors(id: string): string[];
  inNeighbors(id: string): string[];
  edgesOf(id: string): CustomMetricEdgeItem[];
  /** directed */
  hasEdge(src: string, dst: string): boolean;
  /** undirected */
  isConnected(a: string, b: string): boolean;
  node(id: string): CustomMetricNodeItem | undefined;
  /** metric name -> value for THIS item */
  metrics: Record<string, MetricValue>;
  /** ref = algorithm id (latest run), metric name, or metric id; id defaults to item.id */
  metric(ref: string, id?: string): MetricValue | undefined;
  community(id: string): number | null;
  graph: CustomMetricGraphSummary;
  nodes: readonly CustomMetricNodeItem[];
  edges: readonly CustomMetricEdgeItem[];
  /** mutable object shared across the items of one definition run */
  cache: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Run state (store) and worker protocol
// ---------------------------------------------------------------------------

export type CustomMetricRunStatus = 'idle' | 'queued' | 'running' | 'done' | 'error' | 'stale';

export interface CustomMetricRunState {
  status: CustomMetricRunStatus;
  /** 0..100 */
  progress: number;
  elapsedMs: number;
  /** compile error / timeout / worker crash */
  error?: string;
  /** per-item exceptions (value coerced to null) */
  errorCount: number;
  firstItemError?: string;
}

export type CustomMetricRunnable = Pick<
  CustomMetricDefinition,
  'id' | 'target' | 'value_type' | 'code'
>;

export interface CustomMetricEvaluation {
  values: [string, MetricValue][];
  errorCount: number;
  firstItemError?: string;
  elapsedMs: number;
}

export interface CustomMetricTestSample {
  id: string;
  value: MetricValue;
  /** typeof the raw return value, before coercion */
  rawType: string;
}

export interface CustomMetricTestResult {
  samples: CustomMetricTestSample[];
  errorCount: number;
  firstItemError?: string;
  /** compile failure (or timeout / crash) — no samples in that case */
  error?: string;
  elapsedMs: number;
}

export type CustomMetricWorkerCommand =
  | {
      type: 'RUN';
      runId: string;
      definitions: CustomMetricRunnable[];
      snapshot: CustomMetricSnapshot;
    }
  | {
      type: 'TEST';
      runId: string;
      definition: CustomMetricRunnable;
      snapshot: CustomMetricSnapshot;
      sampleSize: number;
    };

export type CustomMetricWorkerMessage =
  | { type: 'READY' }
  | { type: 'DEFINITION_STARTED'; runId: string; definitionId: string }
  | { type: 'PROGRESS'; runId: string; definitionId: string; done: number; total: number }
  | {
      type: 'DEFINITION_RESULT';
      runId: string;
      definitionId: string;
      values: [string, MetricValue][];
      errorCount: number;
      firstItemError?: string;
      elapsedMs: number;
    }
  | { type: 'DEFINITION_ERROR'; runId: string; definitionId: string; error: string }
  | { type: 'TEST_RESULT'; runId: string; definitionId: string; result: CustomMetricTestResult }
  | { type: 'RUN_COMPLETE'; runId: string };
