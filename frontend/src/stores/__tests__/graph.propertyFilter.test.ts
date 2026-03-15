import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'
import { useMetricsStore } from '@/stores/metrics'
import type { ComputedMetric } from '@/types/metrics'

function setupGraph() {
  const store = useGraphStore()
  store.nodes = [
    { node_id: 'n1', node_type: 'Person' },
    { node_id: 'n2', node_type: 'Person' },
    { node_id: 'n3', node_type: 'Company' },
  ]
  store.edges = [
    { edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'KNOWS' },
    { edge_id: 'e2', src: 'n1', dst: 'n3', relationship_type: 'WORKS_AT' },
  ]
  return store
}

function addMetric(metricsStore: ReturnType<typeof useMetricsStore>, values: Map<string, number>) {
  // Directly add a computed metric to the store
  const metric: ComputedMetric = {
    id: 'test-degree',
    name: 'Degree',
    algorithmId: 'degree',
    target: 'node',
    values,
    min: Math.min(...values.values()),
    max: Math.max(...values.values()),
    mean: [...values.values()].reduce((a, b) => a + b, 0) / values.size,
    stdDev: 0,
    computedAt: Date.now(),
    params: {},
    edgeTypeFilter: [],
    elapsedMs: 10,
  }
  metricsStore.computedMetrics.set(metric.id, metric)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('property filter evaluation via filteredNodes', () => {
  describe('disabled filter', () => {
    it('passes all nodes when filter is disabled', () => {
      const store = setupGraph()
      const metricsStore = useMetricsStore()
      addMetric(metricsStore, new Map([['n1', 10], ['n2', 5], ['n3', 1]]))

      store.addNodePropertyFilter({
        property: 'metric:test-degree',
        operator: 'greater_than',
        value: 100,
        enabled: false,
      })

      // Disabled filter should not affect results
      expect(store.filteredNodes).toHaveLength(3)
    })
  })

  describe('metric-based filters', () => {
    it('greater_than filters correctly', () => {
      const store = setupGraph()
      const metricsStore = useMetricsStore()
      addMetric(metricsStore, new Map([['n1', 10], ['n2', 5], ['n3', 1]]))

      store.addNodePropertyFilter({
        property: 'metric:test-degree',
        operator: 'greater_than',
        value: 5,
        enabled: true,
      })

      expect(store.filteredNodes.map(n => n.node_id)).toEqual(['n1'])
    })

    it('less_than filters correctly', () => {
      const store = setupGraph()
      const metricsStore = useMetricsStore()
      addMetric(metricsStore, new Map([['n1', 10], ['n2', 5], ['n3', 1]]))

      store.addNodePropertyFilter({
        property: 'metric:test-degree',
        operator: 'less_than',
        value: 5,
        enabled: true,
      })

      expect(store.filteredNodes.map(n => n.node_id)).toEqual(['n3'])
    })

    it('greater_than_or_equal includes boundary', () => {
      const store = setupGraph()
      const metricsStore = useMetricsStore()
      addMetric(metricsStore, new Map([['n1', 10], ['n2', 5], ['n3', 1]]))

      store.addNodePropertyFilter({
        property: 'metric:test-degree',
        operator: 'greater_than_or_equal',
        value: 5,
        enabled: true,
      })

      expect(store.filteredNodes.map(n => n.node_id).sort()).toEqual(['n1', 'n2'])
    })

    it('less_than_or_equal includes boundary', () => {
      const store = setupGraph()
      const metricsStore = useMetricsStore()
      addMetric(metricsStore, new Map([['n1', 10], ['n2', 5], ['n3', 1]]))

      store.addNodePropertyFilter({
        property: 'metric:test-degree',
        operator: 'less_than_or_equal',
        value: 5,
        enabled: true,
      })

      expect(store.filteredNodes.map(n => n.node_id).sort()).toEqual(['n2', 'n3'])
    })

    it('between (inclusive on both ends)', () => {
      const store = setupGraph()
      const metricsStore = useMetricsStore()
      addMetric(metricsStore, new Map([['n1', 10], ['n2', 5], ['n3', 1]]))

      store.addNodePropertyFilter({
        property: 'metric:test-degree',
        operator: 'between',
        value: null,
        minValue: 5,
        maxValue: 10,
        enabled: true,
      })

      expect(store.filteredNodes.map(n => n.node_id).sort()).toEqual(['n1', 'n2'])
    })

    it('between returns false when minValue/maxValue undefined', () => {
      const store = setupGraph()
      const metricsStore = useMetricsStore()
      addMetric(metricsStore, new Map([['n1', 10], ['n2', 5], ['n3', 1]]))

      store.addNodePropertyFilter({
        property: 'metric:test-degree',
        operator: 'between',
        value: null,
        // No minValue/maxValue
        enabled: true,
      })

      // between without min/max returns false for all
      expect(store.filteredNodes).toHaveLength(0)
    })

    it('equals with numeric value', () => {
      const store = setupGraph()
      const metricsStore = useMetricsStore()
      addMetric(metricsStore, new Map([['n1', 10], ['n2', 5], ['n3', 1]]))

      store.addNodePropertyFilter({
        property: 'metric:test-degree',
        operator: 'equals',
        value: 5,
        enabled: true,
      })

      expect(store.filteredNodes.map(n => n.node_id)).toEqual(['n2'])
    })

    it('not_equals excludes matching', () => {
      const store = setupGraph()
      const metricsStore = useMetricsStore()
      addMetric(metricsStore, new Map([['n1', 10], ['n2', 5], ['n3', 1]]))

      store.addNodePropertyFilter({
        property: 'metric:test-degree',
        operator: 'not_equals',
        value: 5,
        enabled: true,
      })

      expect(store.filteredNodes.map(n => n.node_id).sort()).toEqual(['n1', 'n3'])
    })

    it('returns false when metric has no value for the node', () => {
      const store = setupGraph()
      const metricsStore = useMetricsStore()
      // Only n1 has a metric value
      addMetric(metricsStore, new Map([['n1', 10]]))

      store.addNodePropertyFilter({
        property: 'metric:test-degree',
        operator: 'greater_than',
        value: 0,
        enabled: true,
      })

      // Only n1 has a value → only n1 passes
      expect(store.filteredNodes.map(n => n.node_id)).toEqual(['n1'])
    })
  })

  describe('filter CRUD actions', () => {
    it('addNodePropertyFilter generates an ID', () => {
      const store = setupGraph()
      store.addNodePropertyFilter({
        property: 'metric:degree',
        operator: 'greater_than',
        value: 5,
        enabled: true,
      })
      expect(store.filters.nodePropertyFilters).toHaveLength(1)
      expect(store.filters.nodePropertyFilters[0].id).toBeTruthy()
    })

    it('updateNodePropertyFilter modifies existing', () => {
      const store = setupGraph()
      store.addNodePropertyFilter({
        property: 'metric:degree',
        operator: 'greater_than',
        value: 5,
        enabled: true,
      })
      const id = store.filters.nodePropertyFilters[0].id
      store.updateNodePropertyFilter(id, { value: 10 })
      expect(store.filters.nodePropertyFilters[0].value).toBe(10)
    })

    it('removeNodePropertyFilter removes', () => {
      const store = setupGraph()
      store.addNodePropertyFilter({
        property: 'metric:degree',
        operator: 'greater_than',
        value: 5,
        enabled: true,
      })
      const id = store.filters.nodePropertyFilters[0].id
      store.removeNodePropertyFilter(id)
      expect(store.filters.nodePropertyFilters).toHaveLength(0)
    })
  })

  describe('edge property filters', () => {
    it('filters edges by metric value', () => {
      const store = setupGraph()
      const metricsStore = useMetricsStore()

      // Add an edge metric
      const edgeMetric: ComputedMetric = {
        id: 'edge-betweenness',
        name: 'Edge Betweenness',
        algorithmId: 'edge-betweenness',
        target: 'edge',
        values: new Map([['e1', 0.8], ['e2', 0.2]]),
        min: 0.2,
        max: 0.8,
        mean: 0.5,
        stdDev: 0.3,
        computedAt: Date.now(),
        params: {},
        edgeTypeFilter: [],
        elapsedMs: 10,
      }
      metricsStore.computedMetrics.set(edgeMetric.id, edgeMetric)

      store.addEdgePropertyFilter({
        property: 'metric:edge-betweenness',
        operator: 'greater_than',
        value: 0.5,
        enabled: true,
      })

      expect(store.filteredEdges.map(e => e.edge_id)).toEqual(['e1'])
    })
  })
})
