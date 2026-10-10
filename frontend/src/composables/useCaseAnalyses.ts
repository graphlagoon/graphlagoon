/**
 * Analyses of the case (05 §3 "Resultado = item"): follow the money, paths,
 * typologies, Vínculos (shared attributes) and metrics run on the unified graph
 * (workers when available) and come back as items with provenance
 * `{tool, params}`; the panels render from the item's content, never from a
 * volatile store. Re-running into an item adds a version.
 */
import { computed, ref } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { useGraphStore } from '@/stores/graph';
import { useMetricsStore } from '@/stores/metrics';
import { caseNodeLabel } from '@/utils/caseLabels';
import { edgeValue } from '@/utils/edgeSemantics';
import { sharedAttributeLinks, type SharedLinkEdge, type SharedLinkPair, type SharedLinksParams } from '@/utils/entityResolution';
import { findPaths, MAX_K, type Path, type PathParams } from '@/utils/paths';
import { orientEdges, runTrace, toTraceEdges, type Allocation, type TraceEdge, type TraceParams, type TraceResult } from '@/utils/trace';
import { methodStamp } from '@/utils/traceView';
import { runTypologies, TYPOLOGIES, type TypologyParams, type TypologyResult } from '@/utils/typologies';
import type { PathWorkerInput, PathWorkerOutput } from '@/workers/pathWorker';
import type { TraceWorkerInput, TraceWorkerOutput } from '@/workers/traceWorker';
import type { CaseItem } from '@/types/investigation';

export type TraceDirection = TraceParams['direction'];
const HOUR = 3_600_000;
/** README Q4 defaults. */
export const TRACE_DEFAULTS = { maxHops: 3, dwellHours: 24, minAmount: 50 };
/** Node types checked as stops by default: cash-out, crypto, betting and out-of-case banks. */
export const DEFAULT_STOP_TYPE = /saque|withdraw|atm|cash|exchange|cripto|crypto|aposta|bet|externo|external/i;

export const ALLOCATIONS: Record<TraceDirection, { id: Allocation; label: string; hint: string }[]> = {
  forward: [
    { id: 'fifo', label: 'FIFO', hint: 'first in, first out' },
    { id: 'proportional', label: 'Proportional', hint: 'splits by the balance mix' },
    { id: 'libr', label: 'LIBR', hint: 'lowest intermediate balance' },
    { id: 'total', label: 'Total contamination', hint: 'upper bound' },
  ],
  // FIFO and LIBR lose their meaning on reversed edges (utils/trace.ts traceBackward).
  backward: [
    { id: 'lifo', label: 'LIFO', hint: 'last in, first out' },
    { id: 'proportional', label: 'Proportional', hint: 'splits by the balance mix' },
    { id: 'total', label: 'Total contamination', hint: 'upper bound' },
  ],
};

export interface TraceRunParams {
  seedEdgeIds: string[];
  seedLabel: string;
  direction: TraceDirection;
  maxHops: number;
  dwellHours: number | null;
  minAmount: number;
  window: [number, number] | null;
  allocation: Allocation;
  stopTypes: string[];
}

/** Content of a `table/result` item with `provenance.tool = trace`. */
export interface TraceContent {
  tool: 'trace';
  result: TraceResult;
  /** Oriented edges the trace walked and valued (`traceFlows` input). */
  walked: TraceEdge[];
  seedLabel: string;
  stamp: string;
  /** Exits under the proportional rule, for "proportional would give". */
  proportionalExits: Record<string, number> | null;
}

export interface PathsContent {
  tool: 'paths';
  source: string;
  target: string;
  params: PathParams;
  paths: Path[];
}

export interface TypologiesContent {
  tool: 'typologies';
  params: Record<string, TypologyParams>;
  results: TypologyResult[];
}

/** A `graph/derived` item: unified ids, `compartilha_<attr>` edges. */
export interface LinksContent {
  tool: 'links';
  unified: true;
  params: SharedLinksParams;
  nodes: { id: string; type: string; properties: Record<string, unknown> }[];
  edges: { id: string; source: string; target: string; type: string; properties: SharedLinkEdge['properties'] }[];
  pairs: SharedLinkPair[];
}

export interface MetricsContent {
  tool: 'metrics';
  columns: string[];
  rows: Record<string, unknown>[];
}

function traceInWorker(input: Omit<TraceWorkerInput, 'type'>): Promise<TraceResult> {
  // jsdom (unit tests) has no Worker: same core, on the main thread.
  if (typeof Worker === 'undefined') return Promise.resolve(runTrace(input.edges, input.nodeTypes, input.seed, input.params));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('@/workers/traceWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<TraceWorkerOutput>) => {
      worker.terminate();
      if (e.data.type === 'RESULT') resolve(e.data.result);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage({ type: 'RUN', ...input } as TraceWorkerInput);
  });
}

function pathsInWorker(input: Omit<PathWorkerInput, 'type'>): Promise<Path[]> {
  if (typeof Worker === 'undefined') return Promise.resolve(findPaths(input.edges, input.source, input.target, input.params));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('@/workers/pathWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<PathWorkerOutput>) => {
      worker.terminate();
      if (e.data.type === 'RESULT') resolve(e.data.paths);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage({ type: 'RUN', ...input } as PathWorkerInput);
  });
}

export function useCaseAnalyses() {
  const inv = useInvestigationStore();
  const graph = useGraphStore();
  const running = ref<string | null>(null);
  const error = ref<string | null>(null);

  const traceEdges = computed(() => toTraceEdges(inv.unified.edges, null));
  const nodeTypes = computed<Record<string, string>>(() => Object.fromEntries(inv.unified.nodes.map((n) => [n.node_id, n.node_type])));
  const allNodeTypes = computed(() => [...new Set(Object.values(nodeTypes.value))].sort());
  const labels = computed(() => new Map(inv.unified.nodes.map((n) => [n.node_id, caseNodeLabel(n, { templates: inv.labelTemplates })])));
  const nameOf = (id: string) => labels.value.get(id) ?? id.split('@')[0];

  /** Seed edges for a node (its outgoing or incoming valued edges) or an edge. */
  function seedsFor(target: { type: 'node' | 'edge'; id: string }, direction: TraceDirection): TraceEdge[] {
    return target.type === 'edge'
      ? traceEdges.value.filter((e) => e.id === target.id)
      : traceEdges.value.filter((e) => (direction === 'forward' ? e.src : e.dst) === target.id);
  }

  function defaultWindow(seedEdgeIds: string[], direction: TraceDirection, dwellHours: number | null): [number, number] | null {
    const seedTimes = traceEdges.value.filter((e) => seedEdgeIds.includes(e.id)).map((e) => e.t);
    if (!seedTimes.length) return null;
    const span = (dwellHours || TRACE_DEFAULTS.dwellHours) * HOUR;
    return direction === 'forward'
      ? [Math.min(...seedTimes), Math.max(...seedTimes) + span]
      : [Math.min(...seedTimes) - span, Math.max(...seedTimes)];
  }

  /** README defaults from a seed; null when nothing valued leaves (or reaches) it. */
  function defaultTraceParams(target: { type: 'node' | 'edge'; id: string }, direction: TraceDirection): TraceRunParams | null {
    const seeds = seedsFor(target, direction);
    if (!seeds.length) return null;
    const seedEdgeIds = seeds.map((e) => e.id);
    return {
      seedEdgeIds,
      seedLabel:
        target.type === 'edge'
          ? `${nameOf(seeds[0].src)} → ${nameOf(seeds[0].dst)}`
          : `${direction === 'forward' ? 'outgoing' : 'incoming'} edges of ${nameOf(target.id)}`,
      direction,
      maxHops: TRACE_DEFAULTS.maxHops,
      dwellHours: TRACE_DEFAULTS.dwellHours,
      minAmount: TRACE_DEFAULTS.minAmount,
      window: defaultWindow(seedEdgeIds, direction, TRACE_DEFAULTS.dwellHours),
      allocation: ALLOCATIONS[direction][0].id,
      stopTypes: allNodeTypes.value.filter((t) => DEFAULT_STOP_TYPE.test(t)),
    };
  }

  async function guarded<T>(tool: string, fn: () => Promise<T>): Promise<T | null> {
    running.value = tool;
    error.value = null;
    try {
      return await fn();
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      running.value = null;
    }
  }

  async function runTraceAnalysis(p: TraceRunParams, itemId?: string | null): Promise<CaseItem | null> {
    return guarded('trace', async () => {
      const params: TraceParams = {
        direction: p.direction,
        maxHops: p.maxHops,
        maxDwellMs: p.dwellHours ? p.dwellHours * HOUR : null,
        minAmount: p.minAmount || 0,
        // Plain copies: a reactive proxy cannot be posted to the worker.
        window: p.window ? [p.window[0], p.window[1]] : null,
        allocation: p.allocation,
        stopTypes: [...p.stopTypes],
        stopNodes: [],
      };
      const input = { edges: traceEdges.value, nodeTypes: nodeTypes.value, seed: { edgeIds: [...p.seedEdgeIds] } };
      const [result, proportional] = await Promise.all([
        traceInWorker({ ...input, params }),
        params.allocation === 'proportional' || params.allocation === 'total'
          ? Promise.resolve(null)
          : traceInWorker({ ...input, params: { ...params, allocation: 'proportional' } }),
      ]);
      const walked = orientEdges(input.edges, params.direction).filter((e) => result.edgeTrace[e.id]);
      const label = ALLOCATIONS[p.direction].find((a) => a.id === p.allocation)?.label ?? p.allocation;
      const content: TraceContent = {
        tool: 'trace',
        result,
        walked,
        seedLabel: p.seedLabel,
        stamp: methodStamp(result.method),
        proportionalExits: proportional?.exits ?? null,
      };
      return inv.saveAnalysis({
        tool: 'trace',
        title: `Trace ${label}, ${p.maxHops} layers · ${p.seedLabel}`,
        kind: 'table',
        subkind: 'result',
        params: { ...result.method },
        content,
        itemId,
      });
    });
  }

  async function runPathsAnalysis(source: string, target: string, params: PathParams, itemId?: string | null): Promise<CaseItem | null> {
    return guarded('paths', async () => {
      const clean: PathParams = { ...params, k: Math.min(Math.max(1, params.k || 1), MAX_K) };
      const edges = graph.filteredEdges.map((e) => ({ id: e.edge_id, src: e.src, dst: e.dst, ...edgeValue(e, null) }));
      const paths = await pathsInWorker({ edges, source, target, params: clean });
      const content: PathsContent = { tool: 'paths', source, target, params: clean, paths };
      return inv.saveAnalysis({
        tool: 'paths',
        title: `Paths ${nameOf(source)} → ${nameOf(target)} · ${clean.mode}`,
        kind: 'table',
        subkind: 'result',
        params: { source, target, ...clean },
        content,
        itemId,
      });
    });
  }

  async function runTypologiesAnalysis(ids: string[], params: Record<string, TypologyParams>, itemId?: string | null): Promise<CaseItem | null> {
    return guarded('typologies', async () => {
      // shortcut: main thread; the cycle search is capped, move to a worker if big cases stall.
      const results = runTypologies(
        {
          nodes: inv.unified.nodes.map((n) => ({ id: n.node_id, type: n.node_type })),
          edges: inv.unified.edges.map((e) => ({ id: e.edge_id, src: e.src, dst: e.dst, ...edgeValue(e, null) })),
        },
        params,
        ids.length ? ids : undefined,
      );
      const content: TypologiesContent = { tool: 'typologies', params, results };
      const found = results.filter((r) => r.hits.length).length;
      return inv.saveAnalysis({
        tool: 'typologies',
        title: `Typologies · ${found} of ${results.length} found`,
        kind: 'table',
        subkind: 'result',
        params: { typologies: ids.length ? ids : TYPOLOGIES.map((t) => t.id), params },
        content,
        itemId,
      });
    });
  }

  /** Vínculos: entities sharing attributes become a `graph/derived` layer of `compartilha_<attr>` edges. */
  async function runLinksAnalysis(params: SharedLinksParams, itemId?: string | null): Promise<CaseItem | null> {
    return guarded('links', async () => {
      const nodes = inv.unified.nodes.map((n) => ({ uid: n.node_id, type: n.node_type, properties: n.properties }));
      const { edges, pairs } = sharedAttributeLinks({ nodes, edges: inv.unified.edges }, params);
      const touched = new Set(edges.flatMap((e) => [e.src, e.dst]));
      const content: LinksContent = {
        tool: 'links',
        unified: true,
        params,
        nodes: inv.unified.nodes.filter((n) => touched.has(n.node_id)).map((n) => ({ id: n.node_id, type: n.node_type, properties: {} })),
        edges: edges.map((e) => ({ id: e.id, source: e.src, target: e.dst, type: e.type, properties: e.properties })),
        pairs,
      };
      return inv.saveAnalysis({
        tool: 'links',
        title: `Vínculos por ${params.attributes.join(' + ')} · ${pairs.length} ${pairs.length === 1 ? 'par' : 'pares'}`,
        kind: 'graph',
        subkind: 'derived',
        params: { ...params },
        content,
        itemId,
        description: `${edges.length} compartilha_* edges between ${touched.size} entities`,
      });
    });
  }

  /** The computed node metrics as a `table/metrics` item (one row per node). */
  async function saveMetricsTable(): Promise<CaseItem | null> {
    return guarded('metrics', async () => {
      const metrics = useMetricsStore();
      const list = metrics.nodeMetrics;
      if (!list.length) throw new Error('No metric computed yet: run one in the Metrics panel first');
      const columns = ['node_id', 'label', 'node_type', ...list.map((m) => m.name)];
      const rows = inv.unified.nodes.map((n) => ({
        node_id: n.node_id,
        label: nameOf(n.node_id),
        node_type: n.node_type,
        ...Object.fromEntries(list.map((m) => [m.name, m.values.get(n.node_id) ?? null])),
      }));
      const content: MetricsContent = { tool: 'metrics', columns, rows };
      return inv.saveAnalysis({
        tool: 'metrics',
        title: `Metrics · ${list.map((m) => m.name).join(', ')}`,
        kind: 'table',
        subkind: 'metrics',
        params: { metrics: list.map((m) => ({ name: m.name, algorithm: m.algorithmId, params: m.params })) },
        content,
      });
    });
  }

  return {
    running,
    error,
    traceEdges,
    allNodeTypes,
    nameOf,
    seedsFor,
    defaultWindow,
    defaultTraceParams,
    runTrace: runTraceAnalysis,
    runPaths: runPathsAnalysis,
    runTypologies: runTypologiesAnalysis,
    runLinks: runLinksAnalysis,
    saveMetricsTable,
  };
}
