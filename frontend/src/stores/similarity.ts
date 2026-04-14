/**
 * Similarity Store
 *
 * Manages similarity computation, edge injection, display modes,
 * and layout-by-edge-type. Follows the community.ts store pattern.
 */
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { useGraphStore } from './graph'
import { api } from '@/services/api'
import type {
  SimilarityEndpointInfo,
  SimilarityEdge,
  SimilarityDisplayMode,
  LayoutStrategy,
} from '@/types/similarity'

export const useSimilarityStore = defineStore('similarity', () => {
  // ============================================================================
  // State
  // ============================================================================

  const similarityEdges = ref<SimilarityEdge[]>([])
  const computing = ref(false)
  const loadingEndpoints = ref(false)
  const needsLayoutAfterCompute = ref(false)
  const error = ref<string | null>(null)

  // Endpoint selection
  const availableEndpoints = ref<SimilarityEndpointInfo[]>([])
  const selectedEndpoint = ref<string | null>(null)
  const selectedNodeType = ref<string | null>(null)
  const keyProperty = ref<string>('node_id')
  const isJsonString = ref(false)
  const jsonPath = ref<string>('')  // dot-separated path inside parsed JSON, e.g. "embedding.id"
  const endpointParams = ref<Record<string, unknown>>({})

  // Display
  const displayMode = ref<SimilarityDisplayMode>('overlay')
  const scoreThreshold = ref(0)

  // Layout by edge type
  const layoutStrategy = ref<LayoutStrategy>('fix-then-recompute')
  const layoutEdgeType = ref<string | null>('__similarity__')
  const useScoreAsWeight = ref(true)

  // ============================================================================
  // Computed
  // ============================================================================

  const hasResults = computed(() => similarityEdges.value.length > 0)

  const resultStats = computed(() => {
    if (!hasResults.value) return null
    const nodeIds = new Set<string>()
    for (const edge of similarityEdges.value) {
      nodeIds.add(edge.source)
      nodeIds.add(edge.target)
    }
    return {
      edgeCount: similarityEdges.value.length,
      nodeCount: nodeIds.size,
    }
  })

  // ============================================================================
  // Key extraction helpers
  // ============================================================================

  /**
   * Resolve a dot-separated path inside a value.
   * e.g. resolveJsonPath('{"a":{"b":"x"}}', 'a.b') → "x"
   */
  function resolveJsonPath(raw: unknown, path: string): unknown {
    if (path === '') return raw

    let obj: unknown
    if (typeof raw === 'string') {
      try { obj = JSON.parse(raw) } catch { return undefined }
    } else {
      obj = raw
    }

    for (const segment of path.split('.')) {
      if (obj === null || obj === undefined || typeof obj !== 'object') return undefined
      obj = (obj as Record<string, unknown>)[segment]
    }
    return obj
  }

  function extractKeyFromNode(node: import('@/types/graph').Node): string | undefined {
    if (keyProperty.value === 'node_id') return node.node_id

    const raw = node.properties?.[keyProperty.value]
    if (raw === undefined || raw === null || raw === '') return undefined

    if (isJsonString.value && jsonPath.value) {
      const resolved = resolveJsonPath(raw, jsonPath.value)
      if (resolved === undefined || resolved === null || resolved === '') return undefined
      return String(resolved)
    }

    const str = String(raw)
    return str.trim() === '' ? undefined : str
  }

  function extractKeysFromNodes(nodes: import('@/types/graph').Node[]): {
    keys: string[];
    keyToNodeId: Map<string, string>;
    skipped: number;
    duplicates: number;
  } {
    const keys: string[] = []
    const keyToNodeId = new Map<string, string>()
    const seen = new Set<string>()
    let skipped = 0
    let duplicates = 0
    for (const node of nodes) {
      const key = extractKeyFromNode(node)
      if (key && key.trim() !== '') {
        if (seen.has(key)) {
          duplicates++
        } else {
          seen.add(key)
          keys.push(key)
          keyToNodeId.set(key, node.node_id)
        }
      } else {
        skipped++
      }
    }
    return { keys, keyToNodeId, skipped, duplicates }
  }

  /**
   * Public: extract keys for the current settings (for UI preview).
   */
  function extractKeys(): { keys: string[]; skipped: number; duplicates: number; total: number } {
    const graphStore = useGraphStore()
    const targetNodes = selectedNodeType.value
      ? graphStore.filteredNodes.filter(n => n.node_type === selectedNodeType.value)
      : graphStore.filteredNodes
    const { keys, skipped, duplicates } = extractKeysFromNodes(targetNodes)
    return { keys, skipped, duplicates, total: targetNodes.length }
  }

  // ============================================================================
  // Actions
  // ============================================================================

  async function fetchEndpoints(): Promise<void> {
    loadingEndpoints.value = true
    try {
      availableEndpoints.value = await api.getSimilarityEndpoints()
    } catch (e) {
      console.warn('[similarity] Failed to fetch endpoints:', e)
      availableEndpoints.value = []
    } finally {
      loadingEndpoints.value = false
    }
  }

  async function runComputation(): Promise<void> {
    if (computing.value) return
    if (!selectedEndpoint.value) {
      error.value = 'No endpoint selected'
      return
    }

    const graphStore = useGraphStore()

    // Extract node keys for the selected node type
    const targetNodes = selectedNodeType.value
      ? graphStore.filteredNodes.filter(n => n.node_type === selectedNodeType.value)
      : graphStore.filteredNodes

    if (targetNodes.length < 2) {
      error.value = 'Need at least 2 nodes of the selected type'
      return
    }

    const { keys: nodeKeys, keyToNodeId, skipped, duplicates } = extractKeysFromNodes(targetNodes)

    if (nodeKeys.length < 2) {
      error.value = `Not enough nodes with property '${keyProperty.value}' (${skipped} skipped)`
      return
    }

    if (duplicates > 0) {
      console.warn(`[similarity] ${duplicates} nodes with duplicate key values were skipped`)
    }

    // Resolve endpoint path from spec
    const spec = availableEndpoints.value.find(ep => ep.name === selectedEndpoint.value)
    if (!spec) {
      error.value = `Endpoint '${selectedEndpoint.value}' not found`
      return
    }

    // Clear previous results before computing
    if (hasResults.value) {
      removeEdges()
      similarityEdges.value = []
    }

    computing.value = true
    error.value = null

    try {
      const response = await api.computeSimilarity(spec.endpoint, {
        node_keys: nodeKeys,
        params: { ...endpointParams.value },
      })

      // Translate keys back to node_ids when using a non-id property
      const useNodeId = keyProperty.value === 'node_id'
      const nodeIdSet = new Set(graphStore.filteredNodes.map(n => n.node_id))

      const translatedEdges = response.edges
        .map(e => {
          if (useNodeId) return e
          const src = keyToNodeId.get(e.source)
          const tgt = keyToNodeId.get(e.target)
          if (!src || !tgt) return null
          return { source: src, target: tgt, score: e.score }
        })
        .filter((e): e is NonNullable<typeof e> => {
          if (!e) return false
          // Validate that source/target exist in the current graph
          return nodeIdSet.has(e.source) && nodeIdSet.has(e.target)
        })

      similarityEdges.value = translatedEdges

      if (response.edges.length === 0) {
        error.value = 'No similarity edges returned'
        return
      }

      if (response.edges.length > 5000) {
        console.warn(`[similarity] Large result: ${response.edges.length} edges. Consider adjusting endpoint params.`)
      }

      // Inject edges into graph store
      injectEdges()
      needsLayoutAfterCompute.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      computing.value = false
    }
  }

  function injectEdges(): void {
    const graphStore = useGraphStore()

    // Remove any existing similarity edges first
    removeEdges()

    // Convert similarity edges to graph Edge format and add (filtered by threshold)
    const epName = selectedEndpoint.value || 'unknown'
    const threshold = scoreThreshold.value
    const newEdges = similarityEdges.value.filter(se => se.score >= threshold).map(se => ({
      edge_id: `sim|${epName}|${se.source}|${se.target}`,
      src: se.source,
      dst: se.target,
      relationship_type: '__similarity__',
      properties: {
        score: se.score,
        endpoint_name: epName,
      },
    }))

    graphStore.edges.push(...newEdges)
  }

  function removeEdges(): void {
    const graphStore = useGraphStore()
    graphStore.edges = graphStore.edges.filter(
      e => e.relationship_type !== '__similarity__'
    )
  }

  function clearSimilarity(): void {
    removeEdges()
    similarityEdges.value = []
    error.value = null
  }

  function setDisplayMode(mode: SimilarityDisplayMode): void {
    displayMode.value = mode
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  function getState(): Record<string, unknown> | undefined {
    if (similarityEdges.value.length === 0) return undefined
    return {
      similarityEdges: similarityEdges.value,
      selectedEndpoint: selectedEndpoint.value,
      selectedNodeType: selectedNodeType.value,
      keyProperty: keyProperty.value,
      isJsonString: isJsonString.value,
      jsonPath: jsonPath.value,
      endpointParams: endpointParams.value,
      displayMode: displayMode.value,
      scoreThreshold: scoreThreshold.value,
      layoutStrategy: layoutStrategy.value,
      layoutEdgeType: layoutEdgeType.value,
      useScoreAsWeight: useScoreAsWeight.value,
    }
  }

  function loadState(state: Record<string, unknown> | undefined): void {
    if (!state || !state.similarityEdges) return

    similarityEdges.value = state.similarityEdges as SimilarityEdge[]
    selectedEndpoint.value = (state.selectedEndpoint as string) ?? null
    selectedNodeType.value = (state.selectedNodeType as string) ?? null
    keyProperty.value = (state.keyProperty as string) ?? 'node_id'
    isJsonString.value = (state.isJsonString as boolean) ?? false
    jsonPath.value = (state.jsonPath as string) ?? ''
    endpointParams.value = (state.endpointParams as Record<string, unknown>) ?? {}
    displayMode.value = (state.displayMode as SimilarityDisplayMode) ?? 'overlay'
    scoreThreshold.value = (state.scoreThreshold as number) ?? 0
    layoutStrategy.value = (state.layoutStrategy as LayoutStrategy) ?? 'unified'
    layoutEdgeType.value = (state.layoutEdgeType as string) ?? null
    useScoreAsWeight.value = (state.useScoreAsWeight as boolean) ?? true

    // Re-inject edges into graph
    if (similarityEdges.value.length > 0) {
      injectEdges()
    }
  }

  // ============================================================================
  // Watchers
  // ============================================================================

  // Clear similarity edges when graph data changes (new query, etc.)
  watch(
    () => useGraphStore().nodes,
    () => {
      if (hasResults.value) {
        removeEdges()
        similarityEdges.value = []
        error.value = null
      }
    },
  )

  // ============================================================================
  // Return
  // ============================================================================

  return {
    // State
    similarityEdges,
    computing,
    loadingEndpoints,
    needsLayoutAfterCompute,
    error,
    availableEndpoints,
    selectedEndpoint,
    selectedNodeType,
    keyProperty,
    isJsonString,
    jsonPath,
    endpointParams,
    displayMode,
    scoreThreshold,
    layoutStrategy,
    layoutEdgeType,
    useScoreAsWeight,

    // Computed
    hasResults,
    resultStats,

    // Actions
    fetchEndpoints,
    runComputation,
    extractKeys,
    clearSimilarity,
    setDisplayMode,
    injectEdges,
    removeEdges,
    getState,
    loadState,
  }
})
