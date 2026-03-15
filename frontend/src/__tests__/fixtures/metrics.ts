import type { ComputedMetric } from '@/types/metrics'

export function createComputedMetric(overrides: Partial<ComputedMetric> = {}): ComputedMetric {
  return {
    id: 'metric-1',
    name: 'Test Degree',
    algorithmId: 'degree',
    target: 'node',
    values: new Map([['node-1', 5], ['node-2', 3], ['node-3', 1]]),
    min: 1,
    max: 5,
    mean: 3,
    stdDev: 1.63,
    computedAt: Date.now(),
    params: { direction: 'all' },
    edgeTypeFilter: [],
    elapsedMs: 100,
    ...overrides,
  }
}
