import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'
import { useCommunityStore } from '@/stores/community'

// Mock api service
vi.mock('@/services/api', () => ({
  api: {
    getGraphContext: vi.fn(),
    getSubgraph: vi.fn(),
    expandFromNode: vi.fn(),
    executeGraphQuery: vi.fn(),
    executeCypherQuery: vi.fn(),
    submitGraphQueryJob: vi.fn(),
    submitCypherQueryJob: vi.fn(),
    getGraphQueryJob: vi.fn(),
    cancelGraphQueryJob: vi.fn(),
    transpileCypher: vi.fn(),
    getExploration: vi.fn(),
    createExploration: vi.fn(),
    updateExploration: vi.fn(),
  },
}))

import { api } from '@/services/api'

/**
 * Mock the async graph-query flow so submit → poll returns `result`. Call
 * BEFORE invoking the store action. The store polls with a 300ms first tick,
 * so the test must `vi.useFakeTimers()` and `advanceTimersByTimeAsync` after.
 */
function mockGraphJobSucceeds(
  result: { nodes: any[]; edges: any[]; transpiled_sql?: string },
  jobId = 'job-1',
) {
  vi.mocked(api.submitGraphQueryJob).mockResolvedValue({
    status: 'running',
    job_id: jobId,
  } as any)
  vi.mocked(api.submitCypherQueryJob).mockResolvedValue({
    status: 'running',
    job_id: jobId,
    transpiled_sql: result.transpiled_sql,
  } as any)
  vi.mocked(api.getGraphQueryJob).mockResolvedValue({
    status: 'succeeded',
    job_id: jobId,
    result,
    transpiled_sql: result.transpiled_sql,
  } as any)
}

function setupGraph() {
  const store = useGraphStore()
  store.nodes = [
    { node_id: 'A', node_type: 'Person' },
    { node_id: 'B', node_type: 'Person' },
    { node_id: 'C', node_type: 'Company' },
  ]
  store.edges = [
    { edge_id: 'e1', src: 'A', dst: 'B', relationship_type: 'KNOWS' },
    { edge_id: 'e2', src: 'B', dst: 'C', relationship_type: 'WORKS_AT' },
  ]
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

// ============================================================================
// loadContext
// ============================================================================

describe('loadContext', () => {
  it('loads context from API and sets currentContext', async () => {
    const ctx = { id: 'ctx-1', title: 'Test Context' }
    vi.mocked(api.getGraphContext).mockResolvedValue(ctx as any)

    const store = useGraphStore()
    await store.loadContext('ctx-1')

    expect(api.getGraphContext).toHaveBeenCalledWith('ctx-1')
    expect(store.currentContext).toEqual(ctx)
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('sets error on API failure', async () => {
    vi.mocked(api.getGraphContext).mockRejectedValue(new Error('Network error'))

    const store = useGraphStore()
    await store.loadContext('ctx-1')

    expect(store.currentContext).toBeNull()
    expect(store.error).toBe('Network error')
    expect(store.loading).toBe(false)
  })
})

// ============================================================================
// loadSubgraph
// ============================================================================

describe('loadSubgraph', () => {
  it('skips when no currentContext', async () => {
    const store = useGraphStore()
    await store.loadSubgraph()

    expect(api.getSubgraph).not.toHaveBeenCalled()
  })

  it('loads subgraph and replaces nodes/edges', async () => {
    const store = setupGraph()
    store.currentContext = { id: 'ctx-1' } as any
    store.selectNode('A')

    vi.mocked(api.getSubgraph).mockResolvedValue({
      nodes: [{ node_id: 'X', node_type: 'T' }],
      edges: [],
    } as any)

    await store.loadSubgraph({ edge_limit: 500 })

    expect(api.getSubgraph).toHaveBeenCalledWith('ctx-1', {
      edge_limit: 500,
      node_types: [],
      edge_types: [],
    })
    expect(store.nodes).toHaveLength(1)
    expect(store.nodes[0].node_id).toBe('X')
    expect(store.selectedNodeIds.size).toBe(0)
  })

  it('sets queryError on failure', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any

    vi.mocked(api.getSubgraph).mockRejectedValue(new Error('Query failed'))

    await store.loadSubgraph()

    expect(store.queryError).not.toBeNull()
    expect(store.queryError!.message).toBe('Query failed')
  })
})

// ============================================================================
// expandFromNode
// ============================================================================

describe('expandFromNode', () => {
  it('merges new nodes and edges into existing graph', async () => {
    const store = setupGraph()
    store.currentContext = { id: 'ctx-1' } as any

    vi.mocked(api.expandFromNode).mockResolvedValue({
      nodes: [
        { node_id: 'A', node_type: 'Person' },  // duplicate, should be skipped
        { node_id: 'D', node_type: 'Location' }, // new
      ],
      edges: [
        { edge_id: 'e1', src: 'A', dst: 'B', relationship_type: 'KNOWS' }, // duplicate
        { edge_id: 'e3', src: 'A', dst: 'D', relationship_type: 'LIVES_IN' }, // new
      ],
    } as any)

    await store.expandFromNode('A', 2, [], 100)

    expect(store.nodes).toHaveLength(4) // A, B, C + D
    expect(store.edges).toHaveLength(3) // e1, e2 + e3
    expect(store.nodes.find(n => n.node_id === 'D')).toBeDefined()
    expect(store.edges.find(e => e.edge_id === 'e3')).toBeDefined()
  })

  it('skips when no currentContext', async () => {
    const store = useGraphStore()
    await store.expandFromNode('A')

    expect(api.expandFromNode).not.toHaveBeenCalled()
  })

  it('caps depth at 2 and edge_limit in range 4-1000', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any

    vi.mocked(api.expandFromNode).mockResolvedValue({ nodes: [], edges: [] } as any)

    await store.expandFromNode('A', 5, ['KNOWS'], 2, true)

    expect(api.expandFromNode).toHaveBeenCalledWith('ctx-1', {
      node_id: 'A',
      depth: 2,        // capped from 5
      edge_types: ['KNOWS'],
      edge_limit: 4,   // capped from 2 (min 4)
      directed: true,
    })
  })
})

// ============================================================================
// executeGraphQuery
// ============================================================================

describe('executeGraphQuery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('replaces graph with query results', async () => {
    const store = setupGraph()
    store.currentContext = { id: 'ctx-1' } as any

    mockGraphJobSucceeds({
      nodes: [{ node_id: 'Q1', node_type: 'Result' }],
      edges: [],
    })

    const p = store.executeGraphQuery('SELECT * FROM graph')
    await vi.advanceTimersByTimeAsync(400)
    await p

    expect(store.nodes).toHaveLength(1)
    expect(store.nodes[0].node_id).toBe('Q1')
    expect(store.graphQuery).toBe('SELECT * FROM graph')
  })

  it('preserveGraphQuery option keeps existing query', async () => {
    const store = setupGraph()
    store.currentContext = { id: 'ctx-1' } as any
    store.graphQuery = 'original query'

    mockGraphJobSucceeds({ nodes: [], edges: [] })

    const p = store.executeGraphQuery('new query', { preserveGraphQuery: true })
    await vi.advanceTimersByTimeAsync(400)
    await p

    expect(store.graphQuery).toBe('original query')
  })

  it('sets queryError with query on failure', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any

    // Submit rejects → error surfaces immediately (no polling).
    vi.mocked(api.submitGraphQueryJob).mockRejectedValue(new Error('Syntax error'))

    await store.executeGraphQuery('BAD QUERY')

    expect(store.queryError).not.toBeNull()
    expect(store.queryError!.query).toBe('BAD QUERY')
  })

  it('exposes chunk-download progress while the job is running', async () => {
    const store = setupGraph()
    store.currentContext = { id: 'ctx-1' } as any

    vi.mocked(api.submitGraphQueryJob).mockResolvedValue({
      status: 'running',
      job_id: 'job-x',
    } as any)
    // First poll: still downloading (2/5 chunks). Second: done.
    vi.mocked(api.getGraphQueryJob)
      .mockResolvedValueOnce({
        status: 'running',
        job_id: 'job-x',
        progress: { phase: 'edges', chunks_done: 2, chunks_total: 5 },
      } as any)
      .mockResolvedValueOnce({
        status: 'succeeded',
        job_id: 'job-x',
        result: { nodes: [], edges: [] },
      } as any)

    const p = store.executeGraphQuery('SELECT * FROM graph')
    await vi.advanceTimersByTimeAsync(400) // first poll → running + progress
    expect(store.queryChunkProgress).toEqual({ done: 2, total: 5 })
    expect(store.queryCanCancel).toBe(true)
    await vi.advanceTimersByTimeAsync(1300) // second poll → succeeded
    await p
    expect(store.queryCanCancel).toBe(false)
  })

  it('cancelGraphQuery cancels the in-flight job and stops the overlay', async () => {
    const store = setupGraph()
    store.currentContext = { id: 'ctx-1' } as any

    vi.mocked(api.submitGraphQueryJob).mockResolvedValue({
      status: 'running',
      job_id: 'job-c',
    } as any)
    vi.mocked(api.getGraphQueryJob).mockResolvedValue({
      status: 'running',
      job_id: 'job-c',
      progress: { phase: 'edges', chunks_done: 1, chunks_total: 8 },
    } as any)
    vi.mocked(api.cancelGraphQueryJob).mockResolvedValue(undefined as any)

    const p = store.executeGraphQuery('SELECT * FROM graph')
    await vi.advanceTimersByTimeAsync(400)
    expect(store.queryCanCancel).toBe(true)

    await store.cancelGraphQuery()

    expect(api.cancelGraphQueryJob).toHaveBeenCalledWith('ctx-1', 'job-c')
    expect(store.loading).toBe(false)
    expect(store.queryCanCancel).toBe(false)
    // Let the abandoned poll loop's pending sleep fire so run() unwinds.
    await vi.advanceTimersByTimeAsync(1300)
    await p
  })
})

// ============================================================================
// clear
// ============================================================================

describe('clear', () => {
  it('resets all graph state', () => {
    const store = setupGraph()
    store.currentContext = { id: 'ctx-1' } as any
    store.currentExploration = { id: 'exp-1' } as any
    store.selectNode('A')
    store.graphQuery = 'SELECT * FROM x'
    store.nodePositions.set('A', { x: 1, y: 2, pinned: true })

    store.clear()

    expect(store.nodes).toHaveLength(0)
    expect(store.edges).toHaveLength(0)
    expect(store.currentContext).toBeNull()
    expect(store.currentExploration).toBeNull()
    expect(store.selectedNodeIds.size).toBe(0)
    expect(store.selectedEdgeIds.size).toBe(0)
    expect(store.nodePositions.size).toBe(0)
    expect(store.graphQuery).toBe('')
  })
})

// ============================================================================
// Color management
// ============================================================================

describe('color management', () => {
  it('getNodeTypeColor returns palette color by type index', () => {
    const store = setupGraph()
    const color = store.getNodeTypeColor('Person')
    expect(color).toBeTruthy()
    expect(color.startsWith('#')).toBe(true)
  })

  it('setNodeTypeColor overrides palette', () => {
    const store = setupGraph()
    store.setNodeTypeColor('Person', '#123456')
    expect(store.getNodeTypeColor('Person')).toBe('#123456')
  })

  it('getEdgeTypeColor returns palette color', () => {
    const store = setupGraph()
    const color = store.getEdgeTypeColor('KNOWS')
    expect(color).toBeTruthy()
    expect(color.startsWith('#')).toBe(true)
  })

  it('setEdgeTypeColor overrides palette', () => {
    const store = setupGraph()
    store.setEdgeTypeColor('KNOWS', '#abcdef')
    expect(store.getEdgeTypeColor('KNOWS')).toBe('#abcdef')
  })

  it('resetTypeColors clears all custom colors', () => {
    const store = setupGraph()
    store.setNodeTypeColor('Person', '#111')
    store.setEdgeTypeColor('KNOWS', '#222')

    store.resetTypeColors()

    // After reset, should get palette colors (not custom)
    expect(store.getNodeTypeColor('Person')).not.toBe('#111')
    expect(store.getEdgeTypeColor('KNOWS')).not.toBe('#222')
  })
})

// ============================================================================
// Settings updates
// ============================================================================

describe('settings updates', () => {
  it('setLayoutAlgorithm updates layout', () => {
    const store = useGraphStore()
    store.setLayoutAlgorithm('circular')
    expect(store.layoutAlgorithm).toBe('circular')
  })

  it('updateBehaviors merges with existing', () => {
    const store = useGraphStore()
    const originalSearchMode = store.behaviors.searchMode
    store.updateBehaviors({ edgeLensMode: 'hide' })

    expect(store.behaviors.edgeLensMode).toBe('hide')
    expect(store.behaviors.searchMode).toBe(originalSearchMode)
  })

  it('updateAesthetics merges with existing', () => {
    const store = useGraphStore()
    store.updateAesthetics({ nodeSize: 20, edgeWidth: 3 })

    expect(store.aesthetics.nodeSize).toBe(20)
    expect(store.aesthetics.edgeWidth).toBe(3)
    expect(store.aesthetics.showArrows).toBe(true) // preserved
  })

  it('updateLayoutModeConfig merges per-mode partials', () => {
    const store = useGraphStore()
    store.updateLayoutModeConfig({ ego: { maxHops: 2 } })

    expect(store.layoutModeConfig.ego.maxHops).toBe(2)
    expect(store.layoutModeConfig.ego.direction).toBe('both') // preserved
    expect(store.layoutModeConfig.hive.axisKey).toBe('node_type') // untouched mode preserved
  })

  it('selecting a non-force layout disables community radial layout', () => {
    const store = useGraphStore()
    const communityStore = useCommunityStore()
    communityStore.radialLayoutEnabled = true

    store.setLayoutAlgorithm('ego')

    expect(communityStore.radialLayoutEnabled).toBe(false)
    expect(store.layoutAlgorithm).toBe('ego')
  })

  it('enabling community radial layout reverts the layout mode to force', async () => {
    const store = useGraphStore()
    const communityStore = useCommunityStore()
    store.setLayoutAlgorithm('hive')

    communityStore.radialLayoutEnabled = true
    await nextTick()

    expect(store.layoutAlgorithm).toBe('force')
    // No loop: radial stays enabled after the revert
    expect(communityStore.radialLayoutEnabled).toBe(true)
  })

  it('updateForce3DSettings merges with existing', () => {
    const store = useGraphStore()
    store.updateForce3DSettings({ d3ChargeStrength: -200 })

    expect(store.force3DSettings.d3ChargeStrength).toBe(-200)
    expect(store.force3DSettings.d3AlphaDecay).toBe(0.0228) // preserved
  })
})

// ============================================================================
// Node positions
// ============================================================================

describe('node positions', () => {
  it('updateNodePosition stores position', () => {
    const store = useGraphStore()
    store.updateNodePosition('A', 10, 20, true)

    const pos = store.nodePositions.get('A')
    expect(pos).toEqual({ x: 10, y: 20, pinned: true })
  })

  it('toggleNodePinned flips pinned state', () => {
    const store = useGraphStore()
    store.updateNodePosition('A', 10, 20, false)
    store.toggleNodePinned('A')

    expect(store.nodePositions.get('A')!.pinned).toBe(true)

    store.toggleNodePinned('A')
    expect(store.nodePositions.get('A')!.pinned).toBe(false)
  })
})

// ============================================================================
// Query error
// ============================================================================

describe('queryError', () => {
  it('clearQueryError resets to null', () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any

    vi.mocked(api.submitGraphQueryJob).mockRejectedValue(new Error('fail'))

    store.clearQueryError()
    expect(store.queryError).toBeNull()
  })

  it('extractErrorDetails handles Axios error with detail object', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any

    const axiosError = {
      response: {
        data: {
          detail: {
            error: {
              code: 'SYNTAX_ERROR',
              message: 'Invalid SQL',
              details: {
                query: 'BAD SQL',
                exception_type: 'SqlParseException',
                traceback: ['line 1', 'line 2'],
              },
            },
          },
        },
      },
    }
    vi.mocked(api.submitGraphQueryJob).mockRejectedValue(axiosError)

    await store.executeGraphQuery('BAD SQL')

    expect(store.queryError).toEqual({
      message: 'Invalid SQL',
      code: 'SYNTAX_ERROR',
      query: 'BAD SQL',
      exceptionType: 'SqlParseException',
      traceback: ['line 1', 'line 2'],
    })
  })

  it('extractErrorDetails handles Axios error with string detail', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any

    const axiosError = {
      response: { data: { detail: 'Something went wrong' } },
    }
    vi.mocked(api.submitGraphQueryJob).mockRejectedValue(axiosError)

    await store.executeGraphQuery('query')

    expect(store.queryError!.message).toBe('Something went wrong')
  })
})

// ============================================================================
// Filters actions
// ============================================================================

describe('filter actions', () => {
  it('applyFilters merges with existing filters', () => {
    const store = useGraphStore()
    store.applyFilters({ node_types: ['Person'] })
    store.applyFilters({ edge_types: ['KNOWS'] })

    expect(store.filters.node_types).toEqual(['Person'])
    expect(store.filters.edge_types).toEqual(['KNOWS'])
  })

  it('resetFilters clears all filters', () => {
    const store = useGraphStore()
    store.applyFilters({
      node_types: ['Person'],
      edge_types: ['KNOWS'],
      search_query: 'test',
    })
    store.addNodePropertyFilter({
      property: 'metric:deg',
      operator: 'greater_than',
      value: 1,
      enabled: true,
    })

    store.resetFilters()

    expect(store.filters.node_types).toEqual([])
    expect(store.filters.edge_types).toEqual([])
    expect(store.filters.search_query).toBeUndefined()
    expect(store.filters.nodePropertyFilters).toEqual([])
    expect(store.filters.edgePropertyFilters).toEqual([])
  })
})

// ============================================================================
// loadExploration — layout back-compat migration
// ============================================================================

describe('loadExploration layout migration', () => {
  function mockExploration(state: Record<string, unknown>) {
    vi.mocked(api.getExploration).mockResolvedValue({
      id: 'exp-1',
      graph_context_id: 'ctx-1',
      title: 'Test',
      owner_email: 'a@b.c',
      shared_with: [],
      has_write_access: true,
      state: {
        nodes: [],
        edges: [],
        filters: { node_types: [], edge_types: [], nodePropertyFilters: [], edgePropertyFilters: [] },
        viewport: { zoom: 1, center_x: 0, center_y: 0 },
        ...state,
      },
      created_at: '',
      updated_at: '',
    } as any)
  }

  it("migrates legacy 'force-atlas-2' to 'force'", async () => {
    const store = useGraphStore()
    mockExploration({ layout_algorithm: 'force-atlas-2' })

    await store.loadExploration('exp-1')

    expect(store.layoutAlgorithm).toBe('force')
  })

  it("defaults a missing layout_algorithm to 'force'", async () => {
    const store = useGraphStore()
    mockExploration({ layout_algorithm: undefined })

    await store.loadExploration('exp-1')

    expect(store.layoutAlgorithm).toBe('force')
  })

  it('restores a saved layout mode and merges its config over defaults', async () => {
    const store = useGraphStore()
    mockExploration({
      layout_algorithm: 'ego',
      layout_mode_config: { ego: { focusNodeId: 'acct-7', maxHops: 3 } },
    })

    await store.loadExploration('exp-1')

    expect(store.layoutAlgorithm).toBe('ego')
    expect(store.layoutModeConfig.ego.focusNodeId).toBe('acct-7')
    expect(store.layoutModeConfig.ego.maxHops).toBe(3)
    // Fields absent from the saved blob fall back to defaults
    expect(store.layoutModeConfig.ego.direction).toBe('both')
    expect(store.layoutModeConfig.hive.axisKey).toBe('node_type')
  })

  it('explorations without layout_mode_config get full defaults', async () => {
    const store = useGraphStore()
    store.updateLayoutModeConfig({ ego: { maxHops: 5 } }) // dirty state from a previous session
    mockExploration({ layout_algorithm: 'force' })

    await store.loadExploration('exp-1')

    expect(store.layoutModeConfig.ego.maxHops).toBeNull()
  })

  it('restores saved force3d_settings and merges them over defaults', async () => {
    const store = useGraphStore()
    mockExploration({
      force3d_settings: { d3ChargeStrength: -200, d3GravityStrength: 0.1 },
    })

    await store.loadExploration('exp-1')

    expect(store.force3DSettings.d3ChargeStrength).toBe(-200)
    expect(store.force3DSettings.d3GravityStrength).toBe(0.1)
    // Fields absent from the saved blob fall back to defaults
    expect(store.force3DSettings.d3LinkDistance).toBe(30)
  })

  it('explorations without force3d_settings get full defaults', async () => {
    const store = useGraphStore()
    store.updateForce3DSettings({ d3ChargeStrength: -999 }) // dirty state from a previous session
    mockExploration({})

    await store.loadExploration('exp-1')

    expect(store.force3DSettings.d3ChargeStrength).toBe(-80)
  })

  it('ignores corrupted or stale force3d_settings values', async () => {
    const store = useGraphStore()
    mockExploration({
      force3d_settings: {
        d3DistanceMax: null,     // Infinity serializes to null through JSON — must not reach d3-force
        d3LinkDistance: 'abc',   // wrong type
        someRemovedSetting: 123, // key no longer in the schema
        d3ChargeStrength: -200,  // valid value still applies
      },
    })

    await store.loadExploration('exp-1')

    expect(store.force3DSettings.d3DistanceMax).toBe(Infinity)
    expect(store.force3DSettings.d3LinkDistance).toBe(30)
    expect('someRemovedSetting' in store.force3DSettings).toBe(false)
    expect(store.force3DSettings.d3ChargeStrength).toBe(-200)
  })

  it('restores saved nodePropertyIconConfigs', async () => {
    const store = useGraphStore()
    mockExploration({
      nodePropertyIconConfigs: {
        Person: { property: 'role', valueIcons: { admin: 'shield' }, fallbackIcon: 'user' },
      },
    })

    await store.loadExploration('exp-1')

    expect(store.nodePropertyIconConfigs.get('Person')).toEqual({
      property: 'role',
      valueIcons: { admin: 'shield' },
      fallbackIcon: 'user',
    })
  })

  it('falls back to full defaults when force3d_settings is not an object', async () => {
    const store = useGraphStore()

    for (const corrupted of ['corrupted', 42, [1, 2, 3], true]) {
      store.updateForce3DSettings({ d3ChargeStrength: -999 }) // dirty state that must not survive
      mockExploration({ force3d_settings: corrupted })

      await store.loadExploration('exp-1')

      expect(store.force3DSettings.d3ChargeStrength).toBe(-80)
      expect(store.force3DSettings.d3DistanceMax).toBe(Infinity)
    }
  })
})
