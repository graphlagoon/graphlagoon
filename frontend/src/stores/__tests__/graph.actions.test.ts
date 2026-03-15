import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'

// Mock api service
vi.mock('@/services/api', () => ({
  api: {
    getGraphContext: vi.fn(),
    getSubgraph: vi.fn(),
    expandFromNode: vi.fn(),
    executeGraphQuery: vi.fn(),
    executeCypherQuery: vi.fn(),
    transpileCypher: vi.fn(),
    getExploration: vi.fn(),
    createExploration: vi.fn(),
    updateExploration: vi.fn(),
  },
}))

import { api } from '@/services/api'

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
  it('replaces graph with query results', async () => {
    const store = setupGraph()
    store.currentContext = { id: 'ctx-1' } as any

    vi.mocked(api.executeGraphQuery).mockResolvedValue({
      nodes: [{ node_id: 'Q1', node_type: 'Result' }],
      edges: [],
    } as any)

    await store.executeGraphQuery('SELECT * FROM graph')

    expect(store.nodes).toHaveLength(1)
    expect(store.nodes[0].node_id).toBe('Q1')
    expect(store.graphQuery).toBe('SELECT * FROM graph')
  })

  it('preserveGraphQuery option keeps existing query', async () => {
    const store = setupGraph()
    store.currentContext = { id: 'ctx-1' } as any
    store.graphQuery = 'original query'

    vi.mocked(api.executeGraphQuery).mockResolvedValue({
      nodes: [], edges: [],
    } as any)

    await store.executeGraphQuery('new query', { preserveGraphQuery: true })

    expect(store.graphQuery).toBe('original query')
  })

  it('sets queryError with query on failure', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any

    vi.mocked(api.executeGraphQuery).mockRejectedValue(new Error('Syntax error'))

    await store.executeGraphQuery('BAD QUERY')

    expect(store.queryError).not.toBeNull()
    expect(store.queryError!.query).toBe('BAD QUERY')
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

  it('updateFA2Settings merges with existing', () => {
    const store = useGraphStore()
    store.updateFA2Settings({ gravity: 5 })

    expect(store.fa2Settings.gravity).toBe(5)
    expect(store.fa2Settings.scalingRatio).toBe(2) // preserved
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

    vi.mocked(api.executeGraphQuery).mockRejectedValue(new Error('fail'))

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
    vi.mocked(api.executeGraphQuery).mockRejectedValue(axiosError)

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
    vi.mocked(api.executeGraphQuery).mockRejectedValue(axiosError)

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
