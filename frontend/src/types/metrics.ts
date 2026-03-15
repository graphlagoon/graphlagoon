/**
 * Graph Metrics Types
 *
 * Type definitions for the graph metrics calculation feature.
 * Supports computing centrality metrics, visual mapping, and resource monitoring.
 */

// ============================================================================
// Algorithm Definitions
// ============================================================================

export type AlgorithmCategory = 'centrality' | 'edge' | 'graph';
export type AlgorithmTarget = 'node' | 'edge' | 'graph';
export type ScaleType = 'linear' | 'log' | 'sqrt';
export type Priority = 'low' | 'medium' | 'high';
export type ComputationStatus = 'pending' | 'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'error';

export interface ParamSchema {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'select' | 'edge-types';
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  description?: string;
}

export interface AlgorithmDefinition {
  id: string;
  name: string;
  category: AlgorithmCategory;
  description: string;
  target: AlgorithmTarget;
  isIterative: boolean;
  defaultParams: Record<string, unknown>;
  paramSchema: ParamSchema[];
  /** Algorithms that need per-component execution for disconnected graphs */
  requiresConnectedGraph: boolean;
  /** Estimated complexity for progress calculation */
  complexity: 'O(N)' | 'O(E)' | 'O(N*E)' | 'O(E*iter)';
}

// ============================================================================
// Computation Request & Progress
// ============================================================================

export interface ComputationRequest {
  id: string;
  algorithmId: string;
  outputName: string;
  params: Record<string, unknown>;
  edgeTypeFilter: string[];  // Empty = all types
  priority: Priority;
  enableRealTimeUpdates: boolean;
}

export interface ComputationProgress {
  id: string;
  status: ComputationStatus;
  progress: number;  // 0-100
  currentIteration?: number;
  maxIterations?: number;
  processedNodes?: number;
  totalNodes?: number;
  message?: string;
}

export interface ComputationMetrics {
  id: string;
  name: string;
  algorithmId: string;
  status: ComputationStatus;
  progress: number;
  currentIteration?: number;
  maxIterations?: number;
  startedAt: number;  // timestamp
  elapsedMs: number;
  estimatedRemainingMs?: number;
  speed?: number;  // iterations/s or nodes/s
  speedUnit?: string;  // 'iter/s' or 'nodes/s'
  estimatedMemoryMB?: number;
  priority: Priority;
  queuePosition?: number;
}

// ============================================================================
// Computed Metric Result
// ============================================================================

export interface ComputedMetric {
  id: string;
  name: string;
  algorithmId: string;
  target: AlgorithmTarget;
  values: Map<string, number>;  // nodeId/edgeId -> computed value
  min: number;
  max: number;
  mean: number;
  stdDev: number;
  computedAt: number;  // timestamp
  params: Record<string, unknown>;
  edgeTypeFilter: string[];
  elapsedMs: number;
}

// ============================================================================
// Visual Mapping
// ============================================================================

export interface SizeMapping {
  metricId: string | null;
  minSize: number;
  maxSize: number;
  scale: ScaleType;
}

export interface WeightMapping {
  metricId: string | null;
  minWeight: number;
  maxWeight: number;
  scale: ScaleType;
}

export interface VisualMapping {
  nodeSize: SizeMapping;
  edgeWeight: WeightMapping;
  enableRealTimeUpdates: boolean;
}

// ============================================================================
// Graph Info
// ============================================================================

export interface GraphInfo {
  nodeCount: number;
  edgeCount: number;
  componentCount: number;
  density: number;
  isConnected: boolean;
  edgeTypeCounts: Map<string, number>;
}

// ============================================================================
// Resource Monitoring
// ============================================================================

export interface WorkerPoolConfig {
  maxWorkers: number;
  maxMemoryMB: number;
}

export interface MemoryMetrics {
  usedHeapMB: number | null;
  totalHeapMB: number | null;
  heapLimitMB: number | null;
}

export interface ResourceMetrics {
  activeWorkers: number;
  maxWorkers: number;
  queuedTasks: number;
  memory: MemoryMetrics;
  computations: ComputationMetrics[];
}

export interface ComputationHistoryEntry {
  id: string;
  name: string;
  algorithmId: string;
  status: 'completed' | 'cancelled' | 'error';
  elapsedMs: number;
  completedAt: number;
  errorMessage?: string;
}

// ============================================================================
// Worker Communication
// ============================================================================

export interface SerializedGraph {
  nodes: { id: string; attributes: Record<string, unknown> }[];
  edges: { id: string; source: string; target: string; attributes: Record<string, unknown> }[];
}

// Main thread -> Worker
export type WorkerCommand =
  | { type: 'START'; payload: ComputationRequest & { graph: SerializedGraph } }
  | { type: 'PAUSE'; payload: { id: string } }
  | { type: 'RESUME'; payload: { id: string } }
  | { type: 'CANCEL'; payload: { id: string } }
  | { type: 'SET_PRIORITY'; payload: { id: string; priority: Priority } };

// Worker -> Main thread
export type WorkerMessage =
  | { type: 'PROGRESS'; payload: ComputationProgress }
  | { type: 'PARTIAL_RESULT'; payload: { id: string; results: [string, number][] } }
  | { type: 'COMPLETE'; payload: Omit<ComputedMetric, 'values'> & { values: [string, number][] } }
  | { type: 'ERROR'; payload: { id: string; error: string } }
  | { type: 'READY' };

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Scale a value from source range to target range with optional transform
 */
export function scaleValue(
  value: number,
  min: number,
  max: number,
  targetMin: number,
  targetMax: number,
  scale: ScaleType
): number {
  const range = max - min || 1;
  let normalized = Math.max(0, Math.min(1, (value - min) / range));

  switch (scale) {
    case 'log':
      // Map 0-1 to 1-10, take log10, normalize back to 0-1
      normalized = Math.log10(1 + normalized * 9);
      break;
    case 'sqrt':
      normalized = Math.sqrt(normalized);
      break;
    // 'linear' - no transform
  }

  return targetMin + normalized * (targetMax - targetMin);
}

/**
 * Calculate statistics for a set of values
 */
export function calculateStats(values: number[]): { min: number; max: number; mean: number; stdDev: number } {
  if (values.length === 0) {
    return { min: 0, max: 0, mean: 0, stdDev: 0 };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;

  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  const stdDev = Math.sqrt(avgSquaredDiff);

  return { min, max, mean, stdDev };
}

/**
 * Get batch size based on priority
 */
export function getBatchSize(priority: Priority): number {
  switch (priority) {
    case 'low': return 5;
    case 'medium': return 20;
    case 'high': return 100;
  }
}

/**
 * Get delay between batches based on priority (in ms)
 */
export function getBatchDelay(priority: Priority): number {
  switch (priority) {
    case 'low': return 100;
    case 'medium': return 16;  // ~1 frame
    case 'high': return 0;
  }
}

/**
 * Default visual mapping configuration
 */
export const DEFAULT_VISUAL_MAPPING: VisualMapping = {
  nodeSize: {
    metricId: '__builtin_degree',
    minSize: 4,
    maxSize: 20,
    scale: 'linear',
  },
  edgeWeight: {
    metricId: null,
    minWeight: 0.1,
    maxWeight: 5,
    scale: 'linear',
  },
  enableRealTimeUpdates: true,
};

/**
 * Default worker pool configuration
 */
export function getDefaultWorkerPoolConfig(): WorkerPoolConfig {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return {
    maxWorkers: Math.max(1, Math.floor(cores / 2)),
    maxMemoryMB: 512,
  };
}
