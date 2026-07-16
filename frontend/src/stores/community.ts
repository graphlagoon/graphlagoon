/**
 * Community Detection Store
 *
 * Manages community detection results and visualization settings.
 * Communities are detected via a dedicated Web Worker (Louvain algorithm)
 * and can be visualized as colors, radial layout, or collapsed clusters.
 */
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { useClusterStore } from './cluster'
import { useGraphStore } from './graph'
import type { SerializedGraph } from '@/types/metrics'
import type { Cluster, CommunityAlgorithm } from '@/types/cluster'
import type { CommunityWorkerInput, CommunityWorkerOutput } from '@/workers/communityWorker'

// 19-color qualitative palette for community coloring
const COMMUNITY_PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
  '#dcbeff', '#9A6324', '#fffac8', '#800000', '#aaffc3',
  '#808000', '#ffd8b1', '#000075', '#a9a9a9',
]

export const useCommunityStore = defineStore('community', () => {
  // ============================================================================
  // State
  // ============================================================================

  const communityMap = ref<Map<string, number>>(new Map())
  const communityCount = ref(0)
  const modularity = ref<number | null>(null)
  const computing = ref(false)
  const error = ref<string | null>(null)
  const lastComputedAt = ref<number | null>(null)
  const progressMessage = ref<string | null>(null)
  const progressValue = ref(0)

  // UI toggles
  const colorEnabled = ref(true)
  const radialLayoutEnabled = ref(false)
  const collapseEnabled = ref(false)

  // Algorithm selection: 'louvain' (worker) or 'cluster-program:<programId>'
  const algorithm = ref<CommunityAlgorithm>('louvain')

  // Algorithm params (Louvain-specific)
  const resolution = ref(1.0)
  const edgeTypeFilter = ref<string[]>([])

  // Worker reference
  let worker: Worker | null = null

  // ============================================================================
  // Computed
  // ============================================================================

  /**
   * Whether the built-in Louvain algorithm is selected (vs. a cluster program).
   */
  const isLouvain = computed(() => algorithm.value === 'louvain')

  /**
   * The cluster program ID when a program is selected as the community
   * algorithm, or null for Louvain.
   */
  const selectedProgramId = computed((): string | null =>
    isLouvain.value ? null : algorithm.value.slice('cluster-program:'.length)
  )

  /**
   * Whether communities have been detected
   */
  const hasResults = computed(() => communityMap.value.size > 0)

  /**
   * Node → hex color map. Used by AppearanceContext for per-node coloring.
   * Returns null when coloring is disabled or no results.
   */
  const communityColorMap = computed((): Map<string, string> | null => {
    if (!colorEnabled.value || communityMap.value.size === 0) return null
    const map = new Map<string, string>()
    communityMap.value.forEach((communityId, nodeId) => {
      map.set(nodeId, COMMUNITY_PALETTE[communityId % COMMUNITY_PALETTE.length])
    })
    return map
  })

  /**
   * communityId → nodeIds[]
   */
  const communitiesById = computed(() => {
    const result = new Map<number, string[]>()
    communityMap.value.forEach((communityId, nodeId) => {
      if (!result.has(communityId)) result.set(communityId, [])
      result.get(communityId)!.push(nodeId)
    })
    return result
  })

  /**
   * Community statistics
   */
  const communityStats = computed(() => {
    const sizes = Array.from(communitiesById.value.values()).map(ids => ids.length)
    // Loop instead of Math.max/min(...sizes): spreading a large array into a call
    // overflows V8's argument limit (~130k) → "Maximum call stack size exceeded".
    let maxSize = 0
    let minSize = 0
    let sum = 0
    for (let i = 0; i < sizes.length; i++) {
      const s = sizes[i]
      if (i === 0 || s > maxSize) maxSize = s
      if (i === 0 || s < minSize) minSize = s
      sum += s
    }
    return {
      count: communitiesById.value.size,
      avgSize: sizes.length > 0 ? Math.round(sum / sizes.length) : 0,
      maxSize,
      minSize,
    }
  })

  /**
   * Sorted list of communities for display
   */
  const communitiesSorted = computed(() => {
    return Array.from(communitiesById.value.entries())
      .map(([id, nodeIds]) => ({
        id,
        nodeCount: nodeIds.length,
        color: COMMUNITY_PALETTE[id % COMMUNITY_PALETTE.length],
      }))
      .sort((a, b) => b.nodeCount - a.nodeCount)
  })

  /**
   * Per-community radial layout configuration.
   * Returns null when radial layout is disabled or no results.
   */
  const communityRadialConfig = computed((): Map<number, { angle: number; radius: number }> | null => {
    if (!radialLayoutEnabled.value || communitiesById.value.size === 0) return null
    const config = new Map<number, { angle: number; radius: number }>()
    const count = communitiesById.value.size
    // Fixed radius for all communities — only angle varies
    const RADIUS = 200
    let i = 0
    for (const [communityId] of communitiesById.value) {
      config.set(communityId, {
        angle: (2 * Math.PI * i) / count,
        radius: RADIUS,
      })
      i++
    }
    return config
  })

  // ============================================================================
  // Actions
  // ============================================================================

  /**
   * Run community detection on the current graph.
   *
   * Branches on the selected algorithm:
   * - Louvain: serializes the graph and runs the dedicated worker.
   * - Cluster program: runs the program synchronously (no worker) and converts
   *   its Cluster[] output into the community map — WITHOUT creating collapsed
   *   cluster geometry.
   */
  async function runDetection(): Promise<void> {
    if (computing.value) return

    computing.value = true
    error.value = null
    progressMessage.value = 'Starting...'
    progressValue.value = 0

    try {
      if (!isLouvain.value) {
        runClusterProgramAsCommunity(selectedProgramId.value!)
      } else {
        const graph = serializeGraph()

        if (graph.nodes.length === 0) {
          error.value = 'No nodes in graph'
          return
        }

        const result = await runWorker(graph)

        // Store results
        const map = new Map<string, number>()
        for (const [nodeId, communityId] of Object.entries(result.communities)) {
          map.set(nodeId, communityId)
        }
        communityMap.value = map
        communityCount.value = result.count
        modularity.value = result.modularity
        lastComputedAt.value = Date.now()
      }

      // Sync clusters only if collapse is explicitly enabled (independent opt-in).
      // The cluster-program path never creates geometry on its own.
      if (collapseEnabled.value && hasResults.value) {
        syncToClusters()
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      computing.value = false
      progressMessage.value = null
      progressValue.value = 0
    }
  }

  /**
   * Build a node → communityId map from a cluster program's Cluster[] output.
   *
   * - communityId = the cluster's index in the array (integer, palette-friendly).
   * - Multi-membership: the first cluster (array order) wins.
   * - Nodes not covered by any cluster are collected into a single "others"
   *   community (id = clusters.length) so every node has a community.
   */
  function buildCommunityMapFromClusters(
    programClusters: Cluster[],
    allNodeIds: string[]
  ): Map<string, number> {
    const map = new Map<string, number>()

    programClusters.forEach((cluster, index) => {
      for (const nodeId of cluster.node_ids) {
        // First cluster wins for nodes appearing in multiple clusters
        if (!map.has(nodeId)) {
          map.set(nodeId, index)
        }
      }
    })

    // Assign any uncovered node to a single "others" community
    const othersId = programClusters.length
    let hasOthers = false
    for (const nodeId of allNodeIds) {
      if (!map.has(nodeId)) {
        map.set(nodeId, othersId)
        hasOthers = true
      }
    }

    // Drop the "others" bucket if nothing landed in it (avoids an empty extra community)
    return hasOthers || map.size > 0 ? map : new Map()
  }

  /**
   * Run a cluster program as a community algorithm.
   *
   * Executes the program NON-mutatingly (no cluster geometry) and populates
   * communityMap from its output. Modularity is undefined for this path.
   */
  function runClusterProgramAsCommunity(programId: string): void {
    const clusterStore = useClusterStore()
    const graphStore = useGraphStore()

    const result = clusterStore.computeClustersFromProgram(programId)

    if (!result.success) {
      error.value = result.error ?? 'Cluster program execution failed'
      return
    }

    const programClusters = result.clusters ?? []
    const allNodeIds = graphStore.filteredNodes.map(n => n.node_id)
    const map = buildCommunityMapFromClusters(programClusters, allNodeIds)

    communityMap.value = map
    // Count distinct community ids actually present in the map
    communityCount.value = new Set(map.values()).size
    modularity.value = null
    lastComputedAt.value = Date.now()
  }

  /**
   * Create worker, send message, and return result as a promise.
   */
  function runWorker(graph: SerializedGraph): Promise<{ communities: Record<string, number>; count: number; modularity: number }> {
    return new Promise((resolve, reject) => {
      // Terminate any previous worker
      if (worker) {
        worker.terminate()
        worker = null
      }

      worker = new Worker(
        new URL('@/workers/communityWorker.ts', import.meta.url),
        { type: 'module' }
      )

      worker.onmessage = (event: MessageEvent<CommunityWorkerOutput>) => {
        const msg = event.data

        switch (msg.type) {
          case 'PROGRESS':
            progressMessage.value = msg.message
            progressValue.value = msg.progress
            break

          case 'RESULT':
            worker?.terminate()
            worker = null
            resolve({
              communities: msg.communities,
              count: msg.count,
              modularity: msg.modularity,
            })
            break

          case 'ERROR':
            worker?.terminate()
            worker = null
            reject(new Error(msg.error))
            break
        }
      }

      worker.onerror = (event) => {
        worker?.terminate()
        worker = null
        reject(new Error(event.message || 'Worker error'))
      }

      const message: CommunityWorkerInput = {
        type: 'RUN',
        graph,
        params: { resolution: resolution.value, edgeTypeFilter: [...edgeTypeFilter.value] },
      }

      worker.postMessage(message)
    })
  }

  /**
   * Serialize the current filtered graph for the worker.
   */
  function serializeGraph(): SerializedGraph {
    const graphStore = useGraphStore()

    const nodes = graphStore.filteredNodes.map((node) => ({
      id: node.node_id,
      attributes: { node_type: node.node_type },
    }))

    const edges = graphStore.filteredEdges.map((edge) => ({
      id: edge.edge_id,
      source: edge.src,
      target: edge.dst,
      attributes: { relationship_type: edge.relationship_type },
    }))

    return { nodes, edges }
  }

  /**
   * Inject or remove community clusters in the cluster store.
   */
  function syncToClusters(): void {
    const clusterStore = useClusterStore()

    // Remove existing community clusters
    const nonCommunity = clusterStore.clusters.filter(
      c => c.cluster_class !== 'community'
    )

    if (!collapseEnabled.value || communitiesById.value.size === 0) {
      clusterStore.clusters = nonCommunity
      return
    }

    const newClusters: Cluster[] = []
    for (const [communityId, nodeIds] of communitiesById.value) {
      newClusters.push({
        cluster_id: `community-${communityId}`,
        cluster_name: `Community ${communityId}`,
        cluster_class: 'community',
        figure: 'circle',
        state: 'closed',
        node_ids: nodeIds,
        color: COMMUNITY_PALETTE[communityId % COMMUNITY_PALETTE.length],
        description: `${nodeIds.length} nodes`,
        source_program_id: '__community_detection__',
      })
    }

    clusterStore.clusters = [...nonCommunity, ...newClusters]
  }

  /**
   * Serialize community state for exploration persistence.
   */
  function getState(): Record<string, unknown> | undefined {
    if (communityMap.value.size === 0) return undefined
    return {
      communityMap: Object.fromEntries(communityMap.value),
      communityCount: communityCount.value,
      modularity: modularity.value,
      algorithm: algorithm.value,
      colorEnabled: colorEnabled.value,
      radialLayoutEnabled: radialLayoutEnabled.value,
      collapseEnabled: collapseEnabled.value,
      resolution: resolution.value,
      edgeTypeFilter: edgeTypeFilter.value,
    }
  }

  /**
   * Restore community state from exploration. Must be called BEFORE
   * executeGraphQuery (which triggers the nodes watcher that clears communities).
   */
  function loadState(state: Record<string, unknown> | undefined): void {
    if (!state || !state.communityMap) {
      // No saved community state — don't clear (let the nodes watcher handle it)
      return
    }
    const map = state.communityMap as Record<string, number>
    communityMap.value = new Map(Object.entries(map).map(([k, v]) => [k, v]))
    communityCount.value = (state.communityCount as number) || 0
    modularity.value = (state.modularity as number) ?? null
    algorithm.value = (state.algorithm as CommunityAlgorithm) ?? 'louvain'
    colorEnabled.value = (state.colorEnabled as boolean) ?? true
    radialLayoutEnabled.value = (state.radialLayoutEnabled as boolean) ?? false
    collapseEnabled.value = (state.collapseEnabled as boolean) ?? false
    resolution.value = (state.resolution as number) ?? 1.0
    edgeTypeFilter.value = (state.edgeTypeFilter as string[]) ?? []
  }

  /**
   * Clear all community detection results.
   */
  function clearCommunities(): void {
    communityMap.value = new Map()
    communityCount.value = 0
    modularity.value = null
    lastComputedAt.value = null
    error.value = null

    // Remove community clusters from cluster store
    const clusterStore = useClusterStore()
    clusterStore.clusters = clusterStore.clusters.filter(
      c => c.cluster_class !== 'community'
    )

    // Terminate worker if running
    if (worker) {
      worker.terminate()
      worker = null
      computing.value = false
    }
  }

  // ============================================================================
  // Watchers
  // ============================================================================

  watch(collapseEnabled, () => {
    if (hasResults.value) {
      syncToClusters()
    }
  })

  // Clear communities when graph data changes (query executed, subgraph loaded, etc.)
  // This also clears clusters, since communities reference node_ids that may no longer exist.
  watch(
    () => useGraphStore().nodes,
    () => {
      if (hasResults.value) {
        clearCommunities()
      }
    },
  )

  // ============================================================================
  // Return
  // ============================================================================

  return {
    // State
    communityMap,
    communityCount,
    modularity,
    computing,
    error,
    lastComputedAt,
    progressMessage,
    progressValue,

    // Algorithm selection
    algorithm,

    // UI toggles
    colorEnabled,
    radialLayoutEnabled,
    collapseEnabled,
    resolution,
    edgeTypeFilter,

    // Computed
    isLouvain,
    selectedProgramId,
    hasResults,
    communityColorMap,
    communitiesById,
    communityStats,
    communitiesSorted,
    communityRadialConfig,

    // Actions
    runDetection,
    runClusterProgramAsCommunity,
    buildCommunityMapFromClusters,
    syncToClusters,
    clearCommunities,
    getState,
    loadState,
  }
})
