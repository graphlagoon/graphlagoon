/**
 * Tests for the metrics calculator lifecycle (technical debt #6).
 *
 * The worker pool is a module singleton that outlives the graph view, so the
 * view must be able to terminate it on unmount / context change and the
 * calculator must re-initialize lazily afterwards. These tests pin that
 * contract at the service level.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const { poolMock } = vi.hoisted(() => ({
  poolMock: {
    setProgressCallback: vi.fn(),
    setPartialResultCallback: vi.fn(),
    submit: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    setPriority: vi.fn(),
    setMaxWorkers: vi.fn(),
    setMaxMemory: vi.fn(),
    getStatus: vi.fn(() => ({
      activeWorkers: 0,
      maxWorkers: 4,
      queuedTasks: 0,
      memory: { usedMB: 0, maxMB: 512 },
    })),
  },
}));

vi.mock('@/services/workerPool', () => ({
  getWorkerPool: vi.fn(() => poolMock),
  resetWorkerPool: vi.fn(),
}));

import {
  getMetricsCalculator,
  resetMetricsCalculator,
} from '@/services/metricsCalculator';
import { getWorkerPool, resetWorkerPool } from '@/services/workerPool';

describe('metricsCalculator lifecycle', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // Clear the module singleton before clearing mocks so the reset call
    // itself does not count in the assertions below.
    resetMetricsCalculator();
    vi.clearAllMocks();
  });

  it('initialize wires the pool exactly once', () => {
    const calculator = getMetricsCalculator();
    calculator.initialize();
    calculator.initialize();

    expect(getWorkerPool).toHaveBeenCalledTimes(1);
    expect(poolMock.setProgressCallback).toHaveBeenCalledTimes(1);
    expect(poolMock.setPartialResultCallback).toHaveBeenCalledTimes(1);
  });

  it('resetMetricsCalculator terminates the worker pool', () => {
    getMetricsCalculator().initialize();

    resetMetricsCalculator();

    expect(resetWorkerPool).toHaveBeenCalledTimes(1);
  });

  it('re-initializes lazily after a reset', () => {
    getMetricsCalculator().initialize();
    resetMetricsCalculator();

    // A fresh calculator (as MetricsPanel obtains on next mount) must wire a
    // new pool instead of reusing the terminated one.
    getMetricsCalculator().initialize();

    expect(poolMock.setProgressCallback).toHaveBeenCalledTimes(2);
  });

  it('reset is safe to call when nothing was initialized', () => {
    expect(() => resetMetricsCalculator()).not.toThrow();
  });
});
