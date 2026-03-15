/**
 * Metrics Calculator Service
 *
 * Coordinates between the metrics store, worker pool, and graph store.
 * Provides a high-level API for computing graph metrics.
 */

import { getWorkerPool, resetWorkerPool } from './workerPool';
import { getAlgorithm, getDefaultParams } from './algorithmRegistry';
import { useMetricsStore } from '@/stores/metrics';
import { useGraphStore } from '@/stores/graph';
import type {
  ComputationRequest,
  ComputedMetric,
  SerializedGraph,
  Priority,
  ComputationProgress,
} from '@/types/metrics';

// ============================================================================
// Types
// ============================================================================

export interface ComputeMetricOptions {
  algorithmId: string;
  outputName?: string;
  params?: Record<string, unknown>;
  edgeTypeFilter?: string[];
  priority?: Priority;
  enableRealTimeUpdates?: boolean;
}

// ============================================================================
// Service Class
// ============================================================================

class MetricsCalculatorService {
  private initialized = false;

  /**
   * Initialize the calculator service
   */
  initialize(): void {
    if (this.initialized) return;

    const metricsStore = useMetricsStore();
    const pool = getWorkerPool(
      metricsStore.workerPoolConfig.maxWorkers,
      metricsStore.workerPoolConfig.maxMemoryMB
    );

    // Set up progress callback
    pool.setProgressCallback((progress: ComputationProgress) => {
      metricsStore.updateComputationProgress(progress.id, {
        status: progress.status === 'paused' ? 'paused' : 'running',
        progress: progress.progress,
        currentIteration: progress.currentIteration,
        maxIterations: progress.maxIterations,
        elapsedMs: Date.now() - (metricsStore.activeComputations.get(progress.id)?.startedAt || Date.now()),
      });
    });

    // Set up partial result callback
    pool.setPartialResultCallback((_id: string, _results: [string, number][]) => {
      // For real-time updates, we could update the visualization here
      // For now, we just let the computation complete
      // The store can be extended to handle partial results if needed
    });

    this.initialized = true;
  }

  /**
   * Compute a metric on the current graph
   */
  async computeMetric(options: ComputeMetricOptions): Promise<ComputedMetric> {
    this.initialize();

    const {
      algorithmId,
      outputName,
      params = {},
      edgeTypeFilter = [],
      priority = 'medium',
      enableRealTimeUpdates = true,
    } = options;

    // Get algorithm definition
    const algorithm = getAlgorithm(algorithmId);
    if (!algorithm) {
      throw new Error(`Unknown algorithm: ${algorithmId}`);
    }

    // Merge with default params - ensure plain objects (no Vue reactivity)
    const defaultParams = getDefaultParams(algorithmId);
    const finalParams = JSON.parse(JSON.stringify({ ...defaultParams, ...params }));

    // Generate unique ID and name
    const id = crypto.randomUUID();
    const name = outputName || `${algorithm.name} (${new Date().toLocaleTimeString()})`;

    // Create request - use plain array for edgeTypeFilter
    const request: ComputationRequest = {
      id,
      algorithmId,
      outputName: name,
      params: finalParams,
      edgeTypeFilter: [...edgeTypeFilter], // Convert to plain array
      priority,
      enableRealTimeUpdates,
    };

    // Get current graph data
    const graph = this.serializeCurrentGraph();

    // Register computation in store
    const metricsStore = useMetricsStore();
    metricsStore.registerComputation({
      id,
      name,
      algorithmId,
      status: 'queued',
      progress: 0,
      startedAt: Date.now(),
      elapsedMs: 0,
      priority,
      queuePosition: metricsStore.queuedCount,
    });

    try {
      // Submit to worker pool
      const pool = getWorkerPool();
      const result = await pool.submit(request, graph);

      // Store result
      metricsStore.completeComputation(result);

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      metricsStore.failComputation(id, message);
      throw error;
    }
  }

  /**
   * Compute multiple metrics in parallel
   */
  async computeMetrics(optionsList: ComputeMetricOptions[]): Promise<ComputedMetric[]> {
    const promises = optionsList.map((options) => this.computeMetric(options));
    return Promise.all(promises);
  }

  /**
   * Pause a running computation
   */
  pauseComputation(id: string): void {
    const pool = getWorkerPool();
    pool.pause(id);

    const metricsStore = useMetricsStore();
    metricsStore.pauseComputation(id);
  }

  /**
   * Resume a paused computation
   */
  resumeComputation(id: string): void {
    const pool = getWorkerPool();
    pool.resume(id);

    const metricsStore = useMetricsStore();
    metricsStore.resumeComputation(id);
  }

  /**
   * Cancel a computation
   */
  cancelComputation(id: string): void {
    const pool = getWorkerPool();
    pool.cancel(id);

    const metricsStore = useMetricsStore();
    metricsStore.cancelComputation(id);
  }

  /**
   * Change computation priority
   */
  setComputationPriority(id: string, priority: Priority): void {
    const pool = getWorkerPool();
    pool.setPriority(id, priority);

    const metricsStore = useMetricsStore();
    metricsStore.setComputationPriority(id, priority);
  }

  /**
   * Update worker pool configuration
   */
  updateWorkerPoolConfig(maxWorkers?: number, maxMemoryMB?: number): void {
    const pool = getWorkerPool();
    const metricsStore = useMetricsStore();

    if (maxWorkers !== undefined) {
      pool.setMaxWorkers(maxWorkers);
      metricsStore.updateWorkerPoolConfig({ maxWorkers });
    }

    if (maxMemoryMB !== undefined) {
      pool.setMaxMemory(maxMemoryMB);
      metricsStore.updateWorkerPoolConfig({ maxMemoryMB });
    }
  }

  /**
   * Get current resource metrics
   */
  refreshResourceMetrics(): void {
    const pool = getWorkerPool();
    const status = pool.getStatus();

    const metricsStore = useMetricsStore();
    metricsStore.setResourceMetrics({
      activeWorkers: status.activeWorkers,
      maxWorkers: status.maxWorkers,
      queuedTasks: status.queuedTasks,
      memory: status.memory,
    });
  }

  /**
   * Serialize the current filtered graph for worker processing
   * Uses JSON.parse/stringify to ensure plain objects (no Vue reactivity)
   */
  private serializeCurrentGraph(): SerializedGraph {
    const graphStore = useGraphStore();

    const nodes = graphStore.filteredNodes.map((node) => ({
      id: node.node_id,
      attributes: {
        node_type: node.node_type,
      },
    }));

    const edges = graphStore.filteredEdges.map((edge) => ({
      id: edge.edge_id,
      source: edge.src,
      target: edge.dst,
      attributes: {
        relationship_type: edge.relationship_type,
      },
    }));

    return { nodes, edges };
  }

  /**
   * Cleanup and terminate workers
   */
  cleanup(): void {
    resetWorkerPool();
    this.initialized = false;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let instance: MetricsCalculatorService | null = null;

export function getMetricsCalculator(): MetricsCalculatorService {
  if (!instance) {
    instance = new MetricsCalculatorService();
  }
  return instance;
}

export function resetMetricsCalculator(): void {
  if (instance) {
    instance.cleanup();
    instance = null;
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Quick compute a metric with default settings
 */
export async function computeMetric(
  algorithmId: string,
  options?: Partial<ComputeMetricOptions>
): Promise<ComputedMetric> {
  return getMetricsCalculator().computeMetric({
    algorithmId,
    ...options,
  });
}

/**
 * Compute degree centrality
 */
export async function computeDegree(
  direction: 'all' | 'in' | 'out' = 'all',
  edgeTypeFilter?: string[]
): Promise<ComputedMetric> {
  return computeMetric('degree', {
    params: { direction },
    edgeTypeFilter,
  });
}

/**
 * Compute PageRank
 */
export async function computePageRank(
  alpha: number = 0.85,
  edgeTypeFilter?: string[]
): Promise<ComputedMetric> {
  return computeMetric('pagerank', {
    params: { alpha },
    edgeTypeFilter,
  });
}

/**
 * Compute betweenness centrality
 */
export async function computeBetweenness(
  normalized: boolean = true,
  edgeTypeFilter?: string[]
): Promise<ComputedMetric> {
  return computeMetric('betweenness', {
    params: { normalized },
    edgeTypeFilter,
  });
}
