/**
 * Worker Pool Manager
 *
 * Manages a pool of Web Workers for background metric computation.
 * Handles task queuing, worker lifecycle, and resource monitoring.
 */

import type {
  WorkerCommand,
  WorkerMessage,
  ComputationRequest,
  ComputationProgress,
  ComputedMetric,
  Priority,
  SerializedGraph,
  MemoryMetrics,
} from '@/types/metrics';

// ============================================================================
// Types
// ============================================================================

interface QueuedTask {
  request: ComputationRequest;
  graph: SerializedGraph;
  resolve: (result: ComputedMetric) => void;
  reject: (error: Error) => void;
}

interface WorkerState {
  worker: Worker;
  busy: boolean;
  currentTaskId: string | null;
}

type ProgressCallback = (progress: ComputationProgress) => void;
type PartialResultCallback = (id: string, results: [string, number][]) => void;

// ============================================================================
// Worker Pool Class
// ============================================================================

export class WorkerPool {
  private workers: WorkerState[] = [];
  private taskQueue: QueuedTask[] = [];
  private maxWorkers: number;
  private maxMemoryMB: number;

  // Callbacks
  private onProgress: ProgressCallback | null = null;
  private onPartialResult: PartialResultCallback | null = null;

  // Active task tracking
  private activeTasks: Map<string, { resolve: (r: ComputedMetric) => void; reject: (e: Error) => void }> = new Map();
  private pausedTasks: Set<string> = new Set();

  constructor(maxWorkers: number = 2, maxMemoryMB: number = 512) {
    this.maxWorkers = maxWorkers;
    this.maxMemoryMB = maxMemoryMB;
  }

  // ============================================================================
  // Configuration
  // ============================================================================

  /**
   * Set the maximum number of workers
   */
  setMaxWorkers(max: number): void {
    this.maxWorkers = Math.max(1, max);

    // If we have too many workers, don't terminate active ones
    // Just let them finish and don't create new ones
    this.processQueue();
  }

  /**
   * Set the maximum memory usage
   */
  setMaxMemory(mb: number): void {
    this.maxMemoryMB = mb;
  }

  /**
   * Set progress callback
   */
  setProgressCallback(callback: ProgressCallback): void {
    this.onProgress = callback;
  }

  /**
   * Set partial result callback
   */
  setPartialResultCallback(callback: PartialResultCallback): void {
    this.onPartialResult = callback;
  }

  // ============================================================================
  // Task Submission
  // ============================================================================

  /**
   * Submit a computation task to the pool
   */
  async submit(request: ComputationRequest, graph: SerializedGraph): Promise<ComputedMetric> {
    return new Promise((resolve, reject) => {
      const task: QueuedTask = { request, graph, resolve, reject };

      // Insert based on priority
      this.insertByPriority(task);

      // Try to process the queue
      this.processQueue();
    });
  }

  /**
   * Insert task into queue based on priority
   */
  private insertByPriority(task: QueuedTask): void {
    const priorityOrder: Record<Priority, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };

    const taskPriority = priorityOrder[task.request.priority];
    let insertIndex = this.taskQueue.length;

    for (let i = 0; i < this.taskQueue.length; i++) {
      const queuedPriority = priorityOrder[this.taskQueue[i].request.priority];
      if (taskPriority < queuedPriority) {
        insertIndex = i;
        break;
      }
    }

    this.taskQueue.splice(insertIndex, 0, task);
  }

  // ============================================================================
  // Task Control
  // ============================================================================

  /**
   * Pause a running task
   */
  pause(taskId: string): void {
    this.pausedTasks.add(taskId);

    const worker = this.findWorkerForTask(taskId);
    if (worker) {
      const command: WorkerCommand = { type: 'PAUSE', payload: { id: taskId } };
      worker.worker.postMessage(command);
    }
  }

  /**
   * Resume a paused task
   */
  resume(taskId: string): void {
    this.pausedTasks.delete(taskId);

    const worker = this.findWorkerForTask(taskId);
    if (worker) {
      const command: WorkerCommand = { type: 'RESUME', payload: { id: taskId } };
      worker.worker.postMessage(command);
    }
  }

  /**
   * Cancel a task (queued or running)
   */
  cancel(taskId: string): void {
    // Check if in queue
    const queueIndex = this.taskQueue.findIndex((t) => t.request.id === taskId);
    if (queueIndex !== -1) {
      const [task] = this.taskQueue.splice(queueIndex, 1);
      task.reject(new Error('Task cancelled'));
      return;
    }

    // Check if running
    const worker = this.findWorkerForTask(taskId);
    if (worker) {
      const command: WorkerCommand = { type: 'CANCEL', payload: { id: taskId } };
      worker.worker.postMessage(command);
    }

    // Clean up
    this.pausedTasks.delete(taskId);
    const handlers = this.activeTasks.get(taskId);
    if (handlers) {
      handlers.reject(new Error('Task cancelled'));
      this.activeTasks.delete(taskId);
    }
  }

  /**
   * Update task priority
   */
  setPriority(taskId: string, priority: Priority): void {
    // Update in queue
    const task = this.taskQueue.find((t) => t.request.id === taskId);
    if (task) {
      // Remove and re-insert with new priority
      const index = this.taskQueue.indexOf(task);
      this.taskQueue.splice(index, 1);
      task.request.priority = priority;
      this.insertByPriority(task);
    }

    // Update running task
    const worker = this.findWorkerForTask(taskId);
    if (worker) {
      const command: WorkerCommand = { type: 'SET_PRIORITY', payload: { id: taskId, priority } };
      worker.worker.postMessage(command);
    }
  }

  // ============================================================================
  // Worker Management
  // ============================================================================

  /**
   * Process the task queue
   */
  private processQueue(): void {
    // Check memory before spawning new workers
    const memory = this.getMemoryMetrics();
    if (memory.usedHeapMB !== null && memory.usedHeapMB > this.maxMemoryMB) {
      // Memory limit reached, don't spawn new workers
      return;
    }

    // Find or create idle workers
    while (this.taskQueue.length > 0 && this.getIdleWorkerCount() > 0) {
      const task = this.taskQueue.shift()!;
      this.runTask(task);
    }

    // Create new workers if under limit and have tasks
    while (
      this.taskQueue.length > 0 &&
      this.workers.length < this.maxWorkers &&
      this.getIdleWorkerCount() === 0
    ) {
      this.createWorker();
      const task = this.taskQueue.shift()!;
      this.runTask(task);
    }
  }

  /**
   * Create a new worker
   */
  private createWorker(): WorkerState {
    // Use Vite's worker import syntax
    const worker = new Worker(
      new URL('../workers/metricsWorker.ts', import.meta.url),
      { type: 'module' }
    );

    const state: WorkerState = {
      worker,
      busy: false,
      currentTaskId: null,
    };

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      this.handleWorkerMessage(state, event.data);
    };

    worker.onerror = (error) => {
      console.error('Worker error:', error);
      this.handleWorkerError(state, error);
    };

    this.workers.push(state);
    return state;
  }

  /**
   * Run a task on an available worker
   */
  private runTask(task: QueuedTask): void {
    const worker = this.getIdleWorker();
    if (!worker) {
      // No worker available, put task back in queue
      this.taskQueue.unshift(task);
      return;
    }

    worker.busy = true;
    worker.currentTaskId = task.request.id;

    // Store handlers for completion
    this.activeTasks.set(task.request.id, {
      resolve: task.resolve,
      reject: task.reject,
    });

    // Send command to worker
    const command: WorkerCommand = {
      type: 'START',
      payload: {
        ...task.request,
        graph: task.graph,
      },
    };

    worker.worker.postMessage(command);
  }

  /**
   * Handle messages from workers
   */
  private handleWorkerMessage(worker: WorkerState, message: WorkerMessage): void {
    switch (message.type) {
      case 'READY':
        // Worker is ready to accept tasks
        this.processQueue();
        break;

      case 'PROGRESS':
        if (this.onProgress) {
          this.onProgress(message.payload);
        }
        break;

      case 'PARTIAL_RESULT':
        if (this.onPartialResult) {
          this.onPartialResult(message.payload.id, message.payload.results);
        }
        break;

      case 'COMPLETE': {
        const { id } = message.payload;
        const handlers = this.activeTasks.get(id);

        if (handlers) {
          // Convert array back to Map
          const result: ComputedMetric = {
            ...message.payload,
            values: new Map(message.payload.values),
          };
          handlers.resolve(result);
          this.activeTasks.delete(id);
        }

        // Mark worker as idle
        worker.busy = false;
        worker.currentTaskId = null;
        this.processQueue();
        break;
      }

      case 'ERROR': {
        const { id, error } = message.payload;
        const handlers = this.activeTasks.get(id);

        if (handlers) {
          handlers.reject(new Error(error));
          this.activeTasks.delete(id);
        }

        // Mark worker as idle
        worker.busy = false;
        worker.currentTaskId = null;
        this.processQueue();
        break;
      }
    }
  }

  /**
   * Handle worker errors
   */
  private handleWorkerError(worker: WorkerState, error: ErrorEvent): void {
    // Reject current task if any
    if (worker.currentTaskId) {
      const handlers = this.activeTasks.get(worker.currentTaskId);
      if (handlers) {
        handlers.reject(new Error(`Worker error: ${error.message}`));
        this.activeTasks.delete(worker.currentTaskId);
      }
    }

    // Remove the failed worker
    const index = this.workers.indexOf(worker);
    if (index !== -1) {
      this.workers.splice(index, 1);
    }

    // Try to terminate the worker
    try {
      worker.worker.terminate();
    } catch {
      // Ignore termination errors
    }

    // Process queue to potentially spawn a replacement
    this.processQueue();
  }

  /**
   * Get an idle worker
   */
  private getIdleWorker(): WorkerState | null {
    return this.workers.find((w) => !w.busy) || null;
  }

  /**
   * Count idle workers
   */
  private getIdleWorkerCount(): number {
    return this.workers.filter((w) => !w.busy).length;
  }

  /**
   * Find the worker running a specific task
   */
  private findWorkerForTask(taskId: string): WorkerState | null {
    return this.workers.find((w) => w.currentTaskId === taskId) || null;
  }

  // ============================================================================
  // Resource Monitoring
  // ============================================================================

  /**
   * Get current memory metrics
   */
  getMemoryMetrics(): MemoryMetrics {
    // Use Performance API if available (Chrome)
    if ('memory' in performance) {
      const memory = (performance as unknown as { memory: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
      return {
        usedHeapMB: Math.round(memory.usedJSHeapSize / 1024 / 1024),
        totalHeapMB: Math.round(memory.totalJSHeapSize / 1024 / 1024),
        heapLimitMB: Math.round(memory.jsHeapSizeLimit / 1024 / 1024),
      };
    }

    return {
      usedHeapMB: null,
      totalHeapMB: null,
      heapLimitMB: null,
    };
  }

  /**
   * Get pool status
   */
  getStatus(): {
    activeWorkers: number;
    maxWorkers: number;
    queuedTasks: number;
    memory: MemoryMetrics;
  } {
    return {
      activeWorkers: this.workers.filter((w) => w.busy).length,
      maxWorkers: this.maxWorkers,
      queuedTasks: this.taskQueue.length,
      memory: this.getMemoryMetrics(),
    };
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Terminate all workers and clear the queue
   */
  terminate(): void {
    // Reject all queued tasks
    for (const task of this.taskQueue) {
      task.reject(new Error('Worker pool terminated'));
    }
    this.taskQueue = [];

    // Reject all active tasks
    for (const [_id, handlers] of this.activeTasks) {
      handlers.reject(new Error('Worker pool terminated'));
    }
    this.activeTasks.clear();

    // Terminate all workers
    for (const worker of this.workers) {
      try {
        worker.worker.terminate();
      } catch {
        // Ignore termination errors
      }
    }
    this.workers = [];

    this.pausedTasks.clear();
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let workerPoolInstance: WorkerPool | null = null;

/**
 * Get or create the worker pool singleton
 */
export function getWorkerPool(maxWorkers?: number, maxMemoryMB?: number): WorkerPool {
  if (!workerPoolInstance) {
    workerPoolInstance = new WorkerPool(maxWorkers, maxMemoryMB);
  }
  return workerPoolInstance;
}

/**
 * Reset the worker pool (for testing or cleanup)
 */
export function resetWorkerPool(): void {
  if (workerPoolInstance) {
    workerPoolInstance.terminate();
    workerPoolInstance = null;
  }
}
