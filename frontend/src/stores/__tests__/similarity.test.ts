import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSimilarityStore } from '@/stores/similarity'
import { useGraphStore } from '@/stores/graph'

// Mock API
vi.mock('@/services/api', () => ({
  api: {
    getSimilarityEndpoints: vi.fn(),
    computeSimilarity: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupGraphWithNodes() {
  const graphStore = useGraphStore()
  graphStore.nodes = [
    { node_id: 'n1', node_type: 'Person', properties: { name: 'Alice', data: '{"id": "x1"}' } },
    { node_id: 'n2', node_type: 'Person', properties: { name: 'Bob', data: '{"id": "x2"}' } },
    { node_id: 'n3', node_type: 'Company', properties: { name: 'Acme', data: '{"id": "x3"}' } },
    { node_id: 'n4', node_type: 'Person', properties: { name: '', data: '' } },
  ]
  graphStore.edges = [
    { edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'KNOWS' },
  ]
  return graphStore
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Key extraction
// ---------------------------------------------------------------------------

describe('extractKeys', () => {
  it('extracts node_id by default', () => {
    setupGraphWithNodes()
    const store = useSimilarityStore()
    const result = store.extractKeys()
    expect(result.keys).toEqual(['n1', 'n2', 'n3', 'n4'])
    expect(result.skipped).toBe(0)
    expect(result.total).toBe(4)
  })

  it('extracts a property value', () => {
    setupGraphWithNodes()
    const store = useSimilarityStore()
    store.keyProperty = 'name'
    const result = store.extractKeys()
    // n4 has empty name → skipped
    expect(result.keys).toEqual(['Alice', 'Bob', 'Acme'])
    expect(result.skipped).toBe(1)
  })

  it('filters by selected node type', () => {
    setupGraphWithNodes()
    const store = useSimilarityStore()
    store.selectedNodeType = 'Person'
    const result = store.extractKeys()
    expect(result.keys).toEqual(['n1', 'n2', 'n4'])
    expect(result.total).toBe(3)
  })

  it('skips nodes with missing property', () => {
    setupGraphWithNodes()
    const store = useSimilarityStore()
    store.keyProperty = 'nonexistent'
    const result = store.extractKeys()
    expect(result.keys).toEqual([])
    expect(result.skipped).toBe(4)
  })

  it('extracts from JSON string with path', () => {
    setupGraphWithNodes()
    const store = useSimilarityStore()
    store.keyProperty = 'data'
    store.isJsonString = true
    store.jsonPath = 'id'
    const result = store.extractKeys()
    // n4 has empty data → skipped
    expect(result.keys).toEqual(['x1', 'x2', 'x3'])
    expect(result.skipped).toBe(1)
  })

  it('handles invalid JSON gracefully', () => {
    const graphStore = useGraphStore()
    graphStore.nodes = [
      { node_id: 'n1', node_type: 'X', properties: { data: 'not json' } },
    ]
    const store = useSimilarityStore()
    store.keyProperty = 'data'
    store.isJsonString = true
    store.jsonPath = 'id'
    const result = store.extractKeys()
    expect(result.keys).toEqual([])
    expect(result.skipped).toBe(1)
  })

  it('handles nested JSON path', () => {
    const graphStore = useGraphStore()
    graphStore.nodes = [
      { node_id: 'n1', node_type: 'X', properties: { data: '{"a":{"b":"deep"}}' } },
    ]
    const store = useSimilarityStore()
    store.keyProperty = 'data'
    store.isJsonString = true
    store.jsonPath = 'a.b'
    const result = store.extractKeys()
    expect(result.keys).toEqual(['deep'])
  })
})

// ---------------------------------------------------------------------------
// Edge injection and removal
// ---------------------------------------------------------------------------

describe('injectEdges / removeEdges', () => {
  it('injects similarity edges into graph store', () => {
    const graphStore = setupGraphWithNodes()
    const store = useSimilarityStore()
    store.similarityEdges = [
      { source: 'n1', target: 'n2', score: 0.9 },
      { source: 'n2', target: 'n3', score: 0.7 },
    ]
    store.injectEdges()

    const simEdges = graphStore.edges.filter(
      e => e.relationship_type === '__similarity__'
    )
    expect(simEdges).toHaveLength(2)
    expect(simEdges[0].edge_id).toBe('sim__n1__n2')
    expect(simEdges[0].src).toBe('n1')
    expect(simEdges[0].dst).toBe('n2')
    expect(simEdges[0].properties?.score).toBe(0.9)
  })

  it('removeEdges clears only similarity edges', () => {
    const graphStore = setupGraphWithNodes()
    const store = useSimilarityStore()
    store.similarityEdges = [{ source: 'n1', target: 'n2', score: 0.5 }]
    store.injectEdges()

    expect(graphStore.edges).toHaveLength(2) // 1 original + 1 similarity

    store.removeEdges()
    expect(graphStore.edges).toHaveLength(1)
    expect(graphStore.edges[0].edge_id).toBe('e1')
  })

  it('injectEdges removes previous similarity edges first', () => {
    const graphStore = setupGraphWithNodes()
    const store = useSimilarityStore()

    store.similarityEdges = [{ source: 'n1', target: 'n2', score: 0.5 }]
    store.injectEdges()
    expect(graphStore.edges.filter(e => e.relationship_type === '__similarity__')).toHaveLength(1)

    store.similarityEdges = [
      { source: 'n1', target: 'n3', score: 0.8 },
      { source: 'n2', target: 'n3', score: 0.6 },
    ]
    store.injectEdges()
    const simEdges = graphStore.edges.filter(e => e.relationship_type === '__similarity__')
    expect(simEdges).toHaveLength(2)
    expect(simEdges[0].edge_id).toBe('sim__n1__n3')
  })
})

// ---------------------------------------------------------------------------
// clearSimilarity
// ---------------------------------------------------------------------------

describe('clearSimilarity', () => {
  it('removes edges and clears state', () => {
    const graphStore = setupGraphWithNodes()
    const store = useSimilarityStore()
    store.similarityEdges = [{ source: 'n1', target: 'n2', score: 0.5 }]
    store.injectEdges()
    store.error = 'some error'

    store.clearSimilarity()

    expect(store.similarityEdges).toEqual([])
    expect(store.error).toBeNull()
    expect(graphStore.edges.filter(e => e.relationship_type === '__similarity__')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Persistence (getState / loadState)
// ---------------------------------------------------------------------------

describe('persistence', () => {
  it('getState returns undefined when no results', () => {
    const store = useSimilarityStore()
    expect(store.getState()).toBeUndefined()
  })

  it('getState serializes full state', () => {
    const store = useSimilarityStore()
    store.similarityEdges = [{ source: 'a', target: 'b', score: 0.9 }]
    store.selectedEndpoint = 'cosine'
    store.selectedNodeType = 'Person'
    store.keyProperty = 'name'
    store.isJsonString = true
    store.jsonPath = 'id'
    store.displayMode = 'exclusive'
    store.layoutStrategy = 'fix-then-recompute'
    store.layoutEdgeType = '__similarity__'

    const state = store.getState()!
    expect(state.similarityEdges).toHaveLength(1)
    expect(state.selectedEndpoint).toBe('cosine')
    expect(state.selectedNodeType).toBe('Person')
    expect(state.keyProperty).toBe('name')
    expect(state.isJsonString).toBe(true)
    expect(state.jsonPath).toBe('id')
    expect(state.displayMode).toBe('exclusive')
    expect(state.layoutStrategy).toBe('fix-then-recompute')
    expect(state.layoutEdgeType).toBe('__similarity__')
  })

  it('loadState restores state and injects edges', () => {
    setupGraphWithNodes()
    const store = useSimilarityStore()

    store.loadState({
      similarityEdges: [{ source: 'n1', target: 'n2', score: 0.8 }],
      selectedEndpoint: 'knn',
      displayMode: 'hidden',
      keyProperty: 'name',
      isJsonString: false,
      jsonPath: '',
    })

    expect(store.similarityEdges).toHaveLength(1)
    expect(store.selectedEndpoint).toBe('knn')
    expect(store.displayMode).toBe('hidden')

    const graphStore = useGraphStore()
    const simEdges = graphStore.edges.filter(e => e.relationship_type === '__similarity__')
    expect(simEdges).toHaveLength(1)
  })

  it('loadState with undefined is a no-op', () => {
    const store = useSimilarityStore()
    store.loadState(undefined)
    expect(store.similarityEdges).toEqual([])
  })

  it('round-trip: getState → loadState preserves data', () => {
    setupGraphWithNodes()
    const store = useSimilarityStore()
    store.similarityEdges = [{ source: 'n1', target: 'n2', score: 0.5 }]
    store.selectedEndpoint = 'test'
    store.displayMode = 'exclusive'
    store.injectEdges()

    const saved = store.getState()!

    // Reset
    setActivePinia(createPinia())
    setupGraphWithNodes()
    const store2 = useSimilarityStore()
    store2.loadState(saved)

    expect(store2.similarityEdges).toHaveLength(1)
    expect(store2.selectedEndpoint).toBe('test')
    expect(store2.displayMode).toBe('exclusive')
  })
})

// ---------------------------------------------------------------------------
// Display mode (hasResults, resultStats)
// ---------------------------------------------------------------------------

describe('computed', () => {
  it('hasResults is false when empty', () => {
    const store = useSimilarityStore()
    expect(store.hasResults).toBe(false)
  })

  it('hasResults is true with edges', () => {
    const store = useSimilarityStore()
    store.similarityEdges = [{ source: 'a', target: 'b', score: 1 }]
    expect(store.hasResults).toBe(true)
  })

  it('resultStats counts unique nodes', () => {
    const store = useSimilarityStore()
    store.similarityEdges = [
      { source: 'a', target: 'b', score: 1 },
      { source: 'b', target: 'c', score: 0.5 },
    ]
    expect(store.resultStats).toEqual({ edgeCount: 2, nodeCount: 3 })
  })

  it('resultStats is null when no results', () => {
    const store = useSimilarityStore()
    expect(store.resultStats).toBeNull()
  })
})
