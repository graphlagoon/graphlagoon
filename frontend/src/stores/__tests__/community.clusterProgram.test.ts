import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useCommunityStore } from '@/stores/community'
import { useClusterStore } from '@/stores/cluster'
import { useGraphStore } from '@/stores/graph'

/**
 * Tests for using a cluster program AS a community algorithm.
 *
 * The community store runs the program non-mutatingly and converts its
 * Cluster[] output into communityMap, WITHOUT creating collapsed cluster
 * geometry (unless collapse is separately enabled).
 */

/**
 * Set the graph nodes/edges and flush the community store's `graphStore.nodes`
 * watcher. Instantiating the community store first ensures its watcher is
 * registered, and the awaited nextTick lets the deferred watcher run so a
 * subsequent runDetection() isn't wiped by the async clearCommunities().
 */
async function setupGraph() {
  const graphStore = useGraphStore()
  // Ensure the community store (and its nodes watcher) exists before we mutate nodes
  useCommunityStore()
  graphStore.nodes = [
    { node_id: 'n1', node_type: 'Person' },
    { node_id: 'n2', node_type: 'Person' },
    { node_id: 'n3', node_type: 'Company' },
    { node_id: 'n4', node_type: 'Company' },
  ]
  graphStore.edges = [
    { edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'KNOWS' },
    { edge_id: 'e2', src: 'n3', dst: 'n4', relationship_type: 'PARTNER' },
  ]
  await nextTick()
  return graphStore
}

/** Create a cluster program that groups n1+n2 into A and n3 into B. */
function createTwoClusterProgram(clusterStore: ReturnType<typeof useClusterStore>) {
  return clusterStore.createProgram({
    program_name: 'Two Clusters',
    code: `return [
      { cluster_name: 'A', node_ids: ['n1', 'n2'] },
      { cluster_name: 'B', node_ids: ['n3'] },
    ]`,
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('cluster program as community algorithm', () => {
  it('selectedProgramId / isLouvain track the algorithm ref', () => {
    const community = useCommunityStore()
    expect(community.isLouvain).toBe(true)
    expect(community.selectedProgramId).toBeNull()

    community.algorithm = 'cluster-program:abc'
    expect(community.isLouvain).toBe(false)
    expect(community.selectedProgramId).toBe('abc')
  })

  it('populates communityMap from cluster indices (first cluster = 0)', async () => {
    await setupGraph()
    const clusterStore = useClusterStore()
    const community = useCommunityStore()
    const prog = createTwoClusterProgram(clusterStore)

    community.algorithm = `cluster-program:${prog.program_id}`
    await community.runDetection()

    expect(community.hasResults).toBe(true)
    expect(community.communityMap.get('n1')).toBe(0)
    expect(community.communityMap.get('n2')).toBe(0)
    expect(community.communityMap.get('n3')).toBe(1)
    // modularity is undefined for the program path
    expect(community.modularity).toBeNull()
  })

  it('does NOT create cluster geometry when collapse is off', async () => {
    await setupGraph()
    const clusterStore = useClusterStore()
    const community = useCommunityStore()
    const prog = createTwoClusterProgram(clusterStore)

    community.algorithm = `cluster-program:${prog.program_id}`
    community.collapseEnabled = false
    await community.runDetection()

    expect(clusterStore.clusters).toHaveLength(0)
  })

  it('creates community clusters when collapse is on', async () => {
    await setupGraph()
    const clusterStore = useClusterStore()
    const community = useCommunityStore()
    const prog = createTwoClusterProgram(clusterStore)

    community.algorithm = `cluster-program:${prog.program_id}`
    community.collapseEnabled = true
    await community.runDetection()

    expect(clusterStore.clusters.length).toBeGreaterThan(0)
    expect(clusterStore.clusters.every(c => c.cluster_class === 'community')).toBe(true)
  })

  it('multi-membership: first cluster wins', () => {
    const community = useCommunityStore()

    // n1 appears in both cluster 0 and cluster 1 → should map to 0
    const clusters = [
      { cluster_id: 'a', cluster_name: 'A', cluster_class: 'x', figure: 'circle' as const, state: 'closed' as const, node_ids: ['n1', 'n2'] },
      { cluster_id: 'b', cluster_name: 'B', cluster_class: 'x', figure: 'circle' as const, state: 'closed' as const, node_ids: ['n1', 'n3'] },
    ]
    const map = community.buildCommunityMapFromClusters(clusters, ['n1', 'n2', 'n3', 'n4'])

    expect(map.get('n1')).toBe(0)
    expect(map.get('n3')).toBe(1)
  })

  it('uncovered nodes form a single "others" community (id = clusters.length)', () => {
    const community = useCommunityStore()

    // Only n1 covered; n2, n3, n4 uncovered → all get id 1
    const clusters = [
      { cluster_id: 'a', cluster_name: 'A', cluster_class: 'x', figure: 'circle' as const, state: 'closed' as const, node_ids: ['n1'] },
    ]
    const map = community.buildCommunityMapFromClusters(clusters, ['n1', 'n2', 'n3', 'n4'])

    expect(map.get('n1')).toBe(0)
    expect(map.get('n2')).toBe(1)
    expect(map.get('n3')).toBe(1)
    expect(map.get('n4')).toBe(1)
  })

  it('community program that covers all nodes has no "others" community', async () => {
    await setupGraph()
    const clusterStore = useClusterStore()
    const community = useCommunityStore()
    const prog = clusterStore.createProgram({
      program_name: 'Cover All',
      code: `return [
        { cluster_name: 'A', node_ids: ['n1', 'n2'] },
        { cluster_name: 'B', node_ids: ['n3', 'n4'] },
      ]`,
    })

    community.algorithm = `cluster-program:${prog.program_id}`
    await community.runDetection()

    // Two communities: 0 and 1, no "others" id 2
    expect(new Set(community.communityMap.values())).toEqual(new Set([0, 1]))
    expect(community.communityCount).toBe(2)
  })

  it('program execution error sets error and leaves communityMap unchanged', async () => {
    await setupGraph()
    const clusterStore = useClusterStore()
    const community = useCommunityStore()
    const prog = clusterStore.createProgram({
      program_name: 'Broken',
      code: 'throw new Error("boom")',
    })

    community.algorithm = `cluster-program:${prog.program_id}`
    await community.runDetection()

    expect(community.error).toContain('boom')
    expect(community.hasResults).toBe(false)
  })

  it('getState / loadState round-trips the algorithm selection', async () => {
    await setupGraph()
    const clusterStore = useClusterStore()
    const community = useCommunityStore()
    const prog = createTwoClusterProgram(clusterStore)

    community.algorithm = `cluster-program:${prog.program_id}`
    await community.runDetection()

    const state = community.getState()
    expect(state?.algorithm).toBe(`cluster-program:${prog.program_id}`)

    // Restore into a fresh store
    setActivePinia(createPinia())
    const restored = useCommunityStore()
    restored.loadState(state)
    expect(restored.algorithm).toBe(`cluster-program:${prog.program_id}`)
    expect(restored.communityMap.get('n1')).toBe(0)
  })

  // ==========================================================================
  // Program parameters in the community path
  // ==========================================================================

  describe('program parameters', () => {
    /** Program whose grouping depends on params.groupSize (1 → one node per cluster). */
    function createParamProgram(clusterStore: ReturnType<typeof useClusterStore>) {
      return clusterStore.createProgram({
        program_name: 'Param Groups',
        code: `
          const ids = ['n1', 'n2', 'n3', 'n4'];
          const size = params.groupSize;
          const clusters = [];
          for (let i = 0; i < ids.length; i += size) {
            clusters.push({ cluster_name: 'G' + i, node_ids: ids.slice(i, i + size) });
          }
          return clusters;
        `,
        parameters: [{ id: 'groupSize', type: 'number', default: 2, required: true }],
      })
    }

    it('ensureProgramParams seeds defaults for a program', () => {
      const clusterStore = useClusterStore()
      const community = useCommunityStore()
      const prog = createParamProgram(clusterStore)

      community.ensureProgramParams(prog.program_id)
      expect(community.programParams[prog.program_id]).toEqual({ groupSize: 2 })
    })

    it('ensureProgramParams keeps stored values and drops stale keys', () => {
      const clusterStore = useClusterStore()
      const community = useCommunityStore()
      const prog = createParamProgram(clusterStore)

      community.programParams[prog.program_id] = { groupSize: 4, removed: 'stale' }
      community.ensureProgramParams(prog.program_id)
      expect(community.programParams[prog.program_id]).toEqual({ groupSize: 4 })
    })

    it('ensureProgramParams is a no-op for unknown programs', () => {
      const community = useCommunityStore()
      community.ensureProgramParams('nonexistent')
      expect(community.programParams['nonexistent']).toBeUndefined()
    })

    it('runDetection passes the stored values to the program', async () => {
      await setupGraph()
      const clusterStore = useClusterStore()
      const community = useCommunityStore()
      const prog = createParamProgram(clusterStore)

      community.algorithm = `cluster-program:${prog.program_id}`
      community.programParams[prog.program_id] = { groupSize: 1 }
      await community.runDetection()

      // groupSize=1 → 4 clusters of one node each (default 2 would give 2)
      expect(community.communityCount).toBe(4)
    })

    it('runDetection uses declared defaults when no values stored', async () => {
      await setupGraph()
      const clusterStore = useClusterStore()
      const community = useCommunityStore()
      const prog = createParamProgram(clusterStore)

      community.algorithm = `cluster-program:${prog.program_id}`
      await community.runDetection()

      // default groupSize=2 → 2 clusters
      expect(community.communityCount).toBe(2)
    })

    it('default BFS program yields exactly two communities: the BFS set and "others"', async () => {
      await setupGraph()
      useClusterStore()
      const community = useCommunityStore()

      community.algorithm = 'cluster-program:default-bfs-from-node'
      community.programParams['default-bfs-from-node'] = { start_node_id: 'n1', depth: '1' }
      await community.runDetection()

      // This file's graph only has n1—n2 and n3—n4 edges:
      // BFS(n1, depth 1) = {n1, n2} → community 0; n3 and n4 → "others" (1)
      expect(community.communityCount).toBe(2)
      expect(community.communityMap.get('n1')).toBe(0)
      expect(community.communityMap.get('n2')).toBe(0)
      expect(community.communityMap.get('n3')).toBe(1)
      expect(community.communityMap.get('n4')).toBe(1)
    })

    it('carries cluster names over as community labels (+ "Others")', async () => {
      await setupGraph()
      const clusterStore = useClusterStore()
      const community = useCommunityStore()
      const prog = createTwoClusterProgram(clusterStore) // A={n1,n2}, B={n3}; n4 uncovered

      community.algorithm = `cluster-program:${prog.program_id}`
      await community.runDetection()

      expect(community.communityLabels).toEqual({ 0: 'A', 1: 'B', 2: 'Others' })
      const byId = new Map(community.communitiesSorted.map(c => [c.id, c.label]))
      expect(byId.get(0)).toBe('A')
      expect(byId.get(2)).toBe('Others')
    })

    it('omits the "Others" label when the program covers all nodes', async () => {
      await setupGraph()
      const clusterStore = useClusterStore()
      const community = useCommunityStore()
      const prog = clusterStore.createProgram({
        program_name: 'Cover All',
        code: `return [
          { cluster_name: 'A', node_ids: ['n1', 'n2'] },
          { cluster_name: 'B', node_ids: ['n3', 'n4'] },
        ]`,
      })

      community.algorithm = `cluster-program:${prog.program_id}`
      await community.runDetection()

      expect(community.communityLabels).toEqual({ 0: 'A', 1: 'B' })
    })

    it('communitiesSorted falls back to "Community <id>" when there are no labels', () => {
      const community = useCommunityStore()
      community.communityMap = new Map([['n1', 0], ['n2', 1]])

      const byId = new Map(community.communitiesSorted.map(c => [c.id, c.label]))
      expect(byId.get(0)).toBe('Community 0')
      expect(byId.get(1)).toBe('Community 1')
    })

    it('getState / loadState round-trips communityLabels', async () => {
      await setupGraph()
      const clusterStore = useClusterStore()
      const community = useCommunityStore()
      const prog = createTwoClusterProgram(clusterStore)

      community.algorithm = `cluster-program:${prog.program_id}`
      await community.runDetection()

      const state = community.getState()

      setActivePinia(createPinia())
      const restored = useCommunityStore()
      restored.loadState(state)
      expect(restored.communityLabels).toEqual({ 0: 'A', 1: 'B', 2: 'Others' })
    })

    it('getState / loadState round-trips programParams', async () => {
      await setupGraph()
      const clusterStore = useClusterStore()
      const community = useCommunityStore()
      const prog = createParamProgram(clusterStore)

      community.algorithm = `cluster-program:${prog.program_id}`
      community.programParams[prog.program_id] = { groupSize: 1 }
      await community.runDetection()

      const state = community.getState()

      setActivePinia(createPinia())
      const restored = useCommunityStore()
      restored.loadState(state)
      expect(restored.programParams[prog.program_id]).toEqual({ groupSize: 1 })
    })
  })
})
