import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'


// Simple test graph:
//   A(Person) --KNOWS--> B(Person) --KNOWS--> C(Company) --WORKS_AT--> D(Company)
//   A --WORKS_AT--> C
function setupGraph() {
  const store = useGraphStore()
  store.nodes = [
    { node_id: 'A', node_type: 'Person' },
    { node_id: 'B', node_type: 'Person' },
    { node_id: 'C', node_type: 'Company' },
    { node_id: 'D', node_type: 'Company' },
  ]
  store.edges = [
    { edge_id: 'e1', src: 'A', dst: 'B', relationship_type: 'KNOWS' },
    { edge_id: 'e2', src: 'B', dst: 'C', relationship_type: 'KNOWS' },
    { edge_id: 'e3', src: 'C', dst: 'D', relationship_type: 'WORKS_AT' },
    { edge_id: 'e4', src: 'A', dst: 'C', relationship_type: 'WORKS_AT' },
  ]
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
})

// ============================================================================
// filteredNodes
// ============================================================================

describe('filteredNodes', () => {
  describe('node type filtering', () => {
    it('with no type filters, returns all nodes', () => {
      const store = setupGraph()
      expect(store.filteredNodes).toHaveLength(4)
    })

    it('filters to only specified node types', () => {
      const store = setupGraph()
      store.applyFilters({ node_types: ['Person'] })
      expect(store.filteredNodes.map(n => n.node_id)).toEqual(['A', 'B'])
    })

    it('multiple types in filter: union of matches', () => {
      const store = setupGraph()
      store.applyFilters({ node_types: ['Person', 'Company'] })
      expect(store.filteredNodes).toHaveLength(4)
    })

    it('empty nodes array returns empty', () => {
      const store = useGraphStore()
      expect(store.filteredNodes).toHaveLength(0)
    })
  })

  describe('search filtering (hide mode)', () => {
    it('with no search query, returns all nodes', () => {
      const store = setupGraph()
      expect(store.filteredNodes).toHaveLength(4)
    })

    it('in hide mode: hides non-matching nodes', () => {
      const store = setupGraph()
      store.updateBehaviors({ searchMode: 'hide' })
      store.applyFilters({ search_query: 'Person' })
      expect(store.filteredNodes.map(n => n.node_id)).toEqual(['A', 'B'])
    })

    it('search matches node_id (case insensitive)', () => {
      const store = setupGraph()
      store.updateBehaviors({ searchMode: 'hide' })
      store.applyFilters({ search_query: 'a' })
      expect(store.filteredNodes.some(n => n.node_id === 'A')).toBe(true)
    })

    it('search matches node_type (case insensitive)', () => {
      const store = setupGraph()
      store.updateBehaviors({ searchMode: 'hide' })
      store.applyFilters({ search_query: 'company' })
      expect(store.filteredNodes.map(n => n.node_id)).toEqual(['C', 'D'])
    })

    it('if search has zero matches, keeps all nodes', () => {
      const store = setupGraph()
      store.updateBehaviors({ searchMode: 'hide' })
      store.applyFilters({ search_query: 'ZZZZNOTFOUND' })
      // When no nodes match, all are kept (line 473-475)
      expect(store.filteredNodes).toHaveLength(4)
    })

    it('in highlight mode: no filtering applied', () => {
      const store = setupGraph()
      store.updateBehaviors({ searchMode: 'highlight' })
      store.applyFilters({ search_query: 'Person' })
      expect(store.filteredNodes).toHaveLength(4)
    })
  })

  describe('focus filtering (visual only, not in filteredNodes)', () => {
    // Note: focus filtering is handled visually in GraphCanvas3D (hidden flag / alpha encoding)
    // filteredNodes always returns all nodes regardless of graph lens mode.
    // focusedNodeIds computed provides the BFS neighborhood for visual use.

    it('filteredNodes unaffected by edgeLensMode hide', () => {
      const store = setupGraph()
      store.updateBehaviors({ edgeLensMode: 'hide', focusDepth: 1 })
      store.selectNode('A')
      // All nodes stay in filteredNodes — visual hiding is done in GraphCanvas3D
      expect(store.filteredNodes).toHaveLength(4)
    })

    it('filteredNodes unaffected by edgeLensMode dim', () => {
      const store = setupGraph()
      store.updateBehaviors({ edgeLensMode: 'dim', focusDepth: 1 })
      store.selectNode('A')
      expect(store.filteredNodes).toHaveLength(4)
    })

    it('focusedNodeIds returns null when edgeLensMode is off', () => {
      const store = setupGraph()
      store.updateBehaviors({ edgeLensMode: 'off' })
      store.selectNode('A')
      expect(store.focusedNodeIds).toBeNull()
    })

    it('focusedNodeIds returns null when no nodes selected or hovered', () => {
      const store = setupGraph()
      store.updateBehaviors({ edgeLensMode: 'hide' })
      expect(store.focusedNodeIds).toBeNull()
    })

    it('focusedNodeIds depth=1: selected node and direct neighbors', () => {
      const store = setupGraph()
      store.updateBehaviors({ edgeLensMode: 'hide', focusDepth: 1 })
      store.selectNode('A')
      const focused = store.focusedNodeIds!
      // A's neighbors: B (via e1), C (via e4)
      expect(focused.has('A')).toBe(true)
      expect(focused.has('B')).toBe(true)
      expect(focused.has('C')).toBe(true)
      expect(focused.has('D')).toBe(false)
    })

    it('focusedNodeIds depth=2: 2-hop neighborhood', () => {
      const store = setupGraph()
      store.updateBehaviors({ edgeLensMode: 'hide', focusDepth: 2 })
      store.selectNode('A')
      const focused = store.focusedNodeIds!
      // A's 2-hop: A->B->C->D, A->C->D
      expect(focused.has('A')).toBe(true)
      expect(focused.has('B')).toBe(true)
      expect(focused.has('C')).toBe(true)
      expect(focused.has('D')).toBe(true)
    })

    it('focusedNodeIds follows edges bidirectionally', () => {
      const store = setupGraph()
      store.updateBehaviors({ edgeLensMode: 'hide', focusDepth: 1 })
      store.selectNode('B')
      const focused = store.focusedNodeIds!
      // B's neighbors: A (src of e1), C (dst of e2)
      expect(focused.has('A')).toBe(true)
      expect(focused.has('B')).toBe(true)
      expect(focused.has('C')).toBe(true)
      expect(focused.has('D')).toBe(false)
    })

    it('focusedNodeIds includes hovered node neighborhood', () => {
      const store = setupGraph()
      store.updateBehaviors({ edgeLensMode: 'dim', focusDepth: 1 })
      store.hoveredNodeId = 'A'
      // A's neighbors: B, C
      const focused = store.focusedNodeIds!
      expect(focused.has('A')).toBe(true)
      expect(focused.has('B')).toBe(true)
      expect(focused.has('C')).toBe(true)
      expect(focused.has('D')).toBe(false)
    })
  })

  describe('pipeline composition', () => {
    it('type filter + search filter applied in sequence', () => {
      const store = setupGraph()
      store.updateBehaviors({ searchMode: 'hide' })
      // First filter to Person nodes, then search for 'A'
      store.applyFilters({ node_types: ['Person'], search_query: 'A' })
      expect(store.filteredNodes.map(n => n.node_id)).toEqual(['A'])
    })

    it('type filter works, focus filter is visual-only', () => {
      const store = setupGraph()
      store.updateBehaviors({ edgeLensMode: 'hide', focusDepth: 1 })
      store.applyFilters({ node_types: ['Person'] })
      store.selectNode('A')
      // Type filter: A, B (Persons only)
      // Focus filter is NOT applied in filteredNodes (visual-only in GraphCanvas3D)
      expect(store.filteredNodes.map(n => n.node_id).sort()).toEqual(['A', 'B'])
    })
  })
})

// ============================================================================
// filteredEdges
// ============================================================================

describe('filteredEdges', () => {
  it('only includes edges where BOTH src and dst are in filteredNodes', () => {
    const store = setupGraph()
    store.applyFilters({ node_types: ['Person'] })
    // Only Person nodes: A, B. Only edge between them: e1
    expect(store.filteredEdges.map(e => e.edge_id)).toEqual(['e1'])
  })

  it('edge type filter works independently', () => {
    const store = setupGraph()
    store.applyFilters({ edge_types: ['KNOWS'] })
    expect(store.filteredEdges.map(e => e.edge_id).sort()).toEqual(['e1', 'e2'])
  })

  it('combined node type + edge type filtering', () => {
    const store = setupGraph()
    // Person nodes only, but keep only WORKS_AT edges
    store.applyFilters({ node_types: ['Person'], edge_types: ['WORKS_AT'] })
    // Person nodes: A, B. No WORKS_AT edges between two Person nodes.
    expect(store.filteredEdges).toHaveLength(0)
  })
})

// ============================================================================
// multiEdgeStats
// ============================================================================

describe('multiEdgeStats', () => {
  it('detects no multi-edges in simple graph', () => {
    const store = setupGraph()
    expect(store.multiEdgeStats.hasMultiEdges).toBe(false)
  })

  it('detects multi-edges (same src->dst pair)', () => {
    const store = useGraphStore()
    store.nodes = [
      { node_id: 'X', node_type: 'T' },
      { node_id: 'Y', node_type: 'T' },
    ]
    store.edges = [
      { edge_id: 'e1', src: 'X', dst: 'Y', relationship_type: 'A' },
      { edge_id: 'e2', src: 'X', dst: 'Y', relationship_type: 'B' },
    ]
    expect(store.multiEdgeStats.hasMultiEdges).toBe(true)
    expect(store.multiEdgeStats.multiEdgePairCount).toBe(1)
    expect(store.multiEdgeStats.totalMultiEdges).toBe(2)
  })

  it('directed: A->B and B->A are NOT counted as multi-edge', () => {
    const store = useGraphStore()
    store.nodes = [
      { node_id: 'X', node_type: 'T' },
      { node_id: 'Y', node_type: 'T' },
    ]
    store.edges = [
      { edge_id: 'e1', src: 'X', dst: 'Y', relationship_type: 'A' },
      { edge_id: 'e2', src: 'Y', dst: 'X', relationship_type: 'A' },
    ]
    expect(store.multiEdgeStats.hasMultiEdges).toBe(false)
  })
})

// ============================================================================
// searchMatchedNodeIds / searchHiddenNodeIds
// ============================================================================

describe('searchMatchedNodeIds', () => {
  it('returns null when no search query', () => {
    const store = setupGraph()
    expect(store.searchMatchedNodeIds).toBeNull()
  })

  it('returns Set of matching node IDs', () => {
    const store = setupGraph()
    store.applyFilters({ search_query: 'Person' })
    expect(store.searchMatchedNodeIds).not.toBeNull()
    expect(store.searchMatchedNodeIds!.has('A')).toBe(true)
    expect(store.searchMatchedNodeIds!.has('B')).toBe(true)
    expect(store.searchMatchedNodeIds!.has('C')).toBe(false)
  })
})

describe('searchHiddenNodeIds', () => {
  it('returns null when no search query', () => {
    const store = setupGraph()
    expect(store.searchHiddenNodeIds).toBeNull()
  })

  it('returns null in highlight mode', () => {
    const store = setupGraph()
    store.updateBehaviors({ searchMode: 'highlight' })
    store.applyFilters({ search_query: 'Person' })
    expect(store.searchHiddenNodeIds).toBeNull()
  })

  it('returns non-matched node IDs in hide mode', () => {
    const store = setupGraph()
    store.updateBehaviors({ searchMode: 'hide' })
    store.applyFilters({ search_query: 'Person' })
    expect(store.searchHiddenNodeIds).not.toBeNull()
    expect(store.searchHiddenNodeIds!.has('C')).toBe(true)
    expect(store.searchHiddenNodeIds!.has('D')).toBe(true)
    expect(store.searchHiddenNodeIds!.has('A')).toBe(false)
  })
})

// ============================================================================
// Search reactivity contract (large-graph freeze regression)
// ============================================================================

// A search keystroke in 'highlight' mode (the default) must NOT invalidate
// filteredNodes/filteredEdges: on 200k+ graphs their recompute cascades into an
// O(n+m) proxy scan and a full 3D graph rebuild per keystroke (UI freeze).
// With a type filter active, filteredNodes returns a fresh array on each
// recompute — so cached-vs-recomputed is observable via array identity.
describe('search reactivity: highlight mode keeps filtered chain cached', () => {
  it('search_query change does not recompute filteredNodes in highlight mode', () => {
    const store = setupGraph()
    store.updateBehaviors({ searchMode: 'highlight' })
    store.applyFilters({ node_types: ['Person'] })
    const before = store.filteredNodes
    store.applyFilters({ search_query: 'A' })
    expect(store.filteredNodes).toBe(before) // same ref = computed stayed cached
  })

  it('search_query change does not recompute filteredEdges in highlight mode', () => {
    const store = setupGraph()
    store.updateBehaviors({ searchMode: 'highlight' })
    store.applyFilters({ edge_types: ['KNOWS'] })
    // Warm-up read: the first-ever evaluation lazily creates useSimilarityStore()
    // inside the computed, whose reactive writes make the very next cold read
    // re-evaluate regardless of filters. In the app this computed always has
    // subscribers (canvas/metrics watchers), so steady-state is what matters.
    store.filteredEdges
    const before = store.filteredEdges
    store.applyFilters({ search_query: 'A' })
    expect(store.filteredEdges).toBe(before)
  })

  it('search_query change DOES recompute filteredNodes in hide mode', () => {
    const store = setupGraph()
    store.updateBehaviors({ searchMode: 'hide' })
    store.applyFilters({ node_types: ['Person', 'Company'] })
    const before = store.filteredNodes
    store.applyFilters({ search_query: 'Person' })
    expect(store.filteredNodes).not.toBe(before)
    expect(store.filteredNodes.map(n => n.node_id)).toEqual(['A', 'B'])
  })

  it('searchMatchedNodeIds still updates per keystroke in highlight mode', () => {
    const store = setupGraph()
    store.updateBehaviors({ searchMode: 'highlight' })
    store.applyFilters({ search_query: 'Company' })
    expect(store.searchMatchedNodeIds!.has('C')).toBe(true)
    store.applyFilters({ search_query: 'ZZZ' })
    expect(store.searchMatchedNodeIds!.size).toBe(0)
  })

  it('node_types toggle does not recompute the canvas chain (displayNodes/enhancedNodes)', () => {
    // Type filters are applied VISUALLY in the canvas (graphAppearance hidden
    // flag); the canvas data chain must stay cached so no Three.js rebuild or
    // force-layout reheat fires on a checkbox toggle.
    const store = setupGraph()
    store.displayNodes // warm-up (lazy cluster/similarity store creation)
    store.enhancedNodes
    const displayBefore = store.displayNodes
    const enhancedBefore = store.enhancedNodes
    store.applyFilters({ node_types: ['Person'] })
    expect(store.displayNodes).toBe(displayBefore)
    expect(store.enhancedNodes).toBe(enhancedBefore)
    // ...while the non-canvas consumers still see the filtered view
    expect(store.filteredNodes.map(n => n.node_id)).toEqual(['A', 'B'])
  })

  it('edge_types toggle does not recompute the canvas chain (displayEdges/enhancedEdges)', () => {
    const store = setupGraph()
    store.displayEdges // warm-up
    store.enhancedEdges
    const displayBefore = store.displayEdges
    const enhancedBefore = store.enhancedEdges
    store.applyFilters({ edge_types: ['KNOWS'] })
    expect(store.displayEdges).toBe(displayBefore)
    expect(store.enhancedEdges).toBe(enhancedBefore)
    expect(store.filteredEdges.map(e => e.edge_id)).toEqual(['e1', 'e2'])
  })

  it('canvas chain contains the full dataset while filters are active', () => {
    const store = setupGraph()
    store.applyFilters({ node_types: ['Person'], edge_types: ['KNOWS'] })
    // Canvas gets everything; hiding is visual
    expect(store.displayNodes).toHaveLength(4)
    expect(store.displayEdges).toHaveLength(4)
    // Non-canvas consumers get the filtered view
    expect(store.filteredNodes).toHaveLength(2)
  })

  it('displayEdges still applies the self-edge toggle (no visual equivalent)', () => {
    const store = setupGraph()
    store.edges = [
      ...store.edges,
      { edge_id: 'self', src: 'A', dst: 'A', relationship_type: 'KNOWS' },
    ]
    store.updateBehaviors({ showSelfEdges: false })
    expect(store.displayEdges.map(e => e.edge_id)).not.toContain('self')
    store.updateBehaviors({ showSelfEdges: true })
    expect(store.displayEdges.map(e => e.edge_id)).toContain('self')
  })

  it('table filter does not recompute the canvas chain (hidden visually via appearance)', () => {
    // Table filtering (DataTablePanel sync) is a KEEP-set applied in
    // graphAppearance — the canvas data must stay cached so brushing table
    // filters never rebuilds the 3D graph or reheats the layout.
    const store = setupGraph()
    store.displayNodes // warm-up
    store.enhancedNodes
    store.displayEdges
    store.enhancedEdges
    const nodesBefore = store.displayNodes
    const edgesBefore = store.displayEdges
    store.setTableFilteredIds(new Set(['A', 'B']), new Set(['e1']))
    expect(store.displayNodes).toBe(nodesBefore)
    expect(store.displayEdges).toBe(edgesBefore)
    // The sets are exposed for the canvas appearance context
    expect(store.tableFilteredNodeIds!.has('A')).toBe(true)
    expect(store.tableFilteredEdgeIds!.has('e1')).toBe(true)
    store.setTableFilteredIds(null, null)
    expect(store.tableFilteredNodeIds).toBeNull()
  })

  it('applyFilters merges partial updates without dropping other fields', () => {
    const store = setupGraph()
    store.applyFilters({ node_types: ['Person'] })
    store.applyFilters({ search_query: 'A' })
    expect(store.filters.node_types).toEqual(['Person'])
    expect(store.filters.search_query).toBe('A')
  })
})

// ============================================================================
// nodeTypes / edgeTypes
// ============================================================================

describe('nodeTypes / edgeTypes', () => {
  it('extracts unique node types sorted', () => {
    const store = setupGraph()
    expect(store.nodeTypes).toEqual(['Company', 'Person'])
  })

  it('extracts unique edge types sorted', () => {
    const store = setupGraph()
    expect(store.edgeTypes).toEqual(['KNOWS', 'WORKS_AT'])
  })

  it('empty graph returns empty arrays', () => {
    const store = useGraphStore()
    expect(store.nodeTypes).toEqual([])
    expect(store.edgeTypes).toEqual([])
  })
})

// ============================================================================
// Selection
// ============================================================================

describe('selection', () => {
  it('selectNode toggles selection with multi=true', () => {
    const store = setupGraph()
    store.selectNode('A')
    expect(store.selectedNodeIds.has('A')).toBe(true)
    // Without multi, selectNode clears first then re-adds, so toggle only works with multi=true
    store.selectNode('A', true)
    expect(store.selectedNodeIds.has('A')).toBe(false)
  })

  it('selectNode without multi clears previous', () => {
    const store = setupGraph()
    store.selectNode('A')
    store.selectNode('B')
    expect(store.selectedNodeIds.size).toBe(1)
    expect(store.selectedNodeIds.has('B')).toBe(true)
  })

  it('selectNode with multi=true keeps previous', () => {
    const store = setupGraph()
    store.selectNode('A')
    store.selectNode('B', true)
    expect(store.selectedNodeIds.size).toBe(2)
  })

  it('selectedNode returns single node when exactly one selected', () => {
    const store = setupGraph()
    store.selectNode('A')
    expect(store.selectedNode).not.toBeNull()
    expect(store.selectedNode!.node_id).toBe('A')
  })

  it('selectedNode returns null when multiple selected', () => {
    const store = setupGraph()
    store.selectNode('A')
    store.selectNode('B', true)
    expect(store.selectedNode).toBeNull()
  })

  it('clearSelection clears all', () => {
    const store = setupGraph()
    store.selectNode('A')
    store.selectEdge('e1', true)
    store.clearSelection()
    expect(store.selectedNodeIds.size).toBe(0)
    expect(store.selectedEdgeIds.size).toBe(0)
  })
})
