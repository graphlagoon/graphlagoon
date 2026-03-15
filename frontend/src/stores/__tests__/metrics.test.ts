import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useMetricsStore } from '@/stores/metrics'
import { useGraphStore } from '@/stores/graph'
import type { ComputedMetric, ComputationMetrics } from '@/types/metrics'

function setupGraph() {
  const store = useGraphStore()
  store.nodes = [
    { node_id: 'n1', node_type: 'Person' },
    { node_id: 'n2', node_type: 'Person' },
    { node_id: 'n3', node_type: 'Company' },
    { node_id: 'n4', node_type: 'Company' },
  ]
  store.edges = [
    { edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'KNOWS' },
    { edge_id: 'e2', src: 'n2', dst: 'n3', relationship_type: 'WORKS_AT' },
    { edge_id: 'e3', src: 'n3', dst: 'n4', relationship_type: 'PARTNER' },
  ]
  return store
}

function makeComputation(id: string): ComputationMetrics {
  return {
    id,
    name: `Metric ${id}`,
    algorithmId: 'degree',
    status: 'running',
    progress: 0,
    startedAt: Date.now(),
    elapsedMs: 0,
    priority: 'medium',
  }
}

function makeComputedMetric(overrides: Partial<ComputedMetric> = {}): ComputedMetric {
  return {
    id: 'metric-1',
    name: 'Degree',
    algorithmId: 'degree',
    target: 'node',
    values: new Map([['n1', 1], ['n2', 2], ['n3', 1]]),
    min: 1,
    max: 2,
    mean: 1.33,
    stdDev: 0.47,
    computedAt: Date.now(),
    params: {},
    edgeTypeFilter: [],
    elapsedMs: 50,
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

// ============================================================================
// graphInfo
// ============================================================================

describe('graphInfo', () => {
  it('nodeCount and edgeCount reflect filtered graph', () => {
    setupGraph()
    const metricsStore = useMetricsStore()
    expect(metricsStore.graphInfo.nodeCount).toBe(4)
    expect(metricsStore.graphInfo.edgeCount).toBe(3)
  })

  it('density calculated correctly for directed graph', () => {
    setupGraph()
    const metricsStore = useMetricsStore()
    // 4 nodes, 3 edges. Max edges = 4*3 = 12. Density = 3/12 = 0.25
    expect(metricsStore.graphInfo.density).toBeCloseTo(0.25, 2)
  })

  it('isConnected true for single component', () => {
    setupGraph()
    const metricsStore = useMetricsStore()
    // All nodes connected: n1-n2-n3-n4
    expect(metricsStore.graphInfo.isConnected).toBe(true)
    expect(metricsStore.graphInfo.componentCount).toBe(1)
  })

  it('isConnected false for disconnected graph', () => {
    const graphStore = useGraphStore()
    graphStore.nodes = [
      { node_id: 'a', node_type: 'T' },
      { node_id: 'b', node_type: 'T' },
      { node_id: 'c', node_type: 'T' },
    ]
    graphStore.edges = [
      { edge_id: 'e1', src: 'a', dst: 'b', relationship_type: 'R' },
      // c is disconnected
    ]

    const metricsStore = useMetricsStore()
    expect(metricsStore.graphInfo.isConnected).toBe(false)
    expect(metricsStore.graphInfo.componentCount).toBe(2)
  })

  it('empty graph: nodeCount=0, componentCount=0', () => {
    const metricsStore = useMetricsStore()
    expect(metricsStore.graphInfo.nodeCount).toBe(0)
    expect(metricsStore.graphInfo.componentCount).toBe(0)
  })

  it('componentCount uses Union-Find correctly with multiple components', () => {
    const graphStore = useGraphStore()
    graphStore.nodes = [
      { node_id: 'a', node_type: 'T' },
      { node_id: 'b', node_type: 'T' },
      { node_id: 'c', node_type: 'T' },
      { node_id: 'd', node_type: 'T' },
      { node_id: 'e', node_type: 'T' },
    ]
    graphStore.edges = [
      { edge_id: 'e1', src: 'a', dst: 'b', relationship_type: 'R' },
      { edge_id: 'e2', src: 'c', dst: 'd', relationship_type: 'R' },
      // e is isolated → 3 components: {a,b}, {c,d}, {e}
    ]

    const metricsStore = useMetricsStore()
    expect(metricsStore.graphInfo.componentCount).toBe(3)
  })
})

// ============================================================================
// computation lifecycle
// ============================================================================

describe('computation lifecycle', () => {
  it('registerComputation adds to activeComputations', () => {
    const store = useMetricsStore()
    store.registerComputation(makeComputation('c1'))
    expect(store.activeComputations.has('c1')).toBe(true)
  })

  it('updateComputationProgress modifies existing', () => {
    const store = useMetricsStore()
    store.registerComputation(makeComputation('c1'))
    store.updateComputationProgress('c1', { progress: 50 })
    expect(store.activeComputations.get('c1')!.progress).toBe(50)
  })

  it('completeComputation moves to history and stores metric', () => {
    setupGraph()
    const store = useMetricsStore()
    store.registerComputation(makeComputation('metric-1'))

    const metric = makeComputedMetric()
    store.completeComputation(metric)

    expect(store.activeComputations.has('metric-1')).toBe(false)
    expect(store.computedMetrics.has('metric-1')).toBe(true)
    expect(store.computationHistory).toHaveLength(1)
    expect(store.computationHistory[0].status).toBe('completed')
  })

  it('failComputation moves to history with error', () => {
    const store = useMetricsStore()
    store.registerComputation(makeComputation('c1'))
    store.failComputation('c1', 'Something went wrong')

    expect(store.activeComputations.has('c1')).toBe(false)
    expect(store.computationHistory).toHaveLength(1)
    expect(store.computationHistory[0].status).toBe('error')
    expect(store.computationHistory[0].errorMessage).toBe('Something went wrong')
  })

  it('cancelComputation moves to history', () => {
    const store = useMetricsStore()
    store.registerComputation(makeComputation('c1'))
    store.cancelComputation('c1')

    expect(store.activeComputations.has('c1')).toBe(false)
    expect(store.computationHistory).toHaveLength(1)
    expect(store.computationHistory[0].status).toBe('cancelled')
  })

  it('history capped at 50 entries', () => {
    const store = useMetricsStore()
    for (let i = 0; i < 55; i++) {
      store.registerComputation(makeComputation(`c${i}`))
      store.cancelComputation(`c${i}`)
    }
    expect(store.computationHistory.length).toBeLessThanOrEqual(50)
  })

  it('hasActiveComputations reflects running/queued state', () => {
    const store = useMetricsStore()
    expect(store.hasActiveComputations).toBe(false)

    store.registerComputation(makeComputation('c1'))
    expect(store.hasActiveComputations).toBe(true)

    store.cancelComputation('c1')
    expect(store.hasActiveComputations).toBe(false)
  })
})

// ============================================================================
// visual mapping
// ============================================================================

describe('visual mapping', () => {
  it('setNodeSizeMetric updates mapping', () => {
    const store = useMetricsStore()
    store.setNodeSizeMetric('my-metric')
    expect(store.visualMapping.nodeSize.metricId).toBe('my-metric')
  })

  it('setEdgeWeightMetric updates mapping', () => {
    const store = useMetricsStore()
    store.setEdgeWeightMetric('edge-metric')
    expect(store.visualMapping.edgeWeight.metricId).toBe('edge-metric')
  })

  it('deleteMetric clears mapping if was selected', () => {
    setupGraph()
    const store = useMetricsStore()
    const metric = makeComputedMetric({ id: 'to-delete' })
    store.computedMetrics.set('to-delete', metric)
    store.setNodeSizeMetric('to-delete')

    store.deleteMetric('to-delete')

    expect(store.computedMetrics.has('to-delete')).toBe(false)
    expect(store.visualMapping.nodeSize.metricId).toBeNull()
  })

  it('clearAllMetrics clears all and resets mappings', () => {
    setupGraph()
    const store = useMetricsStore()
    store.computedMetrics.set('m1', makeComputedMetric({ id: 'm1' }))
    store.computedMetrics.set('m2', makeComputedMetric({ id: 'm2' }))
    store.setNodeSizeMetric('m1')
    store.setEdgeWeightMetric('m2')

    store.clearAllMetrics()

    expect(store.computedMetrics.size).toBe(0)
    expect(store.visualMapping.nodeSize.metricId).toBeNull()
    expect(store.visualMapping.edgeWeight.metricId).toBeNull()
  })

  it('resetVisualMapping restores defaults after updateNodeSizeMapping', () => {
    const store = useMetricsStore()
    store.updateNodeSizeMapping({ minSize: 100 })

    store.resetVisualMapping()

    expect(store.visualMapping.nodeSize.minSize).toBe(4)
  })

  it('resetVisualMapping restores defaults after setNodeSizeMetric', () => {
    const store = useMetricsStore()
    store.setNodeSizeMetric('some-metric')
    store.updateNodeSizeMapping({ minSize: 50 })

    store.resetVisualMapping()

    expect(store.visualMapping.nodeSize.metricId).toBe('__builtin_degree')
    expect(store.visualMapping.nodeSize.minSize).toBe(4)
    expect(store.visualMapping.nodeSize.maxSize).toBe(20)
    expect(store.visualMapping.nodeSize.scale).toBe('linear')
  })

  it('resetVisualMapping restores edgeWeight defaults', () => {
    const store = useMetricsStore()
    store.setEdgeWeightMetric('edge-m')
    store.updateEdgeWeightMapping({ minWeight: 10 })

    store.resetVisualMapping()

    expect(store.visualMapping.edgeWeight.metricId).toBeNull()
    expect(store.visualMapping.edgeWeight.minWeight).toBe(0.1)
  })
})

// ============================================================================
// nodeMetrics / edgeMetrics
// ============================================================================

describe('nodeMetrics / edgeMetrics', () => {
  it('filters computedMetrics by target=node', () => {
    const store = useMetricsStore()
    store.computedMetrics.set('n1', makeComputedMetric({ id: 'n1', target: 'node' }))
    store.computedMetrics.set('e1', makeComputedMetric({ id: 'e1', target: 'edge' }))

    // No graph edges → no built-in degree, so only user-computed node metric
    expect(store.nodeMetrics).toHaveLength(1)
    expect(store.nodeMetrics[0].id).toBe('n1')
  })

  it('filters computedMetrics by target=edge', () => {
    const store = useMetricsStore()
    store.computedMetrics.set('n1', makeComputedMetric({ id: 'n1', target: 'node' }))
    store.computedMetrics.set('e1', makeComputedMetric({ id: 'e1', target: 'edge' }))

    expect(store.edgeMetrics).toHaveLength(1)
    expect(store.edgeMetrics[0].id).toBe('e1')
  })
})

// ============================================================================
// built-in degree metric
// ============================================================================

describe('built-in degree metric', () => {
  it('nodeMetrics includes built-in degree when graph has edges', () => {
    setupGraph()
    const store = useMetricsStore()
    expect(store.nodeMetrics.some(m => m.id === '__builtin_degree')).toBe(true)
  })

  it('built-in degree has correct values', () => {
    setupGraph()
    const store = useMetricsStore()
    const degree = store.nodeMetrics.find(m => m.id === '__builtin_degree')!
    // n1: e1(src) → degree 1
    // n2: e1(dst) + e2(src) → degree 2
    // n3: e2(dst) + e3(src) → degree 2
    // n4: e3(dst) → degree 1
    expect(degree.values.get('n1')).toBe(1)
    expect(degree.values.get('n2')).toBe(2)
    expect(degree.values.get('n3')).toBe(2)
    expect(degree.values.get('n4')).toBe(1)
    expect(degree.min).toBe(1)
    expect(degree.max).toBe(2)
    expect(degree.target).toBe('node')
  })

  it('built-in degree not present when graph has no edges', () => {
    const store = useMetricsStore()
    expect(store.nodeMetrics.some(m => m.id === '__builtin_degree')).toBe(false)
  })

  it('built-in degree appears first, before user-computed metrics', () => {
    setupGraph()
    const store = useMetricsStore()
    store.computedMetrics.set('user-m', makeComputedMetric({ id: 'user-m', target: 'node' }))

    expect(store.nodeMetrics[0].id).toBe('__builtin_degree')
    expect(store.nodeMetrics[1].id).toBe('user-m')
  })

  it('nodeSizeMetric resolves built-in degree when selected', () => {
    setupGraph()
    const store = useMetricsStore()
    store.setNodeSizeMetric('__builtin_degree')

    expect(store.nodeSizeMetric).not.toBeNull()
    expect(store.nodeSizeMetric!.id).toBe('__builtin_degree')
    expect(store.nodeSizeMetric!.values.size).toBeGreaterThan(0)
  })

  it('deleteMetric ignores built-in metrics', () => {
    setupGraph()
    const store = useMetricsStore()
    store.setNodeSizeMetric('__builtin_degree')

    store.deleteMetric('__builtin_degree')

    // Should still exist (not deleted)
    expect(store.nodeSizeMetric).not.toBeNull()
    expect(store.nodeMetrics.some(m => m.id === '__builtin_degree')).toBe(true)
  })
})
