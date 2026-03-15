import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'
import { useClusterStore } from '@/stores/cluster'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('exploration state serialization', () => {
  describe('getExplorationState', () => {
    it('captures current filters', () => {
      const store = useGraphStore()
      store.applyFilters({ node_types: ['Person'], edge_types: ['KNOWS'] })

      const state = store.getExplorationState()
      expect(state.filters.node_types).toEqual(['Person'])
      expect(state.filters.edge_types).toEqual(['KNOWS'])
    })

    it('captures viewport state', () => {
      const store = useGraphStore()
      store.viewport = { zoom: 2.5, center_x: 100, center_y: -50 }

      const state = store.getExplorationState()
      expect(state.viewport.zoom).toBe(2.5)
      expect(state.viewport.center_x).toBe(100)
      expect(state.viewport.center_y).toBe(-50)
    })

    it('captures layout_algorithm', () => {
      const store = useGraphStore()
      store.setLayoutAlgorithm('circular')

      const state = store.getExplorationState()
      expect(state.layout_algorithm).toBe('circular')
    })

    it('captures graph_query when set', () => {
      const store = useGraphStore()
      store.setGraphQuery('SELECT * FROM nodes')

      const state = store.getExplorationState()
      expect(state.graph_query).toBe('SELECT * FROM nodes')
    })

    it('graph_query is undefined when empty', () => {
      const store = useGraphStore()
      const state = store.getExplorationState()
      expect(state.graph_query).toBeUndefined()
    })

    it('captures textFormat state', () => {
      const store = useGraphStore()
      store.addTextFormatRule({
        name: 'Test Rule',
        target: 'node',
        types: ['Person'],
        template: '{node_id|upper}',
        priority: 1,
        enabled: true,
        scope: 'exploration',
      })

      const state = store.getExplorationState()
      expect(state.textFormat).toBeDefined()
      expect(state.textFormat!.rules).toHaveLength(1)
      expect(state.textFormat!.rules[0].template).toBe('{node_id|upper}')
    })

    it('captures cluster state', () => {
      const clusterStore = useClusterStore()
      clusterStore.createCluster({
        cluster_id: 'c1',
        cluster_name: 'Test',
        cluster_class: 'x',
        figure: 'circle',
        state: 'closed',
        node_ids: ['n1'],
      })

      const graphStore = useGraphStore()
      const state = graphStore.getExplorationState()
      expect(state.clusters).toBeDefined()
      expect(state.clusters.clusters).toHaveLength(1)
    })

    it('nodes and edges arrays are empty (regenerated from query)', () => {
      const store = useGraphStore()
      store.nodes = [{ node_id: 'n1', node_type: 'T' }]
      store.edges = [{ edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'R' }]

      const state = store.getExplorationState()
      expect(state.nodes).toHaveLength(0)
      expect(state.edges).toHaveLength(0)
    })
  })

  describe('text format state round-trip', () => {
    it('getTextFormatState / loadTextFormatState round-trip', () => {
      const store = useGraphStore()

      // Set up rules
      store.addTextFormatRule({
        name: 'Rule1',
        target: 'node',
        types: [],
        template: '{node_type}: {node_id}',
        priority: 10,
        enabled: true,
        scope: 'global',
      })
      store.updateTextFormatDefaults({ nodeTemplate: '{node_type}' })

      const state = store.getTextFormatState()

      // Reset and reload
      store.loadTextFormatState(undefined)
      expect(store.textFormatRules).toHaveLength(0)
      expect(store.textFormatDefaults.nodeTemplate).toBe('{node_id|truncate:10}')

      store.loadTextFormatState(state)
      expect(store.textFormatRules).toHaveLength(1)
      expect(store.textFormatRules[0].template).toBe('{node_type}: {node_id}')
      expect(store.textFormatDefaults.nodeTemplate).toBe('{node_type}')
    })

    it('loadTextFormatState with undefined resets to defaults', () => {
      const store = useGraphStore()
      store.addTextFormatRule({
        name: 'Rule',
        target: 'node',
        types: [],
        template: 'x',
        priority: 1,
        enabled: true,
        scope: 'global',
      })

      store.loadTextFormatState(undefined)
      expect(store.textFormatRules).toHaveLength(0)
      expect(store.textFormatDefaults.nodeTemplate).toBe('{node_id|truncate:10}')
      expect(store.textFormatDefaults.edgeTemplate).toBe('{relationship_type}')
    })
  })

  describe('text format rule management', () => {
    it('addTextFormatRule generates an ID', () => {
      const store = useGraphStore()
      const rule = store.addTextFormatRule({
        name: 'New',
        target: 'node',
        types: [],
        template: '{node_id}',
        priority: 1,
        enabled: true,
        scope: 'global',
      })
      expect(rule.id).toBeTruthy()
      expect(store.textFormatRules).toHaveLength(1)
    })

    it('updateTextFormatRule modifies existing', () => {
      const store = useGraphStore()
      const rule = store.addTextFormatRule({
        name: 'Old',
        target: 'node',
        types: [],
        template: 'old',
        priority: 1,
        enabled: true,
        scope: 'global',
      })
      store.updateTextFormatRule(rule.id, { template: 'new' })
      expect(store.textFormatRules[0].template).toBe('new')
    })

    it('removeTextFormatRule removes', () => {
      const store = useGraphStore()
      const rule = store.addTextFormatRule({
        name: 'Del',
        target: 'node',
        types: [],
        template: 'x',
        priority: 1,
        enabled: true,
        scope: 'global',
      })
      store.removeTextFormatRule(rule.id)
      expect(store.textFormatRules).toHaveLength(0)
    })

    it('reorderTextFormatRules updates priorities', () => {
      const store = useGraphStore()
      const r1 = store.addTextFormatRule({ name: 'A', target: 'node', types: [], template: 'a', priority: 1, enabled: true, scope: 'global' })
      const r2 = store.addTextFormatRule({ name: 'B', target: 'node', types: [], template: 'b', priority: 2, enabled: true, scope: 'global' })

      // Reorder: B first, then A
      store.reorderTextFormatRules([r2.id, r1.id])

      // B should now have higher priority (2), A lower (1)
      const ruleB = store.textFormatRules.find(r => r.id === r2.id)
      const ruleA = store.textFormatRules.find(r => r.id === r1.id)
      expect(ruleB!.priority).toBeGreaterThan(ruleA!.priority)
    })
  })

  describe('property filter preservation', () => {
    it('nodePropertyFilters captured in exploration state', () => {
      const store = useGraphStore()
      store.addNodePropertyFilter({
        property: 'metric:degree',
        operator: 'greater_than',
        value: 5,
        enabled: true,
      })

      const state = store.getExplorationState()
      expect(state.filters.nodePropertyFilters).toHaveLength(1)
      expect(state.filters.nodePropertyFilters[0].property).toBe('metric:degree')
    })

    it('edgePropertyFilters captured in exploration state', () => {
      const store = useGraphStore()
      store.addEdgePropertyFilter({
        property: 'metric:edge-betweenness',
        operator: 'less_than',
        value: 0.5,
        enabled: true,
      })

      const state = store.getExplorationState()
      expect(state.filters.edgePropertyFilters).toHaveLength(1)
    })
  })
})
