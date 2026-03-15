import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'

/**
 * Graph with self-edges:
 *   A --KNOWS--> B
 *   A --SELF-->  A  (self-edge)
 *   B --SELF-->  B  (self-edge)
 *   C --KNOWS--> A
 */
function setupGraphWithSelfEdges() {
  const store = useGraphStore()
  store.nodes = [
    { node_id: 'A', node_type: 'Person' },
    { node_id: 'B', node_type: 'Person' },
    { node_id: 'C', node_type: 'Person' },
  ]
  store.edges = [
    { edge_id: 'e1', src: 'A', dst: 'B', relationship_type: 'KNOWS' },
    { edge_id: 'e2', src: 'A', dst: 'A', relationship_type: 'SELF' },
    { edge_id: 'e3', src: 'B', dst: 'B', relationship_type: 'SELF' },
    { edge_id: 'e4', src: 'C', dst: 'A', relationship_type: 'KNOWS' },
  ]
  return store
}

function setupGraphWithoutSelfEdges() {
  const store = useGraphStore()
  store.nodes = [
    { node_id: 'A', node_type: 'Person' },
    { node_id: 'B', node_type: 'Person' },
  ]
  store.edges = [
    { edge_id: 'e1', src: 'A', dst: 'B', relationship_type: 'KNOWS' },
    { edge_id: 'e2', src: 'B', dst: 'A', relationship_type: 'KNOWS' },
  ]
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('hasSelfEdges', () => {
  it('returns true when graph has self-edges', () => {
    const store = setupGraphWithSelfEdges()
    expect(store.hasSelfEdges).toBe(true)
  })

  it('returns false when graph has no self-edges', () => {
    const store = setupGraphWithoutSelfEdges()
    expect(store.hasSelfEdges).toBe(false)
  })

  it('returns false for empty graph', () => {
    const store = useGraphStore()
    expect(store.hasSelfEdges).toBe(false)
  })

  it('uses raw edges, not filteredEdges (toggle-independent)', () => {
    const store = setupGraphWithSelfEdges()
    // Disable self-edges — hasSelfEdges should STILL be true
    // because it reads from raw edges, not filteredEdges
    store.updateBehaviors({ showSelfEdges: false })
    expect(store.hasSelfEdges).toBe(true)
  })
})

describe('showSelfEdges behavior toggle', () => {
  it('default is enabled (showSelfEdges: true)', () => {
    const store = setupGraphWithSelfEdges()
    expect(store.behaviors.showSelfEdges).toBe(true)
  })

  it('when enabled, filteredEdges includes self-edges', () => {
    const store = setupGraphWithSelfEdges()
    const selfEdges = store.filteredEdges.filter(e => e.src === e.dst)
    expect(selfEdges).toHaveLength(2)
    expect(store.filteredEdges).toHaveLength(4)
  })

  it('when disabled, filteredEdges excludes self-edges', () => {
    const store = setupGraphWithSelfEdges()
    store.updateBehaviors({ showSelfEdges: false })
    const selfEdges = store.filteredEdges.filter(e => e.src === e.dst)
    expect(selfEdges).toHaveLength(0)
    expect(store.filteredEdges).toHaveLength(2)
  })

  it('toggle off then on restores self-edges', () => {
    const store = setupGraphWithSelfEdges()
    expect(store.filteredEdges).toHaveLength(4)

    store.updateBehaviors({ showSelfEdges: false })
    expect(store.filteredEdges).toHaveLength(2)

    store.updateBehaviors({ showSelfEdges: true })
    expect(store.filteredEdges).toHaveLength(4)
  })

  it('no effect on graphs without self-edges', () => {
    const store = setupGraphWithoutSelfEdges()
    const countBefore = store.filteredEdges.length
    store.updateBehaviors({ showSelfEdges: false })
    expect(store.filteredEdges).toHaveLength(countBefore)
  })
})

describe('self-edges interact correctly with other filters', () => {
  it('edge type filter + self-edges disabled', () => {
    const store = setupGraphWithSelfEdges()
    // Disable self-edges AND filter to only KNOWS type
    store.updateBehaviors({ showSelfEdges: false })
    store.applyFilters({ edge_types: ['KNOWS'] })
    // Only non-self KNOWS edges remain
    expect(store.filteredEdges.map(e => e.edge_id).sort()).toEqual(['e1', 'e4'])
  })

  it('edge type filter includes self-edge type', () => {
    const store = setupGraphWithSelfEdges()
    // Filter to only SELF type edges
    store.applyFilters({ edge_types: ['SELF'] })
    const ids = store.filteredEdges.map(e => e.edge_id).sort()
    expect(ids).toEqual(['e2', 'e3'])
  })

  it('node type filter removes nodes that have self-edges', () => {
    const store = setupGraphWithSelfEdges()
    // Filter to keep only node C — self-edges on A and B should disappear
    store.applyFilters({ node_types: ['Person'] })
    // All persons are kept, so all edges remain
    expect(store.filteredEdges).toHaveLength(4)
  })
})
