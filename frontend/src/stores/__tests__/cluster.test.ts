import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useClusterStore } from '@/stores/cluster'
import { useGraphStore } from '@/stores/graph'

function setupGraphForCluster() {
  const graphStore = useGraphStore()
  graphStore.nodes = [
    { node_id: 'n1', node_type: 'Person' },
    { node_id: 'n2', node_type: 'Person' },
    { node_id: 'n3', node_type: 'Company' },
    { node_id: 'n4', node_type: 'Company' },
  ]
  graphStore.edges = [
    { edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'KNOWS' },
    { edge_id: 'e2', src: 'n1', dst: 'n3', relationship_type: 'WORKS_AT' },
    { edge_id: 'e3', src: 'n3', dst: 'n4', relationship_type: 'PARTNER' },
  ]
  return graphStore
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('cluster store', () => {
  // ==========================================================================
  // Initialization
  // ==========================================================================

  describe('initialization', () => {
    it('creates two default programs on init', () => {
      const store = useClusterStore()
      expect(store.programs).toHaveLength(2)
    })

    it('default programs have fixed IDs', () => {
      const store = useClusterStore()
      const ids = store.programs.map(p => p.program_id)
      expect(ids).toContain('default-orphan-clusters')
      expect(ids).toContain('default-group-by-node-type')
    })
  })

  // ==========================================================================
  // Program CRUD
  // ==========================================================================

  describe('program CRUD', () => {
    it('createProgram adds to programs array', () => {
      const store = useClusterStore()
      const initial = store.programs.length
      store.createProgram({
        program_name: 'Custom',
        code: 'return []',
      })
      expect(store.programs).toHaveLength(initial + 1)
    })

    it('createProgram uses provided program_id if given', () => {
      const store = useClusterStore()
      const prog = store.createProgram({
        program_id: 'my-custom-id',
        program_name: 'Custom',
        code: 'return []',
      })
      expect(prog.program_id).toBe('my-custom-id')
    })

    it('updateProgram modifies existing program', () => {
      const store = useClusterStore()
      const prog = store.createProgram({
        program_name: 'Original',
        code: 'return []',
      })
      const result = store.updateProgram(prog.program_id, { program_name: 'Updated' })
      expect(result).toBe(true)
      expect(store.getProgram(prog.program_id)!.program_name).toBe('Updated')
    })

    it('updateProgram returns false for nonexistent', () => {
      const store = useClusterStore()
      expect(store.updateProgram('nonexistent', { program_name: 'x' })).toBe(false)
    })

    it('deleteProgram removes program and its execution history', () => {
      const store = useClusterStore()
      const prog = store.createProgram({
        program_name: 'ToDelete',
        code: 'return []',
      })
      const result = store.deleteProgram(prog.program_id)
      expect(result).toBe(true)
      expect(store.getProgram(prog.program_id)).toBeUndefined()
    })

    it('deleteProgram returns false for nonexistent', () => {
      const store = useClusterStore()
      expect(store.deleteProgram('nonexistent')).toBe(false)
    })

    it('getProgram returns program by ID', () => {
      const store = useClusterStore()
      const prog = store.createProgram({
        program_name: 'Find Me',
        code: 'return []',
      })
      expect(store.getProgram(prog.program_id)!.program_name).toBe('Find Me')
    })
  })

  // ==========================================================================
  // executeProgram
  // ==========================================================================

  describe('executeProgram', () => {
    it('successful execution creates clusters', async () => {
      setupGraphForCluster()
      const store = useClusterStore()
      const prog = store.createProgram({
        program_name: 'Test',
        code: `
          return [{
            cluster_name: 'MyCluster',
            cluster_class: 'test',
            figure: 'circle',
            state: 'closed',
            node_ids: ['n1', 'n2'],
          }]
        `,
      })

      const result = await store.executeProgram(prog.program_id)
      expect(result.success).toBe(true)
      expect(result.clusters).toHaveLength(1)
      expect(store.clusters.some(c => c.cluster_name === 'MyCluster')).toBe(true)
    })

    it('merge preserves clusters from other programs', async () => {
      setupGraphForCluster()
      const store = useClusterStore()

      // Create and execute first program
      const prog1 = store.createProgram({
        program_name: 'Prog1',
        code: `return [{ cluster_name: 'C1', node_ids: ['n1'] }]`,
      })
      await store.executeProgram(prog1.program_id)

      // Create and execute second program
      const prog2 = store.createProgram({
        program_name: 'Prog2',
        code: `return [{ cluster_name: 'C2', node_ids: ['n2'] }]`,
      })
      await store.executeProgram(prog2.program_id)

      // Both clusters should exist
      expect(store.clusters.some(c => c.cluster_name === 'C1')).toBe(true)
      expect(store.clusters.some(c => c.cluster_name === 'C2')).toBe(true)
    })

    it('re-execution replaces previous clusters from same program', async () => {
      setupGraphForCluster()
      const store = useClusterStore()

      const prog = store.createProgram({
        program_name: 'Evolving',
        code: `return [{ cluster_name: 'V1', node_ids: ['n1'] }]`,
      })
      await store.executeProgram(prog.program_id)
      expect(store.clusters.some(c => c.cluster_name === 'V1')).toBe(true)

      // Update code and re-execute
      store.updateProgram(prog.program_id, {
        code: `return [{ cluster_name: 'V2', node_ids: ['n2'] }]`,
      })
      await store.executeProgram(prog.program_id)

      expect(store.clusters.some(c => c.cluster_name === 'V1')).toBe(false)
      expect(store.clusters.some(c => c.cluster_name === 'V2')).toBe(true)
    })

    it('execution failure records error in history', async () => {
      setupGraphForCluster()
      const store = useClusterStore()
      const prog = store.createProgram({
        program_name: 'Broken',
        code: 'throw new Error("test error")',
      })

      const result = await store.executeProgram(prog.program_id)
      expect(result.success).toBe(false)
      expect(result.error).toContain('test error')

      const history = store.getExecutionHistory(prog.program_id)
      expect(history[0].error).toContain('test error')
    })

    it('validates cluster_name required', async () => {
      setupGraphForCluster()
      const store = useClusterStore()
      const prog = store.createProgram({
        program_name: 'Bad',
        code: `return [{ node_ids: ['n1'] }]`,
      })

      const result = await store.executeProgram(prog.program_id)
      expect(result.success).toBe(false)
      expect(result.error).toContain('cluster_name')
    })

    it('validates node_ids must be array', async () => {
      setupGraphForCluster()
      const store = useClusterStore()
      const prog = store.createProgram({
        program_name: 'Bad',
        code: `return [{ cluster_name: 'X', node_ids: 'not-array' }]`,
      })

      const result = await store.executeProgram(prog.program_id)
      expect(result.success).toBe(false)
      expect(result.error).toContain('node_ids must be an array')
    })

    it('validates node_ids reference existing nodes', async () => {
      setupGraphForCluster()
      const store = useClusterStore()
      const prog = store.createProgram({
        program_name: 'Bad',
        code: `return [{ cluster_name: 'X', node_ids: ['nonexistent'] }]`,
      })

      const result = await store.executeProgram(prog.program_id)
      expect(result.success).toBe(false)
      expect(result.error).toContain('invalid node_ids')
    })

    it('validates figure must be valid', async () => {
      setupGraphForCluster()
      const store = useClusterStore()
      const prog = store.createProgram({
        program_name: 'Bad',
        code: `return [{ cluster_name: 'X', node_ids: ['n1'], figure: 'triangle' }]`,
      })

      const result = await store.executeProgram(prog.program_id)
      expect(result.success).toBe(false)
      expect(result.error).toContain('invalid figure')
    })

    it('validates state must be open or closed', async () => {
      setupGraphForCluster()
      const store = useClusterStore()
      const prog = store.createProgram({
        program_name: 'Bad',
        code: `return [{ cluster_name: 'X', node_ids: ['n1'], state: 'invalid' }]`,
      })

      const result = await store.executeProgram(prog.program_id)
      expect(result.success).toBe(false)
      expect(result.error).toContain('invalid state')
    })

    it('returns error for nonexistent program', async () => {
      const store = useClusterStore()
      const result = await store.executeProgram('nonexistent')
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })
  })

  // ==========================================================================
  // Cluster Actions
  // ==========================================================================

  describe('cluster actions', () => {
    it('createCluster adds cluster manually', () => {
      const store = useClusterStore()
      const cluster = store.createCluster({
        cluster_name: 'Manual',
        cluster_class: 'test',
        figure: 'circle',
        state: 'open',
        node_ids: ['n1', 'n2'],
      })
      expect(cluster.cluster_id).toBe('Manual') // uses cluster_name when no ID
      expect(store.clusters.some(c => c.cluster_id === 'Manual')).toBe(true)
    })

    it('createCluster uses cluster_id when provided', () => {
      const store = useClusterStore()
      const cluster = store.createCluster({
        cluster_id: 'custom-id',
        cluster_name: 'Manual',
        cluster_class: 'test',
        figure: 'circle',
        state: 'open',
        node_ids: ['n1'],
      })
      expect(cluster.cluster_id).toBe('custom-id')
    })

    it('toggleClusterState flips open<->closed', () => {
      const store = useClusterStore()
      store.createCluster({
        cluster_id: 'toggle-me',
        cluster_name: 'Toggle',
        cluster_class: 'test',
        figure: 'circle',
        state: 'open',
        node_ids: ['n1'],
      })
      store.toggleClusterState('toggle-me')
      expect(store.clusters.find(c => c.cluster_id === 'toggle-me')!.state).toBe('closed')
      store.toggleClusterState('toggle-me')
      expect(store.clusters.find(c => c.cluster_id === 'toggle-me')!.state).toBe('open')
    })

    it('deleteCluster removes specific cluster', () => {
      const store = useClusterStore()
      store.createCluster({
        cluster_id: 'del',
        cluster_name: 'Del',
        cluster_class: 'test',
        figure: 'circle',
        state: 'open',
        node_ids: [],
      })
      expect(store.deleteCluster('del')).toBe(true)
      expect(store.clusters.find(c => c.cluster_id === 'del')).toBeUndefined()
    })

    it('clearClusters empties clusters array', () => {
      const store = useClusterStore()
      store.createCluster({
        cluster_name: 'X',
        cluster_class: 'test',
        figure: 'circle',
        state: 'open',
        node_ids: [],
      })
      store.clearClusters()
      expect(store.clusters).toHaveLength(0)
    })
  })

  // ==========================================================================
  // Computed Properties
  // ==========================================================================

  describe('computed properties', () => {
    it('openClusters filters by state=open', () => {
      const store = useClusterStore()
      store.createCluster({ cluster_id: 'a', cluster_name: 'A', cluster_class: 'x', figure: 'circle', state: 'open', node_ids: [] })
      store.createCluster({ cluster_id: 'b', cluster_name: 'B', cluster_class: 'x', figure: 'circle', state: 'closed', node_ids: [] })
      expect(store.openClusters).toHaveLength(1)
      expect(store.openClusters[0].cluster_id).toBe('a')
    })

    it('closedClusters filters by state=closed', () => {
      const store = useClusterStore()
      store.createCluster({ cluster_id: 'a', cluster_name: 'A', cluster_class: 'x', figure: 'circle', state: 'open', node_ids: [] })
      store.createCluster({ cluster_id: 'b', cluster_name: 'B', cluster_class: 'x', figure: 'circle', state: 'closed', node_ids: [] })
      expect(store.closedClusters).toHaveLength(1)
      expect(store.closedClusters[0].cluster_id).toBe('b')
    })

    it('nodeToClosedClusters maps nodes to their closed cluster IDs', () => {
      const store = useClusterStore()
      store.createCluster({ cluster_id: 'c1', cluster_name: 'C1', cluster_class: 'x', figure: 'circle', state: 'closed', node_ids: ['n1', 'n2'] })
      const map = store.nodeToClosedClusters
      expect(map.get('n1')).toEqual(['c1'])
      expect(map.get('n2')).toEqual(['c1'])
      expect(map.has('n3')).toBe(false)
    })

    it('visibleNodeIds: all visible when no closed clusters', () => {
      setupGraphForCluster()
      const store = useClusterStore()
      expect(store.visibleNodeIds.size).toBe(4)
    })

    it('visibleNodeIds: nodes in closed cluster hidden', () => {
      setupGraphForCluster()
      const store = useClusterStore()
      store.createCluster({ cluster_id: 'c1', cluster_name: 'C1', cluster_class: 'x', figure: 'circle', state: 'closed', node_ids: ['n1', 'n2'] })
      expect(store.visibleNodeIds.has('n1')).toBe(false)
      expect(store.visibleNodeIds.has('n2')).toBe(false)
      expect(store.visibleNodeIds.has('n3')).toBe(true)
    })

    it('visibleNodeIds: node in both open and closed cluster stays visible', () => {
      setupGraphForCluster()
      const store = useClusterStore()
      store.createCluster({ cluster_id: 'c1', cluster_name: 'Closed', cluster_class: 'x', figure: 'circle', state: 'closed', node_ids: ['n1'] })
      store.createCluster({ cluster_id: 'c2', cluster_name: 'Open', cluster_class: 'x', figure: 'circle', state: 'open', node_ids: ['n1'] })
      expect(store.visibleNodeIds.has('n1')).toBe(true)
    })

    it('clusterStats computes correctly', () => {
      const store = useClusterStore()
      store.createCluster({ cluster_id: 'a', cluster_name: 'A', cluster_class: 'x', figure: 'circle', state: 'open', node_ids: ['n1', 'n2'] })
      store.createCluster({ cluster_id: 'b', cluster_name: 'B', cluster_class: 'y', figure: 'circle', state: 'closed', node_ids: ['n3'] })
      const stats = store.clusterStats
      expect(stats.total).toBe(2)
      expect(stats.open).toBe(1)
      expect(stats.closed).toBe(1)
      expect(stats.totalNodes).toBe(3)
      expect(stats.avgNodesPerCluster).toBe(2) // Math.round(3/2)
    })
  })

  // ==========================================================================
  // Persistence
  // ==========================================================================

  describe('persistence', () => {
    it('getState returns programs, clusters, executions', () => {
      const store = useClusterStore()
      const state = store.getState()
      expect(state.programs).toBeDefined()
      expect(state.clusters).toBeDefined()
      expect(state.executions).toBeDefined()
    })

    it('loadState restores from provided state', () => {
      const store = useClusterStore()
      store.loadState({
        programs: [{ program_id: 'p1', program_name: 'P', code: '', created_at: '', updated_at: '' }],
        clusters: [{ cluster_id: 'c1', cluster_name: 'C', cluster_class: 'x', figure: 'circle', state: 'open', node_ids: [] }],
        executions: [],
      })
      expect(store.programs).toHaveLength(1)
      expect(store.clusters).toHaveLength(1)
    })

    it('loadState with null resets to empty', () => {
      const store = useClusterStore()
      store.createCluster({ cluster_name: 'X', cluster_class: 'x', figure: 'circle', state: 'open', node_ids: [] })
      store.loadState(null)
      expect(store.clusters).toHaveLength(0)
      expect(store.programs).toHaveLength(0)
    })
  })

  // ==========================================================================
  // Utility
  // ==========================================================================

  describe('utility', () => {
    it('isNodeInCluster returns true for clustered node', () => {
      const store = useClusterStore()
      store.createCluster({ cluster_id: 'c1', cluster_name: 'C', cluster_class: 'x', figure: 'circle', state: 'open', node_ids: ['n1'] })
      expect(store.isNodeInCluster('n1')).toBe(true)
      expect(store.isNodeInCluster('n99')).toBe(false)
    })

    it('getClustersForNode returns all clusters containing node', () => {
      const store = useClusterStore()
      store.createCluster({ cluster_id: 'c1', cluster_name: 'C1', cluster_class: 'x', figure: 'circle', state: 'open', node_ids: ['n1'] })
      store.createCluster({ cluster_id: 'c2', cluster_name: 'C2', cluster_class: 'x', figure: 'circle', state: 'closed', node_ids: ['n1'] })
      expect(store.getClustersForNode('n1')).toHaveLength(2)
    })
  })
})
