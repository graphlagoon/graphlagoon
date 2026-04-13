import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'
import { useSimilarityStore } from '@/stores/similarity'

// Mock API (needed by graph store)
vi.mock('@/services/api', () => ({
  api: {
    getSimilarityEndpoints: vi.fn(),
    computeSimilarity: vi.fn(),
    getExploration: vi.fn(),
    getExplorationSnapshot: vi.fn(),
  },
}))

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

function injectSimilarityEdges() {
  const simStore = useSimilarityStore()
  simStore.similarityEdges = [
    { source: 'A', target: 'C', score: 0.9 },
    { source: 'B', target: 'C', score: 0.7 },
  ]
  simStore.injectEdges()
  return simStore
}

beforeEach(() => {
  setActivePinia(createPinia())
})

// ---------------------------------------------------------------------------
// filteredEdges with similarity displayMode
// ---------------------------------------------------------------------------

describe('filteredEdges with similarity displayMode', () => {
  it('overlay: shows all edges including similarity', () => {
    setupGraph()
    const simStore = injectSimilarityEdges()
    simStore.displayMode = 'overlay'

    const graphStore = useGraphStore()
    expect(graphStore.filteredEdges).toHaveLength(4) // 2 original + 2 similarity
    const types = graphStore.filteredEdges.map(e => e.relationship_type)
    expect(types).toContain('KNOWS')
    expect(types).toContain('WORKS_AT')
    expect(types).toContain('__similarity__')
  })

  it('exclusive: shows only similarity edges', () => {
    setupGraph()
    const simStore = injectSimilarityEdges()
    simStore.displayMode = 'exclusive'

    const graphStore = useGraphStore()
    expect(graphStore.filteredEdges).toHaveLength(2)
    expect(graphStore.filteredEdges.every(e => e.relationship_type === '__similarity__')).toBe(true)
  })

  it('hidden: hides similarity edges, keeps originals', () => {
    setupGraph()
    const simStore = injectSimilarityEdges()
    simStore.displayMode = 'hidden'

    const graphStore = useGraphStore()
    expect(graphStore.filteredEdges).toHaveLength(2)
    expect(graphStore.filteredEdges.every(e => e.relationship_type !== '__similarity__')).toBe(true)
  })

  it('no similarity results: displayMode has no effect', () => {
    setupGraph()
    const simStore = useSimilarityStore()
    simStore.displayMode = 'exclusive'

    const graphStore = useGraphStore()
    // hasResults is false → no filtering applied
    expect(graphStore.filteredEdges).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// edgeTypes includes __similarity__ when present
// ---------------------------------------------------------------------------

describe('edgeTypes', () => {
  it('includes __similarity__ after injection', () => {
    setupGraph()
    injectSimilarityEdges()

    const graphStore = useGraphStore()
    expect(graphStore.edgeTypes).toContain('__similarity__')
    expect(graphStore.edgeTypes).toContain('KNOWS')
    expect(graphStore.edgeTypes).toContain('WORKS_AT')
  })

  it('does not include __similarity__ without injection', () => {
    setupGraph()
    const graphStore = useGraphStore()
    expect(graphStore.edgeTypes).not.toContain('__similarity__')
  })
})

// ---------------------------------------------------------------------------
// getExplorationState includes similarity
// ---------------------------------------------------------------------------

describe('getExplorationState', () => {
  it('includes similarity state when results exist', () => {
    setupGraph()
    const simStore = injectSimilarityEdges()
    simStore.selectedEndpoint = 'cosine'
    simStore.displayMode = 'exclusive'

    const graphStore = useGraphStore()
    const state = graphStore.getExplorationState()

    expect(state.similarity).toBeDefined()
    expect(state.similarity!.similarityEdges).toHaveLength(2)
    expect(state.similarity!.selectedEndpoint).toBe('cosine')
    expect(state.similarity!.displayMode).toBe('exclusive')
  })

  it('similarity is undefined when no results', () => {
    setupGraph()
    const graphStore = useGraphStore()
    const state = graphStore.getExplorationState()
    expect(state.similarity).toBeUndefined()
  })
})
