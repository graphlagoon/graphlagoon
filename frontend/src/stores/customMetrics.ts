/**
 * Custom Metrics Store
 *
 * Owns the writer-authored metric definitions of the current context
 * (persisted on `graph_contexts.metric_definitions`) and orchestrates their
 * evaluation in the sandboxed worker (services/customMetricRunner.ts).
 * Results land in the metrics store as regular ComputedMetrics with the
 * stable id `custom:<definitionId>`.
 *
 * Persistence follows stores/contextMenuActions.ts: hydration never PUTs,
 * edits are debounced into one PUT of the full list, and nothing is sent
 * without write access on the context. The backend only returns definitions
 * to writers, so a read-only user hydrates an empty list and never spawns
 * a worker.
 *
 * Recompute triggers (debounced + coalesced): hydration, any definition
 * change, the filtered node/edge population changing, and late-arriving node
 * properties (`graphStore.nodePatchVersion`).
 */
import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type {
  CustomMetricDefinition,
  CustomMetricRunState,
  CustomMetricTestResult,
} from '@/types/customMetrics';
import {
  CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS,
  customMetricId,
  isCustomMetricId,
} from '@/types/customMetrics';
import {
  runDefinitions,
  serializeGraphForCustomMetrics,
  testDefinition as runTest,
  type RunHandle,
} from '@/services/customMetricRunner';
import { api } from '@/services/api';
import { useGraphStore } from './graph';
import { useMetricsStore } from './metrics';
import { useToast } from '@/composables/useToast';
import { useFeatureFlags } from '@/composables/useFeatureFlags';

const PERSIST_DEBOUNCE_MS = 800;

export const useCustomMetricsStore = defineStore('customMetrics', () => {
  const graphStore = useGraphStore();
  const metricsStore = useMetricsStore();
  const { customMetricsEnabled, customMetricsAutoRunEnabled } = useFeatureFlags();

  const definitions = ref<CustomMetricDefinition[]>([]);
  const runStates = ref<Map<string, CustomMetricRunState>>(new Map());
  const error = ref<string | null>(null);

  const canEdit = computed(
    () => customMetricsEnabled.value && graphStore.currentContext?.has_write_access === true,
  );
  /** Server flag: may `auto_run` definitions evaluate on load at all? */
  const autoRunAllowed = computed(() => customMetricsAutoRunEnabled.value);
  /** Definitions that run automatically on load / graph change. */
  const autoRunIds = computed(() =>
    autoRunAllowed.value ? definitions.value.filter((d) => d.auto_run === true).map((d) => d.id) : [],
  );
  const isComputing = computed(() =>
    Array.from(runStates.value.values()).some((s) => s.status === 'running' || s.status === 'queued'),
  );

  let isHydrating = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let recomputeTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingIds: Set<string> | null = null; // null = everything
  let currentRun: RunHandle | null = null;

  // ============================================================================
  // Hydration (context load / switch)
  // ============================================================================

  function hydrateFromContext(defs?: CustomMetricDefinition[]): void {
    isHydrating = true;
    try {
      // Feature off: nothing is kept, so nothing can run (the backend already
      // returns [] in that case; this is the belt to its braces).
      const next = customMetricsEnabled.value ? (defs ?? []).map((d) => ({ ...d })) : [];
      const keep = new Set(next.map((d) => customMetricId(d.id)));
      // Drop the previous context's custom metrics (or definitions removed
      // elsewhere) from the metrics store.
      for (const id of Array.from(metricsStore.computedMetrics.keys())) {
        if (isCustomMetricId(id) && !keep.has(id)) metricsStore.deleteMetric(id);
      }
      definitions.value = next;
      runStates.value = new Map();
      // The Data Table flag travels with the definition (stable custom ids).
      for (const d of next) {
        const mid = customMetricId(d.id);
        if (d.show_in_table === true) metricsStore.tableMetricIds.add(mid);
        else metricsStore.tableMetricIds.delete(mid);
      }
      cancelRun();
    } finally {
      isHydrating = false;
    }
    // Only auto_run definitions evaluate on load; the rest wait for Recompute.
    runAutoOrMarkManual();
  }

  /**
   * Graph loaded / changed: schedule the auto_run definitions and mark every
   * other one as needing a manual run (stale when it already has values).
   */
  function runAutoOrMarkManual(): void {
    const auto = new Set(autoRunIds.value);
    for (const d of definitions.value) {
      if (auto.has(d.id)) continue;
      const hasValues = metricsStore.computedMetrics.has(customMetricId(d.id));
      setRunState(d.id, { status: hasValues ? 'stale' : 'idle', progress: 0, error: undefined });
    }
    if (auto.size > 0) scheduleRecompute(Array.from(auto));
  }

  // ============================================================================
  // Definition CRUD (persist + recompute)
  // ============================================================================

  function addDefinition(def: CustomMetricDefinition): void {
    definitions.value.push({ ...def });
    if (def.show_in_table === true) metricsStore.tableMetricIds.add(customMetricId(def.id));
    persistToContext();
    scheduleRecompute([def.id]);
  }

  function updateDefinition(def: CustomMetricDefinition): void {
    const i = definitions.value.findIndex((d) => d.id === def.id);
    if (i === -1) return;
    definitions.value[i] = { ...def };
    const mid = customMetricId(def.id);
    if (def.show_in_table === true) metricsStore.tableMetricIds.add(mid);
    else metricsStore.tableMetricIds.delete(mid);
    persistToContext();
    scheduleRecompute([def.id]);
  }

  /**
   * Import semantics: a pasted metric whose id — or, failing that, whose
   * name (case-insensitive) — matches an existing definition UPDATES it in
   * place (keeping the existing id); anything else is added. Returns what
   * happened so the UI can say "2 updated, 1 added".
   */
  function upsertDefinitions(defs: CustomMetricDefinition[]): { updated: number; added: number } {
    let updated = 0;
    let added = 0;
    for (const def of defs) {
      const byId = definitions.value.find((d) => d.id === def.id);
      const byName = byId ?? definitions.value.find((d) => d.name.trim().toLowerCase() === def.name.trim().toLowerCase());
      if (byName) {
        updateDefinition({ ...def, id: byName.id });
        updated++;
      } else {
        addDefinition(def);
        added++;
      }
    }
    return { updated, added };
  }

  /** Persisted Data Table flag — no recompute, just the definition + the session set. */
  function setShowInTable(id: string, show: boolean): void {
    const i = definitions.value.findIndex((d) => d.id === id);
    if (i === -1) return;
    const next = { ...definitions.value[i] };
    if (show) next.show_in_table = true;
    else delete next.show_in_table;
    definitions.value[i] = next;
    const mid = customMetricId(id);
    if (show) metricsStore.tableMetricIds.add(mid);
    else metricsStore.tableMetricIds.delete(mid);
    persistToContext();
  }

  function removeDefinition(id: string): void {
    definitions.value = definitions.value.filter((d) => d.id !== id);
    runStates.value.delete(id);
    metricsStore.deleteMetric(customMetricId(id));
    persistToContext();
  }

  function getDefinition(id: string): CustomMetricDefinition | undefined {
    return definitions.value.find((d) => d.id === id);
  }

  /** Case-insensitive name uniqueness, ignoring `exceptId` (edit form). */
  function isNameAvailable(name: string, exceptId?: string): boolean {
    const key = name.trim().toLowerCase();
    return !definitions.value.some((d) => d.id !== exceptId && d.name.trim().toLowerCase() === key);
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  function persistToContext(): void {
    if (isHydrating) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void doPersist();
    }, PERSIST_DEBOUNCE_MS);
  }

  async function doPersist(): Promise<void> {
    const context = graphStore.currentContext;
    if (!context || !context.has_write_access) return;
    try {
      const updated = await api.updateGraphContext(context.id, {
        metric_definitions: definitions.value.map((d) => ({ ...d })),
      });
      if (graphStore.currentContext?.id === updated.id) {
        graphStore.currentContext = updated;
      }
      error.value = null;
    } catch (e) {
      console.warn('Failed to persist custom metrics:', e);
      error.value = 'Failed to save custom metrics to the context';
      useToast().error('Failed to save custom metrics to the context');
    }
  }

  async function flushPersist(): Promise<void> {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
      await doPersist();
    }
  }

  // ============================================================================
  // Evaluation
  // ============================================================================

  function setRunState(id: string, patch: Partial<CustomMetricRunState>): void {
    const prev = runStates.value.get(id) ?? { status: 'idle', progress: 0, elapsedMs: 0, errorCount: 0 };
    runStates.value.set(id, { ...prev, ...patch });
  }

  function cancelRun(): void {
    if (currentRun) {
      currentRun.cancel();
      currentRun = null;
    }
    if (recomputeTimer) {
      clearTimeout(recomputeTimer);
      recomputeTimer = null;
    }
    pendingIds = null;
  }

  /** Debounced + coalesced: `ids` omitted = every definition. */
  function scheduleRecompute(ids?: string[]): void {
    if (!ids) pendingIds = null;
    else if (pendingIds !== null || recomputeTimer === null) {
      pendingIds = pendingIds ?? new Set();
      for (const id of ids) pendingIds.add(id);
    }
    for (const id of ids ?? definitions.value.map((d) => d.id)) {
      setRunState(id, { status: 'queued', progress: 0, error: undefined });
    }
    if (recomputeTimer) clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(() => {
      recomputeTimer = null;
      const ids = pendingIds ? Array.from(pendingIds) : undefined;
      pendingIds = null;
      void recomputeNow(ids);
    }, CUSTOM_METRIC_RECOMPUTE_DEBOUNCE_MS);
  }

  /** Run immediately (cancels an in-flight run). */
  async function recomputeNow(ids?: string[]): Promise<void> {
    if (currentRun) {
      currentRun.cancel();
      currentRun = null;
    }
    const defs = ids
      ? definitions.value.filter((d) => ids.includes(d.id))
      : definitions.value.slice();
    if (defs.length === 0) return;

    const snapshot = serializeGraphForCustomMetrics();
    for (const d of defs) setRunState(d.id, { status: 'queued', progress: 0, error: undefined });

    const handle = runDefinitions(defs, snapshot, {
      onStarted: (id) => setRunState(id, { status: 'running', progress: 0 }),
      onProgress: (id, done, total) =>
        setRunState(id, { progress: total > 0 ? Math.round((done / total) * 100) : 100 }),
      onResult: (id, metric) => {
        metricsStore.upsertMetric(metric);
        setRunState(id, {
          status: 'done',
          progress: 100,
          elapsedMs: metric.elapsedMs,
          errorCount: metric.errorCount ?? 0,
          error: undefined,
        });
      },
      onError: (id, message) => setRunState(id, { status: 'error', error: message }),
    });
    currentRun = handle;
    try {
      await handle.done;
    } catch {
      /* cancelled — a newer run superseded this one */
    } finally {
      if (currentRun === handle) currentRun = null;
    }
  }

  /** Evaluate a draft over a sample without touching the store. */
  function testDefinition(def: CustomMetricDefinition): Promise<CustomMetricTestResult> {
    return runTest(def, serializeGraphForCustomMetrics());
  }

  // ============================================================================
  // Recompute triggers
  // ============================================================================

  watch(
    () => [graphStore.filteredNodes.length, graphStore.filteredEdges.length, graphStore.nodePatchVersion],
    () => {
      if (definitions.value.length > 0) runAutoOrMarkManual();
    },
  );

  return {
    definitions,
    runStates,
    error,
    canEdit,
    autoRunAllowed,
    autoRunIds,
    isComputing,
    hydrateFromContext,
    addDefinition,
    updateDefinition,
    upsertDefinitions,
    setShowInTable,
    removeDefinition,
    getDefinition,
    isNameAvailable,
    persistToContext,
    flushPersist,
    scheduleRecompute,
    recomputeNow,
    testDefinition,
    cancelRun,
  };
});
