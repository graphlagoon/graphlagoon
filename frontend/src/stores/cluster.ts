import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { recordPerf } from '@/utils/perfMetrics'
import type {
  Cluster,
  ClusterProgram,
  ClusterProgramContext,
  ClusterProgramResult,
  ClusterProgramExecution,
  ClusterStoreState,
  CreateClusterProgramInput,
  UpdateClusterProgramInput,
  CreateClusterInput,
} from '@/types/cluster'
import { useGraphStore } from '@/stores/graph'

const STORAGE_KEY = 'graphlagoon-studio-clusters'

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
   */
  function createProgram(input: CreateClusterProgramInput): ClusterProgram {
    const newProgram: ClusterProgram = {
      program_id: input.program_id || crypto.randomUUID(), // Use provided ID or generate one
      program_name: input.program_name,
      description: input.description,
      code: input.code,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    programs.value.push(newProgram)
    // Don't auto-save to localStorage - programs are saved as part of exploration state

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

    programs.value[index] = {
      ...programs.value[index],
      ...updates,
      updated_at: new Date().toISOString(),
    }

    // Don't auto-save to localStorage - programs are saved as part of exploration state
    return true
  }

  /**
   * Delete a cluster program
   */
  function deleteProgram(programId: string): boolean {
    const initialLength = programs.value.length
    programs.value = programs.value.filter(p => p.program_id !== programId)

    if (programs.value.length < initialLength) {
      // Also remove execution history for this program
      executions.value = executions.value.filter(e => e.program_id !== programId)
      // Don't auto-save to localStorage - programs are saved as part of exploration state
      return true
    }

    error.value = 'Program not found'
    return false
  }

  /**
   * Get a cluster program by ID
   */
  function getProgram(programId: string): ClusterProgram | undefined {
    return programs.value.find(p => p.program_id === programId)
  }

  /**
   * Execute a cluster program
   *
   * The program receives a context with graph data and must return an array of clusters.
   * Generated clusters replace any existing clusters.
   */
  async function executeProgram(programId: string): Promise<ClusterProgramResult> {
    const program = programs.value.find(p => p.program_id === programId)
    if (!program) {
      const errorMsg = 'Program not found'
      error.value = errorMsg
      return { success: false, error: errorMsg }
    }

    loading.value = true
    error.value = null

    const startTime = performance.now()

    try {
      // Prepare execution context
      const graphStore = useGraphStore()
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
      }

      // Execute user code in a function context
      // Note: Using Function constructor to eval the code
      // The code should return an array of cluster objects
      const fn = new Function('context', `
        'use strict';
        const { nodes, edges, selectedNodeIds, selectedEdgeIds } = context;

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

      const duration = performance.now() - startTime
      recordPerf('clusterProgramExec', duration, { clustersGenerated: newClusters.length })

      // Merge clusters: replace all clusters from this program, keep clusters from other programs
      const existingClusters = clusters.value.filter(
        existing => existing.source_program_id !== programId
      )
      clusters.value = [...existingClusters, ...newClusters]

      // Record execution
      const execution: ClusterProgramExecution = {
        program_id: programId,
        executed_at: new Date().toISOString(),
        clusters_generated: newClusters.length,
        duration_ms: Math.round(duration),
      }
      executions.value.push(execution)

      // Keep only last 50 executions
      if (executions.value.length > 50) {
        executions.value = executions.value.slice(-50)
      }

      // Don't auto-save to localStorage - clusters are saved as part of exploration state

      return {
        success: true,
        clusters: newClusters,
        duration_ms: Math.round(duration),
      }
    } catch (e) {
      const duration = performance.now() - startTime
      const errorDuration = performance.now() - startTime
      recordPerf('clusterProgramExec:error', errorDuration)
      const errorMsg = e instanceof Error ? e.message : 'Unknown error during execution'
      error.value = errorMsg

      // Record failed execution
      const execution: ClusterProgramExecution = {
        program_id: programId,
        executed_at: new Date().toISOString(),
        clusters_generated: 0,
        error: errorMsg,
        duration_ms: Math.round(duration),
      }
      executions.value.push(execution)

      if (executions.value.length > 50) {
        executions.value = executions.value.slice(-50)
      }

      // Don't auto-save to localStorage - clusters are saved as part of exploration state

      return {
        success: false,
        error: errorMsg,
        duration_ms: Math.round(duration),
      }
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
   * Clear all programs
   */
  function clearPrograms() {
    programs.value = []
    executions.value = []
    // Recreate default programs in memory
    createDefaultPrograms()
  }

  /**
   * Clear everything (programs, clusters, executions)
   */
  function clearAll() {
    programs.value = []
    clusters.value = []
    executions.value = []
    error.value = null
    // Recreate default programs in memory
    createDefaultPrograms()
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  /**
   * Get complete cluster state for persistence
   */
  function getState(): ClusterStoreState {
    return {
      programs: programs.value,
      clusters: clusters.value,
      executions: executions.value,
    }
  }

  /**
   * Load cluster state from external source
   */
  function loadState(state: ClusterStoreState | null | undefined) {
    if (state) {
      programs.value = state.programs || []
      clusters.value = state.clusters || []
      executions.value = state.executions || []
    } else {
      // Reset to empty state
      programs.value = []
      clusters.value = []
      executions.value = []
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
   * These are NOT saved to localStorage - they're just default templates
   */
  // Fixed IDs for default programs (consistent across sessions)
  const DEFAULT_PROGRAM_IDS = {
    ORPHAN_CLUSTERS: 'default-orphan-clusters',
    GROUP_BY_TYPE: 'default-group-by-node-type',
  }

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

    // Cluster Actions
    createCluster,
    updateCluster,
    deleteCluster,
    toggleClusterState,
    openCluster,
    closeCluster,
    clearClusters,
    clearPrograms,
    clearAll,

    // Persistence
    getState,
    loadState,
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
