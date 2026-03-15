import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'
import { useClusterStore } from '@/stores/cluster'

function setupGraph() {
  const graphStore = useGraphStore()
  graphStore.nodes = [
    { node_id: 'n1', node_type: 'Person' },
    { node_id: 'n2', node_type: 'Person' },
    { node_id: 'n3', node_type: 'Company' },
    { node_id: 'n4', node_type: 'Company' },
    { node_id: 'n5', node_type: 'Location' },
  ]
  graphStore.edges = [
    { edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'KNOWS' },
    { edge_id: 'e2', src: 'n1', dst: 'n3', relationship_type: 'WORKS_AT' },
    { edge_id: 'e3', src: 'n2', dst: 'n3', relationship_type: 'WORKS_AT' },
    { edge_id: 'e4', src: 'n3', dst: 'n4', relationship_type: 'PARTNER' },
    { edge_id: 'e5', src: 'n4', dst: 'n5', relationship_type: 'LOCATED' },
  ]
  return graphStore
}

beforeEach(() => {
  setActivePinia(createPinia())
})

// ============================================================================
// enhancedNodes
// ============================================================================

describe('enhancedNodes', () => {
  it('with no clusters: returns same as filteredNodes', () => {
    const graphStore = setupGraph()
    expect(graphStore.enhancedNodes).toHaveLength(graphStore.filteredNodes.length)
  })

  it('closed cluster hides member nodes and adds virtual cluster node', () => {
    const graphStore = setupGraph()
    const clusterStore = useClusterStore()

    clusterStore.createCluster({
      cluster_id: 'cluster-persons',
      cluster_name: 'Persons',
      cluster_class: 'test',
      figure: 'circle',
      state: 'closed',
      node_ids: ['n1', 'n2'],
      color: '#ff0000',
    })

    const enhanced = graphStore.enhancedNodes
    // n1 and n2 hidden, cluster node added
    const nodeIds = enhanced.map(n => n.node_id)
    expect(nodeIds).not.toContain('n1')
    expect(nodeIds).not.toContain('n2')
    expect(nodeIds).toContain('cluster-persons')
    // Remaining nodes still present
    expect(nodeIds).toContain('n3')
    expect(nodeIds).toContain('n4')
    expect(nodeIds).toContain('n5')
  })

  it('virtual cluster node has __cluster__ type and properties', () => {
    const graphStore = setupGraph()
    const clusterStore = useClusterStore()

    clusterStore.createCluster({
      cluster_id: 'c1',
      cluster_name: 'TestCluster',
      cluster_class: 'test',
      figure: 'diamond',
      state: 'closed',
      node_ids: ['n1', 'n2'],
      color: '#ff0000',
    })

    const clusterNode = graphStore.enhancedNodes.find(n => n.node_id === 'c1')
    expect(clusterNode).toBeDefined()
    expect(clusterNode!.node_type).toBe('__cluster__')
    expect(clusterNode!.properties?.cluster_name).toBe('TestCluster')
    expect(clusterNode!.properties?.figure).toBe('diamond')
    expect(clusterNode!.properties?.node_count).toBe(2)
    expect(clusterNode!.properties?.color).toBe('#ff0000')
  })

  it('node in both open and closed cluster stays visible', () => {
    const graphStore = setupGraph()
    const clusterStore = useClusterStore()

    clusterStore.createCluster({
      cluster_id: 'closed1',
      cluster_name: 'Closed',
      cluster_class: 'test',
      figure: 'circle',
      state: 'closed',
      node_ids: ['n1'],
    })
    clusterStore.createCluster({
      cluster_id: 'open1',
      cluster_name: 'Open',
      cluster_class: 'test',
      figure: 'circle',
      state: 'open',
      node_ids: ['n1'],
    })

    const nodeIds = graphStore.enhancedNodes.map(n => n.node_id)
    expect(nodeIds).toContain('n1')
  })
})

// ============================================================================
// enhancedEdges
// ============================================================================

describe('enhancedEdges', () => {
  it('with no clusters: returns same as filteredEdges', () => {
    const graphStore = setupGraph()
    expect(graphStore.enhancedEdges).toHaveLength(graphStore.filteredEdges.length)
  })

  it('internal edge (both in same closed cluster) is hidden', () => {
    const graphStore = setupGraph()
    const clusterStore = useClusterStore()

    clusterStore.createCluster({
      cluster_id: 'c-persons',
      cluster_name: 'Persons',
      cluster_class: 'test',
      figure: 'circle',
      state: 'closed',
      node_ids: ['n1', 'n2'],
    })

    const enhanced = graphStore.enhancedEdges
    // e1 (n1->n2) is internal to the cluster, should be hidden
    expect(enhanced.find(e => e.edge_id === 'e1')).toBeUndefined()
  })

  it('edge from clustered node to external is remapped', () => {
    const graphStore = setupGraph()
    const clusterStore = useClusterStore()

    clusterStore.createCluster({
      cluster_id: 'c-persons',
      cluster_name: 'Persons',
      cluster_class: 'test',
      figure: 'circle',
      state: 'closed',
      node_ids: ['n1', 'n2'],
    })

    const enhanced = graphStore.enhancedEdges
    // e2 (n1->n3): n1 is in closed cluster, should be remapped to c-persons->n3
    const remappedE2 = enhanced.find(e => e.edge_id.includes('e2'))
    expect(remappedE2).toBeDefined()
    expect(remappedE2!.src).toBe('c-persons')
    expect(remappedE2!.dst).toBe('n3')
  })

  it('remapped edge gets new edge_id with cluster_ prefix', () => {
    const graphStore = setupGraph()
    const clusterStore = useClusterStore()

    clusterStore.createCluster({
      cluster_id: 'c-persons',
      cluster_name: 'Persons',
      cluster_class: 'test',
      figure: 'circle',
      state: 'closed',
      node_ids: ['n1', 'n2'],
    })

    const enhanced = graphStore.enhancedEdges
    const remappedEdges = enhanced.filter(e => e.edge_id.startsWith('cluster_'))
    expect(remappedEdges.length).toBeGreaterThan(0)
  })

  it('edges not touching cluster remain unchanged', () => {
    const graphStore = setupGraph()
    const clusterStore = useClusterStore()

    clusterStore.createCluster({
      cluster_id: 'c-persons',
      cluster_name: 'Persons',
      cluster_class: 'test',
      figure: 'circle',
      state: 'closed',
      node_ids: ['n1', 'n2'],
    })

    const enhanced = graphStore.enhancedEdges
    // e4 (n3->n4) and e5 (n4->n5): not touching the cluster
    expect(enhanced.find(e => e.edge_id === 'e4')).toBeDefined()
    expect(enhanced.find(e => e.edge_id === 'e5')).toBeDefined()
  })
})

// ============================================================================
// enhancedMultiEdgeStats
// ============================================================================

describe('enhancedMultiEdgeStats', () => {
  it('detects multi-edges created by cluster aggregation', () => {
    const graphStore = setupGraph()
    const clusterStore = useClusterStore()

    // n1->n3 (e2) and n2->n3 (e3) both become c-persons->n3
    clusterStore.createCluster({
      cluster_id: 'c-persons',
      cluster_name: 'Persons',
      cluster_class: 'test',
      figure: 'circle',
      state: 'closed',
      node_ids: ['n1', 'n2'],
    })

    expect(graphStore.enhancedMultiEdgeStats.hasMultiEdges).toBe(true)
    // c-persons->n3 has 2 edges (from e2 and e3)
    expect(graphStore.enhancedMultiEdgeStats.multiEdgePairCount).toBeGreaterThanOrEqual(1)
  })
})
