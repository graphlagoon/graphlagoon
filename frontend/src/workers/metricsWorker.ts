/**
 * Metrics Worker
 *
 * Web Worker for computing graph metrics in the background.
 * Supports pause/resume, progress reporting, and partial results.
 */

import Graph from 'graphology';
import type {
  WorkerCommand,
  WorkerMessage,
  ComputationRequest,
  SerializedGraph,
  Priority,
  AlgorithmTarget,
} from '@/types/metrics';
import { getBatchSize, getBatchDelay, calculateStats } from '@/types/metrics';

// ============================================================================
// Worker State
// ============================================================================

interface TaskState {
  id: string;
  paused: boolean;
  cancelled: boolean;
  priority: Priority;
}

const activeTasks = new Map<string, TaskState>();

// ============================================================================
// Message Handler
// ============================================================================

self.onmessage = async (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;

  switch (command.type) {
    case 'START':
      await runComputation(command.payload);
      break;

    case 'PAUSE': {
      const task = activeTasks.get(command.payload.id);
      if (task) task.paused = true;
      break;
    }

    case 'RESUME': {
      const task = activeTasks.get(command.payload.id);
      if (task) task.paused = false;
      break;
    }

    case 'CANCEL': {
      const task = activeTasks.get(command.payload.id);
      if (task) task.cancelled = true;
      break;
    }

    case 'SET_PRIORITY': {
      const task = activeTasks.get(command.payload.id);
      if (task) task.priority = command.payload.priority;
      break;
    }
  }
};

// Signal that worker is ready
postMessage({ type: 'READY' } as WorkerMessage);

// ============================================================================
// Computation Runner
// ============================================================================

async function runComputation(
  payload: ComputationRequest & { graph: SerializedGraph }
): Promise<void> {
  const { id, algorithmId, outputName, params, edgeTypeFilter, priority, enableRealTimeUpdates, graph } =
    payload;

  // Initialize task state
  const taskState: TaskState = {
    id,
    paused: false,
    cancelled: false,
    priority,
  };
  activeTasks.set(id, taskState);

  const startTime = performance.now();

  try {
    // Build graphology graph from serialized data
    const g = buildGraph(graph, edgeTypeFilter);

    // Report initial progress
    sendProgress(id, 'running', 0);

    // Run the appropriate algorithm
    let values: Map<string, number>;
    let target: AlgorithmTarget;

    switch (algorithmId) {
      case 'degree':
        values = await computeDegree(g, params, taskState, enableRealTimeUpdates);
        target = 'node';
        break;

      case 'weighted-degree':
        values = await computeWeightedDegree(g, params, taskState, enableRealTimeUpdates);
        target = 'node';
        break;

      case 'pagerank':
        values = await computePageRank(g, params, taskState, enableRealTimeUpdates);
        target = 'node';
        break;

      case 'eigenvector':
        values = await computeEigenvector(g, params, taskState, enableRealTimeUpdates);
        target = 'node';
        break;

      case 'betweenness':
        values = await computeBetweenness(g, params, taskState, enableRealTimeUpdates);
        target = 'node';
        break;

      case 'closeness':
        values = await computeCloseness(g, params, taskState, enableRealTimeUpdates);
        target = 'node';
        break;

      case 'hits-authority':
        values = await computeHITS(g, params, taskState, enableRealTimeUpdates, 'authority');
        target = 'node';
        break;

      case 'hits-hub':
        values = await computeHITS(g, params, taskState, enableRealTimeUpdates, 'hub');
        target = 'node';
        break;

      case 'edge-betweenness':
        values = await computeEdgeBetweenness(g, params, taskState, enableRealTimeUpdates);
        target = 'edge';
        break;

      default:
        throw new Error(`Unknown algorithm: ${algorithmId}`);
    }

    // Check if cancelled
    if (taskState.cancelled) {
      return;
    }

    // Calculate statistics
    const valuesArray = Array.from(values.values());
    const stats = calculateStats(valuesArray);
    const elapsedMs = performance.now() - startTime;

    // Send completion
    const result: WorkerMessage = {
      type: 'COMPLETE',
      payload: {
        id,
        name: outputName,
        algorithmId,
        target,
        values: Array.from(values.entries()),
        min: stats.min,
        max: stats.max,
        mean: stats.mean,
        stdDev: stats.stdDev,
        computedAt: Date.now(),
        params,
        edgeTypeFilter,
        elapsedMs,
      },
    };

    postMessage(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postMessage({
      type: 'ERROR',
      payload: { id, error: message },
    } as WorkerMessage);
  } finally {
    activeTasks.delete(id);
  }
}

// ============================================================================
// Graph Building
// ============================================================================

function buildGraph(serialized: SerializedGraph, edgeTypeFilter: string[]): Graph {
  const g = new Graph({ type: 'directed', allowSelfLoops: true, multi: true });

  // Add nodes
  for (const node of serialized.nodes) {
    g.addNode(node.id, node.attributes);
  }

  // Add edges (with optional type filtering)
  // Use addEdgeWithKey to preserve original edge IDs for metric lookup
  for (const edge of serialized.edges) {
    // Skip if edge type is filtered out
    if (edgeTypeFilter.length > 0) {
      const edgeType = edge.attributes.relationship_type as string;
      if (!edgeTypeFilter.includes(edgeType)) {
        continue;
      }
    }

    g.addEdgeWithKey(edge.id, edge.source, edge.target, edge.attributes);
  }

  return g;
}

// ============================================================================
// Helper Functions
// ============================================================================

function sendProgress(
  id: string,
  status: 'running' | 'paused',
  progress: number,
  extra?: {
    currentIteration?: number;
    maxIterations?: number;
    processedNodes?: number;
    totalNodes?: number;
    message?: string;
  }
): void {
  postMessage({
    type: 'PROGRESS',
    payload: {
      id,
      status,
      progress,
      ...extra,
    },
  } as WorkerMessage);
}

function sendPartialResult(id: string, results: [string, number][]): void {
  postMessage({
    type: 'PARTIAL_RESULT',
    payload: { id, results },
  } as WorkerMessage);
}

async function waitWhilePaused(taskState: TaskState): Promise<boolean> {
  while (taskState.paused && !taskState.cancelled) {
    await sleep(100);
  }
  return !taskState.cancelled;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Algorithm Implementations
// ============================================================================

/**
 * Degree Centrality
 */
async function computeDegree(
  g: Graph,
  params: Record<string, unknown>,
  taskState: TaskState,
  enableRealTimeUpdates: boolean
): Promise<Map<string, number>> {
  const direction = (params.direction as string) || 'all';
  const values = new Map<string, number>();
  const nodes = g.nodes();
  const batchSize = getBatchSize(taskState.priority);
  const batchDelay = getBatchDelay(taskState.priority);

  for (let i = 0; i < nodes.length; i++) {
    if (taskState.cancelled) return values;
    if (!(await waitWhilePaused(taskState))) return values;

    const node = nodes[i];
    let degree: number;

    switch (direction) {
      case 'in':
        degree = g.inDegree(node);
        break;
      case 'out':
        degree = g.outDegree(node);
        break;
      default:
        degree = g.degree(node);
    }

    values.set(node, degree);

    // Report progress and yield
    if ((i + 1) % batchSize === 0) {
      const progress = ((i + 1) / nodes.length) * 100;
      sendProgress(taskState.id, 'running', progress, {
        processedNodes: i + 1,
        totalNodes: nodes.length,
      });

      if (enableRealTimeUpdates) {
        const batch = Array.from(values.entries()).slice(-batchSize);
        sendPartialResult(taskState.id, batch);
      }

      if (batchDelay > 0) await sleep(batchDelay);
    }
  }

  return values;
}

/**
 * Weighted Degree
 */
async function computeWeightedDegree(
  g: Graph,
  params: Record<string, unknown>,
  taskState: TaskState,
  enableRealTimeUpdates: boolean
): Promise<Map<string, number>> {
  const direction = (params.direction as string) || 'all';
  const weightAttr = params.weightAttribute as string | null;
  const values = new Map<string, number>();
  const nodes = g.nodes();
  const batchSize = getBatchSize(taskState.priority);
  const batchDelay = getBatchDelay(taskState.priority);

  for (let i = 0; i < nodes.length; i++) {
    if (taskState.cancelled) return values;
    if (!(await waitWhilePaused(taskState))) return values;

    const node = nodes[i];
    let weightedDegree = 0;

    const processEdge = (edge: string) => {
      if (weightAttr) {
        const weight = g.getEdgeAttribute(edge, weightAttr);
        weightedDegree += typeof weight === 'number' ? weight : 1;
      } else {
        weightedDegree += 1;
      }
    };

    if (direction === 'in' || direction === 'all') {
      g.inEdges(node).forEach(processEdge);
    }
    if (direction === 'out' || direction === 'all') {
      g.outEdges(node).forEach(processEdge);
    }

    values.set(node, weightedDegree);

    if ((i + 1) % batchSize === 0) {
      const progress = ((i + 1) / nodes.length) * 100;
      sendProgress(taskState.id, 'running', progress, {
        processedNodes: i + 1,
        totalNodes: nodes.length,
      });

      if (enableRealTimeUpdates) {
        const batch = Array.from(values.entries()).slice(-batchSize);
        sendPartialResult(taskState.id, batch);
      }

      if (batchDelay > 0) await sleep(batchDelay);
    }
  }

  return values;
}

/**
 * PageRank
 */
async function computePageRank(
  g: Graph,
  params: Record<string, unknown>,
  taskState: TaskState,
  enableRealTimeUpdates: boolean
): Promise<Map<string, number>> {
  const alpha = (params.alpha as number) || 0.85;
  const maxIterations = (params.maxIterations as number) || 100;
  const tolerance = (params.tolerance as number) || 1e-6;

  const nodes = g.nodes();
  const n = nodes.length;
  if (n === 0) return new Map();

  // Initialize ranks
  const initialRank = 1 / n;
  let ranks = new Map<string, number>();
  let newRanks = new Map<string, number>();

  for (const node of nodes) {
    ranks.set(node, initialRank);
  }

  const batchDelay = getBatchDelay(taskState.priority);

  for (let iter = 0; iter < maxIterations; iter++) {
    if (taskState.cancelled) return ranks;
    if (!(await waitWhilePaused(taskState))) return ranks;

    // Calculate dangling node contribution
    let danglingSum = 0;
    for (const node of nodes) {
      if (g.outDegree(node) === 0) {
        danglingSum += ranks.get(node)!;
      }
    }
    const danglingContribution = (alpha * danglingSum) / n;

    // Calculate new ranks
    let maxDiff = 0;

    for (const node of nodes) {
      let incomingSum = 0;

      g.inNeighbors(node).forEach((neighbor) => {
        const neighborRank = ranks.get(neighbor)!;
        const neighborOutDegree = g.outDegree(neighbor);
        incomingSum += neighborRank / neighborOutDegree;
      });

      const newRank = (1 - alpha) / n + alpha * incomingSum + danglingContribution;
      newRanks.set(node, newRank);

      const diff = Math.abs(newRank - ranks.get(node)!);
      maxDiff = Math.max(maxDiff, diff);
    }

    // Swap ranks
    [ranks, newRanks] = [newRanks, ranks];

    // Check convergence
    const progress = ((iter + 1) / maxIterations) * 100;
    sendProgress(taskState.id, 'running', progress, {
      currentIteration: iter + 1,
      maxIterations,
      message: `Convergence: ${maxDiff.toExponential(2)}`,
    });

    if (enableRealTimeUpdates && iter % 10 === 0) {
      sendPartialResult(taskState.id, Array.from(ranks.entries()));
    }

    if (maxDiff < tolerance) {
      sendProgress(taskState.id, 'running', 100, {
        currentIteration: iter + 1,
        maxIterations,
        message: `Converged at iteration ${iter + 1}`,
      });
      break;
    }

    if (batchDelay > 0) await sleep(batchDelay);
  }

  return ranks;
}

/**
 * Eigenvector Centrality
 */
async function computeEigenvector(
  g: Graph,
  params: Record<string, unknown>,
  taskState: TaskState,
  enableRealTimeUpdates: boolean
): Promise<Map<string, number>> {
  const maxIterations = (params.maxIterations as number) || 100;
  const tolerance = (params.tolerance as number) || 1e-6;

  const nodes = g.nodes();
  const n = nodes.length;
  if (n === 0) return new Map();

  // Initialize scores
  let scores = new Map<string, number>();
  for (const node of nodes) {
    scores.set(node, 1 / n);
  }

  const batchDelay = getBatchDelay(taskState.priority);

  for (let iter = 0; iter < maxIterations; iter++) {
    if (taskState.cancelled) return scores;
    if (!(await waitWhilePaused(taskState))) return scores;

    const newScores = new Map<string, number>();
    let norm = 0;

    // Compute new scores
    for (const node of nodes) {
      let score = 0;
      g.neighbors(node).forEach((neighbor) => {
        score += scores.get(neighbor)!;
      });
      newScores.set(node, score);
      norm += score * score;
    }

    // Normalize
    norm = Math.sqrt(norm);
    if (norm === 0) norm = 1;

    let maxDiff = 0;
    for (const node of nodes) {
      const normalized = newScores.get(node)! / norm;
      const diff = Math.abs(normalized - scores.get(node)!);
      maxDiff = Math.max(maxDiff, diff);
      scores.set(node, normalized);
    }

    const progress = ((iter + 1) / maxIterations) * 100;
    sendProgress(taskState.id, 'running', progress, {
      currentIteration: iter + 1,
      maxIterations,
      message: `Convergence: ${maxDiff.toExponential(2)}`,
    });

    if (enableRealTimeUpdates && iter % 10 === 0) {
      sendPartialResult(taskState.id, Array.from(scores.entries()));
    }

    if (maxDiff < tolerance) {
      break;
    }

    if (batchDelay > 0) await sleep(batchDelay);
  }

  return scores;
}

/**
 * Betweenness Centrality (Brandes' algorithm)
 */
async function computeBetweenness(
  g: Graph,
  params: Record<string, unknown>,
  taskState: TaskState,
  enableRealTimeUpdates: boolean
): Promise<Map<string, number>> {
  const normalized = (params.normalized as boolean) ?? true;

  const nodes = g.nodes();
  const n = nodes.length;
  if (n < 2) {
    const result = new Map<string, number>();
    for (const node of nodes) result.set(node, 0);
    return result;
  }

  const betweenness = new Map<string, number>();
  for (const node of nodes) {
    betweenness.set(node, 0);
  }

  const batchSize = getBatchSize(taskState.priority);
  const batchDelay = getBatchDelay(taskState.priority);

  for (let i = 0; i < nodes.length; i++) {
    if (taskState.cancelled) return betweenness;
    if (!(await waitWhilePaused(taskState))) return betweenness;

    const s = nodes[i];

    // Single-source shortest paths
    const stack: string[] = [];
    const pred = new Map<string, string[]>();
    const sigma = new Map<string, number>();
    const dist = new Map<string, number>();
    const delta = new Map<string, number>();

    for (const node of nodes) {
      pred.set(node, []);
      sigma.set(node, 0);
      dist.set(node, -1);
      delta.set(node, 0);
    }

    sigma.set(s, 1);
    dist.set(s, 0);

    const queue: string[] = [s];

    // BFS
    while (queue.length > 0) {
      const v = queue.shift()!;
      stack.push(v);

      const vDist = dist.get(v)!;
      const vSigma = sigma.get(v)!;

      g.outNeighbors(v).forEach((w) => {
        // w found for first time?
        if (dist.get(w)! < 0) {
          queue.push(w);
          dist.set(w, vDist + 1);
        }
        // Shortest path to w via v?
        if (dist.get(w) === vDist + 1) {
          sigma.set(w, sigma.get(w)! + vSigma);
          pred.get(w)!.push(v);
        }
      });
    }

    // Accumulate dependencies
    while (stack.length > 0) {
      const w = stack.pop()!;
      const wSigma = sigma.get(w)!;
      const wDelta = delta.get(w)!;

      for (const v of pred.get(w)!) {
        const vSigma = sigma.get(v)!;
        const c = (vSigma / wSigma) * (1 + wDelta);
        delta.set(v, delta.get(v)! + c);
      }

      if (w !== s) {
        betweenness.set(w, betweenness.get(w)! + delta.get(w)!);
      }
    }

    // Report progress
    if ((i + 1) % batchSize === 0 || i === nodes.length - 1) {
      const progress = ((i + 1) / nodes.length) * 100;
      sendProgress(taskState.id, 'running', progress, {
        processedNodes: i + 1,
        totalNodes: nodes.length,
      });

      if (enableRealTimeUpdates) {
        sendPartialResult(taskState.id, Array.from(betweenness.entries()));
      }

      if (batchDelay > 0) await sleep(batchDelay);
    }
  }

  // Normalize
  if (normalized && n > 2) {
    const scale = 1 / ((n - 1) * (n - 2));
    for (const node of nodes) {
      betweenness.set(node, betweenness.get(node)! * scale);
    }
  }

  return betweenness;
}

/**
 * Closeness Centrality
 */
async function computeCloseness(
  g: Graph,
  params: Record<string, unknown>,
  taskState: TaskState,
  enableRealTimeUpdates: boolean
): Promise<Map<string, number>> {
  const wassermanFaust = (params.wassermanFaust as boolean) ?? true;

  const nodes = g.nodes();
  const n = nodes.length;
  if (n === 0) return new Map();

  const closeness = new Map<string, number>();
  const batchSize = getBatchSize(taskState.priority);
  const batchDelay = getBatchDelay(taskState.priority);

  for (let i = 0; i < nodes.length; i++) {
    if (taskState.cancelled) return closeness;
    if (!(await waitWhilePaused(taskState))) return closeness;

    const s = nodes[i];

    // BFS for shortest paths
    const dist = new Map<string, number>();
    dist.set(s, 0);
    const queue: string[] = [s];

    let totalDist = 0;
    let reachable = 0;

    while (queue.length > 0) {
      const v = queue.shift()!;
      const vDist = dist.get(v)!;

      g.outNeighbors(v).forEach((w) => {
        if (!dist.has(w)) {
          const wDist = vDist + 1;
          dist.set(w, wDist);
          queue.push(w);
          totalDist += wDist;
          reachable++;
        }
      });
    }

    let value = 0;
    if (reachable > 0 && totalDist > 0) {
      if (wassermanFaust) {
        // Wasserman-Faust normalization for disconnected graphs
        value = (reachable / (n - 1)) * (reachable / totalDist);
      } else {
        value = reachable / totalDist;
      }
    }

    closeness.set(s, value);

    if ((i + 1) % batchSize === 0 || i === nodes.length - 1) {
      const progress = ((i + 1) / nodes.length) * 100;
      sendProgress(taskState.id, 'running', progress, {
        processedNodes: i + 1,
        totalNodes: nodes.length,
      });

      if (enableRealTimeUpdates) {
        sendPartialResult(taskState.id, Array.from(closeness.entries()));
      }

      if (batchDelay > 0) await sleep(batchDelay);
    }
  }

  return closeness;
}

/**
 * HITS (Hyperlink-Induced Topic Search)
 */
async function computeHITS(
  g: Graph,
  params: Record<string, unknown>,
  taskState: TaskState,
  enableRealTimeUpdates: boolean,
  mode: 'authority' | 'hub'
): Promise<Map<string, number>> {
  const maxIterations = (params.maxIterations as number) || 100;
  const tolerance = (params.tolerance as number) || 1e-8;

  const nodes = g.nodes();
  const n = nodes.length;
  if (n === 0) return new Map();

  // Initialize
  let authority = new Map<string, number>();
  let hub = new Map<string, number>();

  for (const node of nodes) {
    authority.set(node, 1);
    hub.set(node, 1);
  }

  const batchDelay = getBatchDelay(taskState.priority);

  for (let iter = 0; iter < maxIterations; iter++) {
    if (taskState.cancelled) return mode === 'authority' ? authority : hub;
    if (!(await waitWhilePaused(taskState))) return mode === 'authority' ? authority : hub;

    const newAuthority = new Map<string, number>();
    const newHub = new Map<string, number>();

    // Update authority scores
    let authNorm = 0;
    for (const node of nodes) {
      let score = 0;
      g.inNeighbors(node).forEach((neighbor) => {
        score += hub.get(neighbor)!;
      });
      newAuthority.set(node, score);
      authNorm += score * score;
    }
    authNorm = Math.sqrt(authNorm) || 1;

    // Update hub scores
    let hubNorm = 0;
    for (const node of nodes) {
      let score = 0;
      g.outNeighbors(node).forEach((neighbor) => {
        score += newAuthority.get(neighbor)!;
      });
      newHub.set(node, score);
      hubNorm += score * score;
    }
    hubNorm = Math.sqrt(hubNorm) || 1;

    // Normalize and check convergence
    let maxDiff = 0;
    for (const node of nodes) {
      const normAuth = newAuthority.get(node)! / authNorm;
      const normHub = newHub.get(node)! / hubNorm;

      maxDiff = Math.max(maxDiff, Math.abs(normAuth - authority.get(node)!));
      maxDiff = Math.max(maxDiff, Math.abs(normHub - hub.get(node)!));

      authority.set(node, normAuth);
      hub.set(node, normHub);
    }

    const progress = ((iter + 1) / maxIterations) * 100;
    sendProgress(taskState.id, 'running', progress, {
      currentIteration: iter + 1,
      maxIterations,
      message: `Convergence: ${maxDiff.toExponential(2)}`,
    });

    if (enableRealTimeUpdates && iter % 10 === 0) {
      const result = mode === 'authority' ? authority : hub;
      sendPartialResult(taskState.id, Array.from(result.entries()));
    }

    if (maxDiff < tolerance) {
      break;
    }

    if (batchDelay > 0) await sleep(batchDelay);
  }

  return mode === 'authority' ? authority : hub;
}

/**
 * Edge Betweenness Centrality
 */
async function computeEdgeBetweenness(
  g: Graph,
  params: Record<string, unknown>,
  taskState: TaskState,
  enableRealTimeUpdates: boolean
): Promise<Map<string, number>> {
  const normalized = (params.normalized as boolean) ?? true;

  const nodes = g.nodes();
  const edges = g.edges();
  const n = nodes.length;

  if (n < 2) {
    const result = new Map<string, number>();
    for (const edge of edges) result.set(edge, 0);
    return result;
  }

  const betweenness = new Map<string, number>();
  for (const edge of edges) {
    betweenness.set(edge, 0);
  }

  const batchSize = getBatchSize(taskState.priority);
  const batchDelay = getBatchDelay(taskState.priority);

  for (let i = 0; i < nodes.length; i++) {
    if (taskState.cancelled) return betweenness;
    if (!(await waitWhilePaused(taskState))) return betweenness;

    const s = nodes[i];

    // BFS
    const stack: string[] = [];
    const pred = new Map<string, { node: string; edge: string }[]>();
    const sigma = new Map<string, number>();
    const dist = new Map<string, number>();
    const delta = new Map<string, number>();

    for (const node of nodes) {
      pred.set(node, []);
      sigma.set(node, 0);
      dist.set(node, -1);
      delta.set(node, 0);
    }

    sigma.set(s, 1);
    dist.set(s, 0);

    const queue: string[] = [s];

    while (queue.length > 0) {
      const v = queue.shift()!;
      stack.push(v);

      const vDist = dist.get(v)!;
      const vSigma = sigma.get(v)!;

      g.outEdges(v).forEach((edge) => {
        const w = g.target(edge);

        if (dist.get(w)! < 0) {
          queue.push(w);
          dist.set(w, vDist + 1);
        }

        if (dist.get(w) === vDist + 1) {
          sigma.set(w, sigma.get(w)! + vSigma);
          pred.get(w)!.push({ node: v, edge });
        }
      });
    }

    // Accumulate
    while (stack.length > 0) {
      const w = stack.pop()!;
      const wSigma = sigma.get(w)!;
      const wDelta = delta.get(w)!;

      for (const { node: v, edge } of pred.get(w)!) {
        const vSigma = sigma.get(v)!;
        const c = (vSigma / wSigma) * (1 + wDelta);
        delta.set(v, delta.get(v)! + c);
        betweenness.set(edge, betweenness.get(edge)! + c);
      }
    }

    if ((i + 1) % batchSize === 0 || i === nodes.length - 1) {
      const progress = ((i + 1) / nodes.length) * 100;
      sendProgress(taskState.id, 'running', progress, {
        processedNodes: i + 1,
        totalNodes: nodes.length,
      });

      if (enableRealTimeUpdates) {
        sendPartialResult(taskState.id, Array.from(betweenness.entries()));
      }

      if (batchDelay > 0) await sleep(batchDelay);
    }
  }

  // Normalize
  if (normalized && n > 1) {
    const scale = 1 / (n * (n - 1));
    for (const edge of edges) {
      betweenness.set(edge, betweenness.get(edge)! * scale);
    }
  }

  return betweenness;
}
