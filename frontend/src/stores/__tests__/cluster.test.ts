import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useClusterStore, isDefaultProgramId } from '@/stores/cluster'
import { useGraphStore } from '@/stores/graph'
import { api } from '@/services/api'
import type { GraphContext } from '@/types/graph'
import type { ClusterProgram } from '@/types/cluster'

function makeContext(overrides: Partial<GraphContext> = {}): GraphContext {
  return {
    id: 'ctx-1',
    title: 'Test context',
    tags: [],
    edge_table_name: 'edges',
    node_table_name: 'nodes',
    edge_structure: {
      edge_id_col: 'edge_id',
      src_col: 'src',
      dst_col: 'dst',
      relationship_type_col: 'relationship_type',
    },
    node_structure: { node_id_col: 'node_id', node_type_col: 'node_type' },
    edge_properties: [],
    node_properties: [],
    node_types: [],
    relationship_types: [],
    owner_email: 'a@b.com',
    shared_with: [],
    has_write_access: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as GraphContext
}

function makeContextProgram(id: string, overrides: Partial<ClusterProgram> = {}): ClusterProgram {
  return {
    program_id: id,
    program_name: `Program ${id}`,
    code: 'return []',
    scope: 'context',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

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
    it('creates three default programs on init', () => {
      const store = useClusterStore()
      expect(store.programs).toHaveLength(3)
    })

    it('default programs have fixed IDs', () => {
      const store = useClusterStore()
      const ids = store.programs.map(p => p.program_id)
      expect(ids).toContain('default-orphan-clusters')
      expect(ids).toContain('default-group-by-node-type')
      expect(ids).toContain('default-bfs-from-node')
    })

    it('BFS default program declares start_node_id, depth, allow_types and group_by_level params', () => {
      const store = useClusterStore()
      const bfs = store.getProgram('default-bfs-from-node')!
      const paramIds = bfs.parameters!.map(p => p.id)
      expect(paramIds).toEqual(['start_node_id', 'depth', 'allow_types', 'group_by_level'])

      const depth = bfs.parameters!.find(p => p.id === 'depth')!
      expect(depth.type).toBe('select')
      expect(depth.options).toEqual(['1', '2', '3'])
      expect(depth.default).toBe('3')

      expect(bfs.parameters!.find(p => p.id === 'start_node_id')!.required).toBe(true)
      expect(bfs.parameters!.find(p => p.id === 'allow_types')!.required).toBe(false)
    })

    it('BFS default program is context-menu enabled with start_node_id bound to node_id', () => {
      const store = useClusterStore()
      const bfs = store.getProgram('default-bfs-from-node')!
      expect(bfs.show_in_context_menu).toBe(true)
      expect(bfs.parameters!.find(p => p.id === 'start_node_id')!.node_binding).toBe('node_id')
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

    it('createProgram persists show_in_context_menu', () => {
      const store = useClusterStore()
      const prog = store.createProgram({
        program_name: 'Menu Enabled',
        code: 'return []',
        show_in_context_menu: true,
      })
      expect(store.getProgram(prog.program_id)!.show_in_context_menu).toBe(true)
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
  // computeClustersFromProgram (pure, non-mutating)
  // ==========================================================================

  describe('computeClustersFromProgram', () => {
    it('returns clusters WITHOUT mutating the store', () => {
      setupGraphForCluster()
      const store = useClusterStore()
      const prog = store.createProgram({
        program_name: 'Pure',
        code: `return [{ cluster_name: 'C', node_ids: ['n1', 'n2'] }]`,
      })

      const result = store.computeClustersFromProgram(prog.program_id)

      expect(result.success).toBe(true)
      expect(result.clusters).toHaveLength(1)
      expect(result.clusters?.[0].cluster_name).toBe('C')
      // No side effects: clusters and executions untouched
      expect(store.clusters).toHaveLength(0)
      expect(store.getExecutionHistory(prog.program_id)).toHaveLength(0)
    })

    it('tags returned clusters with source_program_id', () => {
      setupGraphForCluster()
      const store = useClusterStore()
      const prog = store.createProgram({
        program_name: 'Tagged',
        code: `return [{ cluster_name: 'C', node_ids: ['n1'] }]`,
      })

      const result = store.computeClustersFromProgram(prog.program_id)
      expect(result.clusters?.[0].source_program_id).toBe(prog.program_id)
    })

    it('returns failure (not throw) on invalid output, without mutating', () => {
      setupGraphForCluster()
      const store = useClusterStore()
      const prog = store.createProgram({
        program_name: 'Bad',
        code: `return [{ node_ids: ['n1'] }]`,
      })

      const result = store.computeClustersFromProgram(prog.program_id)
      expect(result.success).toBe(false)
      expect(result.error).toContain('cluster_name')
      expect(store.clusters).toHaveLength(0)
    })

    it('returns error for nonexistent program', () => {
      const store = useClusterStore()
      const result = store.computeClustersFromProgram('nonexistent')
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })
  })

  // ==========================================================================
  // Program parameters
  // ==========================================================================

  describe('program parameters', () => {
    function createParamProgram(store: ReturnType<typeof useClusterStore>) {
      // Names the cluster after params so tests can assert the injected values
      return store.createProgram({
        program_name: 'Parameterized',
        code: `return [{ cluster_name: 'prefix-' + params.suffix + '-' + params.count, node_ids: ['n1'] }]`,
        parameters: [
          { id: 'suffix', type: 'text', default: 'default', required: true },
          { id: 'count', type: 'number', default: 1, required: true },
        ],
      })
    }

    it('injects provided param values into the code as params.<id>', () => {
      setupGraphForCluster()
      const store = useClusterStore()
      const prog = createParamProgram(store)

      const result = store.computeClustersFromProgram(prog.program_id, {
        suffix: 'custom',
        count: 7,
      })
      expect(result.success).toBe(true)
      expect(result.clusters?.[0].cluster_name).toBe('prefix-custom-7')
    })

    it('number params arrive as real numbers (not strings)', () => {
      setupGraphForCluster()
      const store = useClusterStore()
      const prog = store.createProgram({
        program_name: 'TypeCheck',
        code: `return [{ cluster_name: typeof params.count, node_ids: ['n1'] }]`,
        parameters: [{ id: 'count', type: 'number', default: 1, required: true }],
      })

      const result = store.computeClustersFromProgram(prog.program_id, { count: '5' })
      expect(result.clusters?.[0].cluster_name).toBe('number')
    })

    it('uses declared defaults when no values passed', () => {
      setupGraphForCluster()
      const store = useClusterStore()
      const prog = createParamProgram(store)

      const result = store.computeClustersFromProgram(prog.program_id)
      expect(result.success).toBe(true)
      expect(result.clusters?.[0].cluster_name).toBe('prefix-default-1')
    })

    it('fails without throwing when a required param has no value or default', () => {
      setupGraphForCluster()
      const store = useClusterStore()
      const prog = store.createProgram({
        program_name: 'MissingReq',
        code: `return []`,
        parameters: [{ id: 'req', type: 'text', required: true }],
      })

      const result = store.computeClustersFromProgram(prog.program_id)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Missing required parameter: req')
      expect(store.clusters).toHaveLength(0)
    })

    it('executeProgram records params_used in the execution history', async () => {
      setupGraphForCluster()
      const store = useClusterStore()
      const prog = createParamProgram(store)

      await store.executeProgram(prog.program_id, { suffix: 'x', count: 2 })
      const history = store.getExecutionHistory(prog.program_id)
      expect(history[0].params_used).toEqual({ suffix: 'x', count: 2 })
    })

    it('executeProgram without values leaves params_used undefined', async () => {
      setupGraphForCluster()
      const store = useClusterStore()
      const prog = createParamProgram(store)

      await store.executeProgram(prog.program_id)
      const history = store.getExecutionHistory(prog.program_id)
      expect(history[0].params_used).toBeUndefined()
    })

    it('parameters round-trip through getState/loadState', () => {
      const store = useClusterStore()
      // No current context → the program is exploration-scoped and thus
      // included in getState / restored by loadState.
      const prog = store.createProgram({
        program_name: 'Persisted',
        code: 'return []',
        parameters: [{ id: 'p', type: 'select', options: ['a', 'b'], default: 'a', required: false }],
      })

      const state = store.getState()
      store.loadState(null)
      // Exploration-scoped program dropped; built-in defaults survive
      expect(store.getProgram(prog.program_id)).toBeUndefined()
      expect(store.programs).toHaveLength(3)

      store.loadState(state)
      const restored = store.getProgram(prog.program_id)
      expect(restored?.parameters).toEqual([
        { id: 'p', type: 'select', options: ['a', 'b'], default: 'a', required: false },
      ])
    })

    describe('default BFS program', () => {
      // Graph: n1(Person)—n2(Person), n1—n3(Company), n3—n4(Company)

      it('returns a SINGLE cluster with root + reached nodes by default', () => {
        setupGraphForCluster()
        const store = useClusterStore()

        const result = store.computeClustersFromProgram('default-bfs-from-node', {
          start_node_id: 'n1',
          depth: '2',
        })

        expect(result.success).toBe(true)
        expect(result.clusters).toHaveLength(1)
        const cluster = result.clusters![0]
        expect(cluster.cluster_name).toBe('BFS from n1')
        expect(new Set(cluster.node_ids)).toEqual(new Set(['n1', 'n2', 'n3', 'n4']))
      })

      it('group_by_level=true clusters nodes by BFS level (start + one ring per depth)', () => {
        setupGraphForCluster()
        const store = useClusterStore()

        const result = store.computeClustersFromProgram('default-bfs-from-node', {
          start_node_id: 'n1',
          depth: '2',
          group_by_level: true,
        })

        expect(result.success).toBe(true)
        const clusters = result.clusters!
        expect(clusters.map(c => c.cluster_name)).toEqual([
          'BFS start: n1',
          'BFS depth 1',
          'BFS depth 2',
        ])
        expect(clusters[0].node_ids).toEqual(['n1'])
        expect(new Set(clusters[1].node_ids)).toEqual(new Set(['n2', 'n3']))
        expect(clusters[2].node_ids).toEqual(['n4'])
      })

      it('depth 1 stops after the first level', () => {
        setupGraphForCluster()
        const store = useClusterStore()

        const result = store.computeClustersFromProgram('default-bfs-from-node', {
          start_node_id: 'n1',
          depth: '1',
        })

        expect(result.clusters).toHaveLength(1)
        const ids = result.clusters![0].node_ids
        expect(new Set(ids)).toEqual(new Set(['n1', 'n2', 'n3']))
        expect(ids).not.toContain('n4')
      })

      it('uses the default depth (3) when not provided', () => {
        setupGraphForCluster()
        const store = useClusterStore()

        const result = store.computeClustersFromProgram('default-bfs-from-node', {
          start_node_id: 'n1',
        })

        expect(result.success).toBe(true)
        // Depth 3 reaches everything
        const allIds = result.clusters!.flatMap(c => c.node_ids)
        expect(new Set(allIds)).toEqual(new Set(['n1', 'n2', 'n3', 'n4']))
      })

      it('allow list drops node types not listed (and does not traverse through them)', () => {
        setupGraphForCluster()
        const store = useClusterStore()

        const result = store.computeClustersFromProgram('default-bfs-from-node', {
          start_node_id: 'n1',
          depth: '3',
          allow_types: 'Person',
        })

        expect(result.success).toBe(true)
        const allIds = result.clusters!.flatMap(c => c.node_ids)
        // n3 (Company) dropped; n4 unreachable because traversal can't pass through n3
        expect(new Set(allIds)).toEqual(new Set(['n1', 'n2']))
      })

      it('empty allow list allows all types', () => {
        setupGraphForCluster()
        const store = useClusterStore()

        const result = store.computeClustersFromProgram('default-bfs-from-node', {
          start_node_id: 'n1',
          depth: '3',
          allow_types: '',
        })

        const allIds = result.clusters!.flatMap(c => c.node_ids)
        expect(new Set(allIds)).toEqual(new Set(['n1', 'n2', 'n3', 'n4']))
      })

      it('fails without a start_node_id (required param)', () => {
        setupGraphForCluster()
        const store = useClusterStore()

        const result = store.computeClustersFromProgram('default-bfs-from-node', { depth: '2' })
        expect(result.success).toBe(false)
        expect(result.error).toContain('Missing required parameter: start_node_id')
      })

      it('fails with a clear error when the start node does not exist', () => {
        setupGraphForCluster()
        const store = useClusterStore()

        const result = store.computeClustersFromProgram('default-bfs-from-node', {
          start_node_id: 'ghost',
          depth: '1',
        })
        expect(result.success).toBe(false)
        expect(result.error).toContain('Start node "ghost" not found')
      })
    })

    it('legacy programs without parameters still execute (params = {})', () => {
      setupGraphForCluster()
      const store = useClusterStore()
      // Simulates an old exploration state: program with no `parameters` field
      store.loadState({
        programs: [{
          program_id: 'legacy',
          program_name: 'Legacy',
          code: `return [{ cluster_name: Object.keys(params).length + '-params', node_ids: ['n1'] }]`,
          created_at: '',
          updated_at: '',
        }],
        clusters: [],
        executions: [],
      })

      const result = store.computeClustersFromProgram('legacy')
      expect(result.success).toBe(true)
      expect(result.clusters?.[0].cluster_name).toBe('0-params')
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

    it('loadState merges saved programs without dropping the defaults', () => {
      const store = useClusterStore()
      store.loadState({
        programs: [{ program_id: 'p1', program_name: 'P', code: '', created_at: '', updated_at: '' }],
        clusters: [{ cluster_id: 'c1', cluster_name: 'C', cluster_class: 'x', figure: 'circle', state: 'open', node_ids: [] }],
        executions: [],
      })
      // 3 built-in defaults + the imported legacy program
      expect(store.programs).toHaveLength(4)
      expect(store.getProgram('p1')).toBeDefined()
      expect(store.clusters).toHaveLength(1)
    })

    it('loadState with null clears clusters but keeps default programs', () => {
      const store = useClusterStore()
      store.createCluster({ cluster_name: 'X', cluster_class: 'x', figure: 'circle', state: 'open', node_ids: [] })
      store.loadState(null)
      expect(store.clusters).toHaveLength(0)
      expect(store.programs).toHaveLength(3)
    })
  })

  // ==========================================================================
  // Context-level program persistence
  // ==========================================================================

  describe('context-level program persistence', () => {
    function spyOnUpdate() {
      return vi
        .spyOn(api, 'updateGraphContext')
        .mockImplementation(async (_id, data) =>
          makeContext({ cluster_programs: data.cluster_programs as ClusterProgram[] })
        )
    }
    let updateSpy: ReturnType<typeof spyOnUpdate>

    beforeEach(() => {
      vi.useFakeTimers()
      updateSpy = spyOnUpdate()
    })

    afterEach(() => {
      vi.runOnlyPendingTimers()
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    async function flushDebounce(store: ReturnType<typeof useClusterStore>) {
      await vi.runAllTimersAsync()
      await store.flushPersist()
    }

    it('isDefaultProgramId recognizes the three built-ins', () => {
      expect(isDefaultProgramId('default-orphan-clusters')).toBe(true)
      expect(isDefaultProgramId('default-group-by-node-type')).toBe(true)
      expect(isDefaultProgramId('default-bfs-from-node')).toBe(true)
      expect(isDefaultProgramId('my-program')).toBe(false)
    })

    it('createProgram defaults to context scope when the context is writable', () => {
      useGraphStore().currentContext = makeContext()
      const store = useClusterStore()
      const prog = store.createProgram({ program_name: 'P', code: 'return []' })
      expect(prog.scope).toBe('context')
    })

    it('createProgram defaults to exploration scope without context write access', () => {
      useGraphStore().currentContext = makeContext({ has_write_access: false })
      const store = useClusterStore()
      const prog = store.createProgram({ program_name: 'P', code: 'return []' })
      expect(prog.scope).toBe('exploration')
    })

    it('creating a context-scoped program persists it (defaults filtered out)', async () => {
      useGraphStore().currentContext = makeContext()
      const store = useClusterStore()
      store.createProgram({ program_name: 'P', code: 'return []' })

      await flushDebounce(store)

      expect(updateSpy).toHaveBeenCalledTimes(1)
      const [ctxId, payload] = updateSpy.mock.calls[0]
      expect(ctxId).toBe('ctx-1')
      const sent = payload.cluster_programs as ClusterProgram[]
      expect(sent).toHaveLength(1)
      expect(sent[0].program_name).toBe('P')
      expect(sent.some(p => isDefaultProgramId(p.program_id))).toBe(false)
    })

    it('creating an exploration-scoped program does NOT persist to the context', async () => {
      useGraphStore().currentContext = makeContext()
      const store = useClusterStore()
      store.createProgram({ program_name: 'P', code: 'return []', scope: 'exploration' })

      await flushDebounce(store)
      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('deleting a context-scoped program persists the removal', async () => {
      useGraphStore().currentContext = makeContext()
      const store = useClusterStore()
      const prog = store.createProgram({ program_name: 'P', code: 'return []' })
      await flushDebounce(store)
      updateSpy.mockClear()

      store.deleteProgram(prog.program_id)
      await flushDebounce(store)

      expect(updateSpy).toHaveBeenCalledTimes(1)
      expect(updateSpy.mock.calls[0][1].cluster_programs).toHaveLength(0)
    })

    it('deleteProgram refuses to delete a built-in default', () => {
      const store = useClusterStore()
      expect(store.deleteProgram('default-bfs-from-node')).toBe(false)
      expect(store.getProgram('default-bfs-from-node')).toBeDefined()
      expect(store.error).toBe('Default programs cannot be deleted')
    })

    it('no persist without a current context', async () => {
      const store = useClusterStore()
      store.createProgram({ program_name: 'P', code: 'return []', scope: 'context' })
      await flushDebounce(store)
      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('no persist when the context is read-only', async () => {
      useGraphStore().currentContext = makeContext({ has_write_access: false })
      const store = useClusterStore()
      store.createProgram({ program_name: 'P', code: 'return []', scope: 'context' })
      await flushDebounce(store)
      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('hydrateProgramsFromContext seeds defaults + context programs (no persist)', async () => {
      useGraphStore().currentContext = makeContext()
      const store = useClusterStore()

      store.hydrateProgramsFromContext([makeContextProgram('cp-1')])

      expect(store.programs).toHaveLength(4)
      expect(store.getProgram('cp-1')?.scope).toBe('context')

      await flushDebounce(store)
      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('hydrateProgramsFromContext replaces the previous set (no cross-context leakage)', () => {
      const store = useClusterStore()
      store.hydrateProgramsFromContext([makeContextProgram('cp-old')])
      store.hydrateProgramsFromContext([makeContextProgram('cp-new')])

      expect(store.getProgram('cp-old')).toBeUndefined()
      expect(store.getProgram('cp-new')).toBeDefined()
    })

    it('a context program colliding with a default id replaces the built-in', () => {
      const store = useClusterStore()
      store.hydrateProgramsFromContext([
        makeContextProgram('default-bfs-from-node', { program_name: 'Custom BFS' }),
      ])
      expect(store.programs).toHaveLength(3)
      expect(store.getProgram('default-bfs-from-node')?.program_name).toBe('Custom BFS')
    })

    it('clearAll rebuilds defaults + current context programs', () => {
      useGraphStore().currentContext = makeContext({
        cluster_programs: [makeContextProgram('cp-1')],
      })
      const store = useClusterStore()
      store.createProgram({ program_name: 'Session-only', code: '', scope: 'exploration' })

      store.clearAll()

      expect(store.getProgram('cp-1')).toBeDefined()
      expect(store.programs).toHaveLength(4)
    })

    it('loadState imports legacy programs into the context and persists once', async () => {
      useGraphStore().currentContext = makeContext()
      const store = useClusterStore()

      store.loadState({
        programs: [
          { program_id: 'legacy-1', program_name: 'Legacy', code: '', created_at: '', updated_at: '' },
        ],
        clusters: [],
        executions: [],
      })

      expect(store.getProgram('legacy-1')?.scope).toBe('context')

      await flushDebounce(store)
      expect(updateSpy).toHaveBeenCalledTimes(1)
      const sent = updateSpy.mock.calls[0][1].cluster_programs as ClusterProgram[]
      expect(sent.map(p => p.program_id)).toEqual(['legacy-1'])
    })

    it('loadState keeps legacy programs exploration-local when context is read-only', async () => {
      useGraphStore().currentContext = makeContext({ has_write_access: false })
      const store = useClusterStore()

      store.loadState({
        programs: [
          { program_id: 'legacy-1', program_name: 'Legacy', code: '', created_at: '', updated_at: '' },
        ],
        clusters: [],
        executions: [],
      })

      expect(store.getProgram('legacy-1')?.scope).toBe('exploration')
      await flushDebounce(store)
      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('loadState skips a saved program whose id already exists (context wins)', () => {
      const store = useClusterStore()
      store.hydrateProgramsFromContext([makeContextProgram('cp-1', { program_name: 'Context copy' })])

      store.loadState({
        programs: [
          { program_id: 'cp-1', program_name: 'Stale copy', code: '', created_at: '', updated_at: '' },
        ],
        clusters: [],
        executions: [],
      })

      expect(store.getProgram('cp-1')?.program_name).toBe('Context copy')
    })

    it('loadState replaces the previous exploration-scoped programs', () => {
      const store = useClusterStore()
      store.createProgram({ program_name: 'Old exp', code: '', scope: 'exploration', program_id: 'exp-old' })

      store.loadState({
        programs: [
          { program_id: 'exp-new', program_name: 'New exp', code: '', scope: 'exploration', created_at: '', updated_at: '' },
        ],
        clusters: [],
        executions: [],
      })

      expect(store.getProgram('exp-old')).toBeUndefined()
      expect(store.getProgram('exp-new')).toBeDefined()
    })

    it('getState only includes exploration-scoped programs', () => {
      useGraphStore().currentContext = makeContext()
      const store = useClusterStore()
      store.createProgram({ program_name: 'Ctx', code: '', scope: 'context' })
      store.createProgram({ program_name: 'Exp', code: '', scope: 'exploration' })

      const state = store.getState()
      expect(state.programs).toHaveLength(1)
      expect(state.programs[0].program_name).toBe('Exp')
    })

    it('changing scope from exploration to context persists it', async () => {
      useGraphStore().currentContext = makeContext()
      const store = useClusterStore()
      const prog = store.createProgram({ program_name: 'P', code: '', scope: 'exploration' })
      await flushDebounce(store)
      expect(updateSpy).not.toHaveBeenCalled()

      store.updateProgram(prog.program_id, { scope: 'context' })
      await flushDebounce(store)

      expect(updateSpy).toHaveBeenCalledTimes(1)
      const sent = updateSpy.mock.calls[0][1].cluster_programs as ClusterProgram[]
      expect(sent.map(p => p.program_id)).toEqual([prog.program_id])
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
