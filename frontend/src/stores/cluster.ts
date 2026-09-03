import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { recordPerf } from '@/utils/perfMetrics'
import type {
  Cluster,
  ClusterProgram,
  ClusterProgramContext,
  ClusterProgramResult,
  ClusterProgramExecution,
  ClusterProgramParamValues,
  ClusterStoreState,
  CreateClusterProgramInput,
  UpdateClusterProgramInput,
  CreateClusterInput,
} from '@/types/cluster'
import { resolveParamValues } from '@/utils/clusterProgramParams'
import { useGraphStore } from '@/stores/graph'
import { useMetricsStore } from '@/stores/metrics'
import { api } from '@/services/api'
import { useToast } from '@/composables/useToast'

const STORAGE_KEY = 'graphlagoon-studio-clusters'

// Fixed IDs for the built-in default programs (consistent across sessions).
// Built-ins are recreated from code on every hydration and never persisted.
export const DEFAULT_PROGRAM_IDS = {
  ORPHAN_CLUSTERS: 'default-orphan-clusters',
  GROUP_BY_TYPE: 'default-group-by-node-type',
  BFS_FROM_NODE: 'default-bfs-from-node',
}

export function isDefaultProgramId(programId: string): boolean {
  return Object.values(DEFAULT_PROGRAM_IDS).includes(programId)
}

/** Delay before a program mutation is pushed to the context (batches rapid edits). */
const PERSIST_DEBOUNCE_MS = 500

/**
 * Cluster Store
 *
 * Manages cluster programs and clusters for programmatic node grouping.
 * Clusters are virtual aggregations that simplify graph visualization.
 */
export const useClusterStore = defineStore('cluster', () => {
  // ============================================================================
  // State
  // ============================================================================

  const programs = ref<ClusterProgram[]>([])
  const clusters = ref<Cluster[]>([])
  const executions = ref<ClusterProgramExecution[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  // ============================================================================
  // Computed
  // ============================================================================

  /**
   * Clusters that are currently expanded (open)
   */
  const openClusters = computed(() =>
    clusters.value.filter(c => c.state === 'open')
  )

  /**
   * Clusters that are currently collapsed (closed)
   */
  const closedClusters = computed(() =>
    clusters.value.filter(c => c.state === 'closed')
  )

  /**
   * Map of node_id -> cluster_id[] for closed clusters only
   * Used to determine which nodes should be hidden and where to redirect edges
   */
  const nodeToClosedClusters = computed(() => {
    const map = new Map<string, string[]>()

    closedClusters.value.forEach(cluster => {
      cluster.node_ids.forEach(nodeId => {
        const existing = map.get(nodeId) || []
        existing.push(cluster.cluster_id)
        map.set(nodeId, existing)
      })
    })

    return map
  })

  /**
   * Set of node IDs that are currently visible
   *
   * Logic:
   * - All original graph nodes are visible by default
   * - Nodes in closed clusters are hidden
   * - BUT: If a node is in multiple clusters and at least one is open, it stays visible
   */
  const nodeToOpenClusters = computed(() => {
    const map = new Map<string, string[]>()
    openClusters.value.forEach(cluster => {
      cluster.node_ids.forEach(nodeId => {
        const existing = map.get(nodeId) || []
        existing.push(cluster.cluster_id)
        map.set(nodeId, existing)
      })
    })
    return map
  })

  const visibleNodeIds = computed(() => {
    const graphStore = useGraphStore()
    const visible = new Set<string>()

    // Start with all original nodes
    graphStore.nodes.forEach(n => visible.add(n.node_id))

    // Use pre-computed maps for O(1) lookups instead of O(C*K) per node
    const closedMap = nodeToClosedClusters.value
    const openMap = nodeToOpenClusters.value

    // Only iterate nodes that are in closed clusters
    for (const nodeId of closedMap.keys()) {
      // Hide only if in closed cluster(s) and NOT in any open cluster
      if (!openMap.has(nodeId)) {
        visible.delete(nodeId)
      }
    }

    return visible
  })

  /**
   * Count of clusters by class
   */
  const clustersByClass = computed(() => {
    const counts = new Map<string, number>()
    clusters.value.forEach(c => {
      counts.set(c.cluster_class, (counts.get(c.cluster_class) || 0) + 1)
    })
    return counts
  })

  /**
   * Statistics about clusters
   */
  const clusterStats = computed(() => ({
    total: clusters.value.length,
    open: openClusters.value.length,
    closed: closedClusters.value.length,
    totalNodes: clusters.value.reduce((sum, c) => sum + c.node_ids.length, 0),
    avgNodesPerCluster: clusters.value.length > 0
      ? Math.round(clusters.value.reduce((sum, c) => sum + c.node_ids.length, 0) / clusters.value.length)
      : 0,
  }))

  // ============================================================================
  // Cluster Program Actions
  // ============================================================================

  /**
   * Create a new cluster program
   *
   * Scope defaults to 'context' when the user can write to the current context,
   * 'exploration' otherwise. Built-in default programs get no scope.
   */
  function createProgram(input: CreateClusterProgramInput): ClusterProgram {
    const programId = input.program_id || crypto.randomUUID()
    const scope = isDefaultProgramId(programId)
      ? undefined
      : input.scope ?? (contextWritable() ? 'context' : 'exploration')

    const newProgram: ClusterProgram = {
      program_id: programId,
      program_name: input.program_name,
      description: input.description,
      code: input.code,
      parameters: input.parameters,
      show_in_context_menu: input.show_in_context_menu,
      scope,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    programs.value.push(newProgram)

    if (scope === 'context') {
      persistProgramsToContext()
    }

    return newProgram
  }

  /**
   * Update an existing cluster program
   */
  function updateProgram(programId: string, updates: UpdateClusterProgramInput): boolean {
    const index = programs.value.findIndex(p => p.program_id === programId)
    if (index === -1) {
      error.value = 'Program not found'
      return false
    }

    const wasContextScoped = programs.value[index].scope === 'context'

    programs.value[index] = {
      ...programs.value[index],
      ...updates,
      updated_at: new Date().toISOString(),
    }

    // A scope change in either direction alters the context's program set
    if (wasContextScoped || programs.value[index].scope === 'context') {
      persistProgramsToContext()
    }
    return true
  }

  /**
   * Delete a cluster program (built-in defaults cannot be deleted)
   */
  function deleteProgram(programId: string): boolean {
    if (isDefaultProgramId(programId)) {
      error.value = 'Default programs cannot be deleted'
      return false
    }

    const removed = programs.value.find(p => p.program_id === programId)
    if (!removed) {
      error.value = 'Program not found'
      return false
    }

    programs.value = programs.value.filter(p => p.program_id !== programId)
    // Also remove execution history for this program
    executions.value = executions.value.filter(e => e.program_id !== programId)

    if (removed.scope === 'context') {
      persistProgramsToContext()
    }
    return true
  }

  /**
   * Get a cluster program by ID
   */
  function getProgram(programId: string): ClusterProgram | undefined {
    return programs.value.find(p => p.program_id === programId)
  }

  /**
   * Compute the clusters produced by a program WITHOUT mutating store state.
   *
   * Runs the program's user code and validates its output, returning the
   * normalized `Cluster[]` (each tagged with `source_program_id`). This does
   * NOT touch `clusters.value`, `executions`, `loading`, or `error`, and does
   * NOT record perf — so it can be reused by callers that only want the result
   * (e.g. using a cluster program as a community algorithm) without creating
   * the collapsed geometry side effects.
   *
   * `paramValues` fills the program's declared parameters (exposed to the code
   * as `params.<id>`). When omitted, declared defaults are used.
   */
  function computeClustersFromProgram(
    programId: string,
    paramValues?: ClusterProgramParamValues
  ): ClusterProgramResult {
    const program = programs.value.find(p => p.program_id === programId)
    if (!program) {
      return { success: false, error: 'Program not found' }
    }

    const startTime = performance.now()

    const resolved = resolveParamValues(program.parameters, paramValues)
    if (!resolved.success) {
      return {
        success: false,
        error: resolved.error,
        duration_ms: Math.round(performance.now() - startTime),
      }
    }

    try {
      // Prepare execution context
      const graphStore = useGraphStore()
      const metricsStore = useMetricsStore()
      const context: ClusterProgramContext = {
        nodes: graphStore.nodes.map(n => ({
          node_id: n.node_id,
          node_type: n.node_type,
          properties: n.properties,
        })),
        edges: graphStore.edges.map(e => ({
          edge_id: e.edge_id,
          src: e.src,
          dst: e.dst,
          relationship_type: e.relationship_type,
          properties: e.properties,
        })),
        selectedNodeIds: Array.from(graphStore.selectedNodeIds),
        selectedEdgeIds: Array.from(graphStore.selectedEdgeIds),
        params: resolved.params,
        // A name shared by a node and an edge metric resolves node-first;
        // programs iterate both, so the lookup cannot be target-scoped.
        metric: (ref, id) => {
          const nodeValue = metricsStore.metricResolver('node', id, ref)
          return nodeValue !== undefined ? nodeValue : metricsStore.metricResolver('edge', id, ref)
        },
        metrics: [...metricsStore.nodeMetrics, ...metricsStore.edgeMetrics].map(m => ({
          id: m.id,
          name: m.name,
          target: m.target as 'node' | 'edge',
          valueType: m.valueType,
        })),
      }

      // Execute user code in a function context
      // Note: Using Function constructor to eval the code
      // The code should return an array of cluster objects
      // (`metric`/`metrics` are in scope — a program declaring its own
      // top-level const with either name would now throw a redeclaration)
      const fn = new Function('context', `
        'use strict';
        const { nodes, edges, selectedNodeIds, selectedEdgeIds, params, metric, metrics } = context;

        // User code:
        ${program.code}
      `)

      const result = fn(context)

      // Validate result
      if (!Array.isArray(result)) {
        throw new Error('Program must return an array of clusters. Got: ' + typeof result)
      }

      // Validate and normalize cluster objects
      const newClusters: Cluster[] = result.map((clusterData: any, index: number) => {
        // Validate required fields
        if (!clusterData.cluster_name) {
          throw new Error(`Cluster at index ${index} missing required field: cluster_name`)
        }
        if (!Array.isArray(clusterData.node_ids)) {
          throw new Error(`Cluster at index ${index}: node_ids must be an array`)
        }

        // Build cluster with defaults
        const cluster: Cluster = {
          cluster_id: clusterData.cluster_id || crypto.randomUUID(),
          cluster_name: clusterData.cluster_name,
          cluster_class: clusterData.cluster_class || 'default',
          figure: clusterData.figure || 'circle',
          state: clusterData.state || 'closed',
          node_ids: clusterData.node_ids,
          color: clusterData.color,
          description: clusterData.description,
        }

        // Validate figure
        const validFigures = ['circle', 'box', 'diamond', 'hexagon', 'star']
        if (!validFigures.includes(cluster.figure)) {
          throw new Error(
            `Cluster "${cluster.cluster_name}": invalid figure "${cluster.figure}". ` +
            `Must be one of: ${validFigures.join(', ')}`
          )
        }

        // Validate state
        if (cluster.state !== 'open' && cluster.state !== 'closed') {
          throw new Error(
            `Cluster "${cluster.cluster_name}": invalid state "${cluster.state}". ` +
            `Must be "open" or "closed"`
          )
        }

        // Validate node_ids reference existing nodes
        const validNodeIds = new Set(context.nodes.map(n => n.node_id))
        const invalidNodeIds = cluster.node_ids.filter(id => !validNodeIds.has(id))
        if (invalidNodeIds.length > 0) {
          throw new Error(
            `Cluster "${cluster.cluster_name}": invalid node_ids: ${invalidNodeIds.slice(0, 5).join(', ')}` +
            (invalidNodeIds.length > 5 ? ` (and ${invalidNodeIds.length - 5} more)` : '')
          )
        }

        // Tag cluster with source program for merge logic
        cluster.source_program_id = programId

        return cluster
      })

      return {
        success: true,
        clusters: newClusters,
        duration_ms: Math.round(performance.now() - startTime),
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : 'Unknown error during execution'
      return {
        success: false,
        error: errorMsg,
        duration_ms: Math.round(performance.now() - startTime),
      }
    }
  }

  /**
   * Execute a cluster program
   *
   * The program receives a context with graph data and must return an array of clusters.
   * Generated clusters replace any existing clusters from the same program.
   *
   * Thin wrapper around `computeClustersFromProgram` that applies the store-level
   * side effects: merging into `clusters.value`, recording execution history, and
   * perf metrics.
   */
  async function executeProgram(
    programId: string,
    paramValues?: ClusterProgramParamValues
  ): Promise<ClusterProgramResult> {
    if (!programs.value.some(p => p.program_id === programId)) {
      const errorMsg = 'Program not found'
      error.value = errorMsg
      return { success: false, error: errorMsg }
    }

    loading.value = true
    error.value = null

    const paramsUsed =
      paramValues && Object.keys(paramValues).length > 0 ? paramValues : undefined

    try {
      const result = computeClustersFromProgram(programId, paramValues)
      const duration = result.duration_ms ?? 0

      if (!result.success) {
        recordPerf('clusterProgramExec:error', duration)
        error.value = result.error ?? 'Unknown error during execution'

        // Record failed execution
        executions.value.push({
          program_id: programId,
          executed_at: new Date().toISOString(),
          clusters_generated: 0,
          error: error.value,
          duration_ms: duration,
          params_used: paramsUsed,
        })
        if (executions.value.length > 50) {
          executions.value = executions.value.slice(-50)
        }

        return result
      }

      const newClusters = result.clusters ?? []
      recordPerf('clusterProgramExec', duration, { clustersGenerated: newClusters.length })

      // Merge clusters: replace all clusters from this program, keep clusters from other programs
      const existingClusters = clusters.value.filter(
        existing => existing.source_program_id !== programId
      )
      clusters.value = [...existingClusters, ...newClusters]

      // Record execution
      executions.value.push({
        program_id: programId,
        executed_at: new Date().toISOString(),
        clusters_generated: newClusters.length,
        duration_ms: duration,
        params_used: paramsUsed,
      })
      if (executions.value.length > 50) {
        executions.value = executions.value.slice(-50)
      }

      // Don't auto-save to localStorage - clusters are saved as part of exploration state
      return result
    } finally {
      loading.value = false
    }
  }

  // ============================================================================
  // Cluster Actions
  // ============================================================================

  /**
   * Create a cluster manually (without running a program)
   * If cluster_id is not provided, uses cluster_name as the ID
   */
  function createCluster(input: CreateClusterInput): Cluster {
    const newCluster: Cluster = {
      ...input,
      cluster_id: input.cluster_id || input.cluster_name,
    }

    clusters.value.push(newCluster)
    // Don't auto-save to localStorage - clusters are saved as part of exploration state

    return newCluster
  }

  /**
   * Update an existing cluster
   */
  function updateCluster(clusterId: string, updates: Partial<Omit<Cluster, 'cluster_id'>>): boolean {
    const index = clusters.value.findIndex(c => c.cluster_id === clusterId)
    if (index === -1) {
      error.value = 'Cluster not found'
      return false
    }

    clusters.value[index] = {
      ...clusters.value[index],
      ...updates,
    }

    // Don't auto-save to localStorage - clusters are saved as part of exploration state
    return true
  }

  /**
   * Delete a cluster
   */
  function deleteCluster(clusterId: string): boolean {
    const initialLength = clusters.value.length
    clusters.value = clusters.value.filter(c => c.cluster_id !== clusterId)

    if (clusters.value.length < initialLength) {
      // Don't auto-save to localStorage - clusters are saved as part of exploration state
      return true
    }

    error.value = 'Cluster not found'
    return false
  }

  /** Put a deleted cluster back where it was (undo). */
  function restoreCluster(cluster: Cluster, index: number): void {
    const next = [...clusters.value]
    next.splice(Math.max(0, Math.min(index, next.length)), 0, cluster)
    clusters.value = next
  }

  /**
   * Toggle a cluster's state (open <-> closed)
   */
  function toggleClusterState(clusterId: string): boolean {
    const cluster = clusters.value.find(c => c.cluster_id === clusterId)
    if (!cluster) {
      error.value = 'Cluster not found'
      return false
    }

    cluster.state = cluster.state === 'open' ? 'closed' : 'open'
    // Don't auto-save to localStorage - clusters are saved as part of exploration state

    return true
  }

  /**
   * Open a cluster (expand it)
   */
  function openCluster(clusterId: string): boolean {
    return updateCluster(clusterId, { state: 'open' })
  }

  /**
   * Close a cluster (collapse it)
   */
  function closeCluster(clusterId: string): boolean {
    return updateCluster(clusterId, { state: 'closed' })
  }

  /**
   * Clear all clusters
   */
  function clearClusters() {
    clusters.value = []
    // Don't auto-save to localStorage
  }

  /**
   * Clear all programs (resets to built-in defaults + current context's programs)
   */
  function clearPrograms() {
    executions.value = []
    hydrateProgramsFromContext(useGraphStore().currentContext?.cluster_programs)
  }

  /**
   * Clear everything (programs, clusters, executions)
   */
  function clearAll() {
    clusters.value = []
    executions.value = []
    error.value = null
    hydrateProgramsFromContext(useGraphStore().currentContext?.cluster_programs)
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  function contextWritable(): boolean {
    return useGraphStore().currentContext?.has_write_access === true
  }

  // Guards against persisting while programs are being rebuilt from
  // context/exploration data (hydration must never trigger a PUT).
  let isHydrating = false
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Push context-scoped programs to the backend (debounced, fire-and-forget).
   * Built-in defaults and exploration-scoped programs are never sent.
   */
  function persistProgramsToContext() {
    if (isHydrating) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      void doPersist()
    }, PERSIST_DEBOUNCE_MS)
  }

  async function doPersist(): Promise<void> {
    const graphStore = useGraphStore()
    const context = graphStore.currentContext
    if (!context || !context.has_write_access) return

    const payload = programs.value.filter(
      p => p.scope === 'context' && !isDefaultProgramId(p.program_id)
    )

    try {
      const updated = await api.updateGraphContext(context.id, {
        cluster_programs: payload,
      })
      // Keep the local context record in sync so a later hydrate is consistent
      if (graphStore.currentContext?.id === updated.id) {
        graphStore.currentContext = updated
      }
    } catch (e) {
      console.warn('Failed to persist cluster programs to context:', e)
      error.value = 'Failed to save cluster programs to the context'
      // The error ref is not rendered anywhere — surface the silent
      // persistence failure directly (technical debt #7).
      useToast().error('Failed to save cluster programs to the context')
    }
  }

  /**
   * Immediately run any pending debounced persist (used on unmount and in tests)
   */
  async function flushPersist(): Promise<void> {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
      await doPersist()
    }
  }

  /**
   * Rebuild the program list from the built-in defaults plus the given
   * context-level programs. A context program with a default's id replaces the
   * built-in (defensive; persist filters defaults out). Exploration-scoped
   * programs are dropped — callers re-add them via loadState.
   */
  function hydrateProgramsFromContext(contextPrograms?: ClusterProgram[]) {
    isHydrating = true
    try {
      createDefaultPrograms()
      for (const program of contextPrograms ?? []) {
        const normalized: ClusterProgram = { ...program, scope: 'context' }
        const index = programs.value.findIndex(p => p.program_id === program.program_id)
        if (index === -1) {
          programs.value.push(normalized)
        } else {
          programs.value[index] = normalized
        }
      }
    } finally {
      isHydrating = false
    }
  }

  /**
   * Get cluster state for exploration persistence.
   *
   * Programs now live on the graph context (`graph_contexts.cluster_programs`);
   * only exploration-scoped programs are embedded in the exploration state.
   */
  function getState(): ClusterStoreState {
    return {
      programs: programs.value.filter(
        p => p.scope === 'exploration' && !isDefaultProgramId(p.program_id)
      ),
      clusters: clusters.value,
      executions: executions.value,
    }
  }

  /**
   * Load cluster state from a saved exploration.
   *
   * Clusters/executions are replaced wholesale (they are per-exploration).
   * Programs are NOT replaced: context-scoped programs and built-in defaults
   * survive; the exploration only contributes its exploration-scoped programs.
   * Legacy programs (saved before scopes existed) are imported into the context
   * when the user has write access there, kept exploration-local otherwise.
   */
  function loadState(state: ClusterStoreState | null | undefined) {
    clusters.value = state?.clusters || []
    executions.value = state?.executions || []

    isHydrating = true
    let importedToContext = false
    try {
      // Drop the previous exploration's programs
      programs.value = programs.value.filter(p => p.scope !== 'exploration')

      for (const saved of state?.programs || []) {
        if (isDefaultProgramId(saved.program_id)) continue
        if (programs.value.some(p => p.program_id === saved.program_id)) continue

        if (saved.scope === 'exploration') {
          programs.value.push(saved)
        } else if (saved.scope === 'context') {
          // Context-scoped but missing from the context (e.g. saved from a
          // session whose persist failed) — restore it to the context set.
          programs.value.push(saved)
          importedToContext = true
        } else {
          // Legacy program without scope
          if (contextWritable()) {
            programs.value.push({ ...saved, scope: 'context' })
            importedToContext = true
          } else {
            programs.value.push({ ...saved, scope: 'exploration' })
          }
        }
      }
    } finally {
      isHydrating = false
    }

    if (importedToContext) {
      persistProgramsToContext()
    }
    error.value = null
  }

  /**
   * Save state to localStorage
   */
  function saveToLocalStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(getState()))
    } catch (e) {
      console.error('Failed to save cluster state to localStorage:', e)
    }
  }

  /**
   * Load state from localStorage
   */
  function loadFromLocalStorage() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const state = JSON.parse(stored) as ClusterStoreState
        loadState(state)
      }
    } catch (e) {
      console.error('Failed to load cluster state from localStorage:', e)
    }
  }

  /**
   * Clear localStorage
   */
  function clearLocalStorage() {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch (e) {
      console.error('Failed to clear cluster state from localStorage:', e)
    }
  }

  // ============================================================================
  // Utility Functions
  // ============================================================================

  /**
   * Get all nodes in a cluster
   */
  function getClusterNodes(clusterId: string) {
    const cluster = clusters.value.find(c => c.cluster_id === clusterId)
    if (!cluster) return []

    const nodeIdSet = new Set(cluster.node_ids)
    const graphStore = useGraphStore()
    return graphStore.nodes.filter(n => nodeIdSet.has(n.node_id))
  }

  /**
   * Check if a node is in any cluster
   */
  function isNodeInCluster(nodeId: string): boolean {
    // Use pre-computed maps for O(1) lookup
    const closedMap = nodeToClosedClusters.value
    const openMap = nodeToOpenClusters.value
    return closedMap.has(nodeId) || openMap.has(nodeId)
  }

  /**
   * Get all clusters that contain a specific node
   */
  function getClustersForNode(nodeId: string): Cluster[] {
    return clusters.value.filter(c => c.node_ids.includes(nodeId))
  }

  /**
   * Get execution history for a program
   */
  function getExecutionHistory(programId: string): ClusterProgramExecution[] {
    return executions.value
      .filter(e => e.program_id === programId)
      .sort((a, b) => new Date(b.executed_at).getTime() - new Date(a.executed_at).getTime())
  }

  // ============================================================================
  // Default Programs
  // ============================================================================

  /**
   * Create default programs in memory (always called on initialization)
   * These are NOT persisted - they're just default templates
   */
  function createDefaultPrograms() {
    // Clear existing programs first
    programs.value = []

    // Program 1: Orphan Clusters
    // Find nodes that connect to a hub node but nowhere else
    createProgram({
      program_id: DEFAULT_PROGRAM_IDS.ORPHAN_CLUSTERS,
      program_name: 'Orphan Clusters',
      description: 'Groups orphan nodes that only connect to a single hub (min 3 nodes per cluster)',
      code: `// Find orphan nodes connected to hubs
// An orphan node connects to exactly one other node and nowhere else

const hubOrphans = new Map(); // hub_id -> [orphan_ids]

// Build adjacency map
const nodeConnections = new Map(); // node_id -> Set<connected_node_ids>
edges.forEach(edge => {
  if (!nodeConnections.has(edge.src)) {
    nodeConnections.set(edge.src, new Set());
  }
  if (!nodeConnections.has(edge.dst)) {
    nodeConnections.set(edge.dst, new Set());
  }
  nodeConnections.get(edge.src).add(edge.dst);
  nodeConnections.get(edge.dst).add(edge.src);
});

// Find orphan nodes (nodes with exactly 1 connection)
nodes.forEach(node => {
  const connections = nodeConnections.get(node.node_id);
  if (connections && connections.size === 1) {
    const hubId = Array.from(connections)[0];

    if (!hubOrphans.has(hubId)) {
      hubOrphans.set(hubId, []);
    }
    hubOrphans.get(hubId).push(node.node_id);
  }
});

// Create clusters for hubs with at least 3 orphans
const clusters = [];
const colors = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef'];
let colorIndex = 0;

hubOrphans.forEach((orphanIds, hubId) => {
  if (orphanIds.length >= 3) {
    clusters.push({
      cluster_name: \`cluster_orphan_\${hubId}\`,
      cluster_class: 'orphan',
      figure: 'star',
      state: 'closed',
      node_ids: orphanIds,
      color: colors[colorIndex % colors.length], // Assign different color to each cluster
      description: \`\${orphanIds.length} orphan nodes connected only to \${hubId}\`
    });
    colorIndex++;
  }
});

return clusters;`,
    })

    // Program 2: Group by Type
    createProgram({
      program_id: DEFAULT_PROGRAM_IDS.GROUP_BY_TYPE,
      program_name: 'Group by Node Type',
      description: 'Groups all nodes by their node_type property',
      code: `// Group nodes by type
const clustersByType = new Map();

nodes.forEach(node => {
  if (!clustersByType.has(node.node_type)) {
    clustersByType.set(node.node_type, []);
  }
  clustersByType.get(node.node_type).push(node.node_id);
});

const clusters = [];
const figures = ['circle', 'box', 'diamond', 'hexagon', 'star'];
const colors = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef'];
let index = 0;

clustersByType.forEach((nodeIds, nodeType) => {
  clusters.push({
    cluster_name: \`\${nodeType} Cluster\`,
    cluster_class: 'by-type',
    figure: figures[index % figures.length],
    state: 'closed',
    node_ids: nodeIds,
    color: colors[index % colors.length], // Assign different color to each cluster
    description: \`All \${nodeIds.length} nodes of type \${nodeType}\`
  });
  index++;
});

return clusters;`,
    })

    // Program 3: BFS from Node
    // Parameterized: start node id, depth (1-3), and an optional node-type allow list
    createProgram({
      program_id: DEFAULT_PROGRAM_IDS.BFS_FROM_NODE,
      program_name: 'BFS from Node',
      description: 'Clusters nodes by BFS depth from a start node, optionally traversing only allowed node types',
      show_in_context_menu: true,
      parameters: [
        {
          id: 'start_node_id',
          type: 'text',
          label: 'Start node ID',
          placeholder: 'e.g. a1738368-...',
          required: true,
          node_binding: 'node_id',
        },
        {
          id: 'depth',
          type: 'select',
          label: 'Depth',
          options: ['1', '2', '3'],
          default: '3',
          required: true,
        },
        {
          id: 'allow_types',
          type: 'text',
          label: 'Allowed node types',
          description: 'Comma-separated node types the BFS may traverse. Empty = all types allowed.',
          placeholder: 'e.g. Person, Company',
          required: false,
        },
        {
          id: 'group_by_level',
          type: 'boolean',
          label: 'One cluster per depth level',
          description: 'Off = a single cluster with every reached node (root included). On = start + one ring per depth.',
          default: false,
          required: false,
        },
      ],
      code: `// BFS from a start node.
// Default: returns ONE cluster with the start node plus everything reached
// (so, used as a community algorithm, you get exactly two communities: the
// BFS set and "others"). With params.group_by_level, returns the start node
// plus one cluster per depth ring instead.
// Only traverses nodes whose type is in the allow list (params.allow_types,
// comma-separated; empty = all types). Nodes outside the allow list are
// dropped (not visited and not traversed through). The start node is always
// included since it is explicitly requested by id.

const depth = Number(params.depth);
const allowRaw = (params.allow_types || '').trim();
const allowedTypes = allowRaw
  ? new Set(allowRaw.split(',').map(s => s.trim()).filter(Boolean))
  : null;

const typeById = new Map(nodes.map(n => [n.node_id, n.node_type]));
if (!typeById.has(params.start_node_id)) {
  throw new Error('Start node "' + params.start_node_id + '" not found in the graph');
}

// Undirected adjacency map
const adj = new Map();
edges.forEach(edge => {
  if (!adj.has(edge.src)) adj.set(edge.src, []);
  if (!adj.has(edge.dst)) adj.set(edge.dst, []);
  adj.get(edge.src).push(edge.dst);
  adj.get(edge.dst).push(edge.src);
});

const visited = new Set([params.start_node_id]);
let frontier = [params.start_node_id];
const levels = [];

for (let level = 1; level <= depth; level++) {
  const next = [];
  for (const nodeId of frontier) {
    for (const neighbor of (adj.get(nodeId) || [])) {
      if (visited.has(neighbor)) continue;
      if (allowedTypes && !allowedTypes.has(typeById.get(neighbor))) continue;
      visited.add(neighbor);
      next.push(neighbor);
    }
  }
  if (next.length === 0) break;
  levels.push(next);
  frontier = next;
}

if (!params.group_by_level) {
  // Single cluster: start node + everything reached (visited already holds both)
  const reached = Array.from(visited);
  return [{
    cluster_name: 'BFS from ' + params.start_node_id,
    cluster_class: 'bfs',
    figure: 'circle',
    state: 'open',
    node_ids: reached,
    color: '#3b82f6',
    description: reached.length + ' node(s) within depth ' + depth + ' of ' + params.start_node_id
  }];
}

const colors = ['#3b82f6', '#10b981', '#f59e0b'];
const clusters = [{
  cluster_name: 'BFS start: ' + params.start_node_id,
  cluster_class: 'bfs',
  figure: 'star',
  state: 'open',
  node_ids: [params.start_node_id],
  color: '#ef4444',
  description: 'Start node of the BFS'
}];

levels.forEach((nodeIds, i) => {
  clusters.push({
    cluster_name: 'BFS depth ' + (i + 1),
    cluster_class: 'bfs',
    figure: 'circle',
    state: 'open',
    node_ids: nodeIds,
    color: colors[i % colors.length],
    description: nodeIds.length + ' node(s) at depth ' + (i + 1) + ' from ' + params.start_node_id
  });
});

return clusters;`,
    })

    // Don't save to localStorage - these are just in-memory defaults
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  // DON'T load from localStorage on store creation
  // Clusters should only be loaded from exploration state
  // This prevents old clusters from appearing in new contexts

  // Create default programs if this is the first time
  createDefaultPrograms()

  // Clear clusters when graph data changes (query executed, subgraph loaded, etc.)
  // Clusters reference node_ids that may no longer exist after a new query.
  watch(
    () => useGraphStore().nodes,
    () => {
      if (clusters.value.length > 0) {
        clearClusters()
      }
    },
  )

  // ============================================================================
  // Return
  // ============================================================================

  return {
    // State
    programs,
    clusters,
    executions,
    loading,
    error,

    // Computed
    openClusters,
    closedClusters,
    nodeToClosedClusters,
    visibleNodeIds,
    clustersByClass,
    clusterStats,

    // Program Actions
    createProgram,
    updateProgram,
    deleteProgram,
    getProgram,
    executeProgram,
    computeClustersFromProgram,

    // Cluster Actions
    createCluster,
    updateCluster,
    deleteCluster,
    restoreCluster,
    toggleClusterState,
    openCluster,
    closeCluster,
    clearClusters,
    clearPrograms,
    clearAll,

    // Persistence
    getState,
    loadState,
    hydrateProgramsFromContext,
    flushPersist,
    saveToLocalStorage,
    loadFromLocalStorage,
    clearLocalStorage,

    // Utility
    getClusterNodes,
    isNodeInCluster,
    getClustersForNode,
    getExecutionHistory,
  }
})
