/**
 * Cluster Programs Feature
 *
 * This module defines types for the cluster programs feature, which allows users
 * to programmatically group nodes into clusters using JavaScript code.
 */

/**
 * Geometric figure/shape used to render a cluster node
 */
export type ClusterFigure = 'circle' | 'box' | 'diamond' | 'hexagon' | 'star';

/**
 * State of a cluster (expanded or collapsed)
 */
export type ClusterState = 'open' | 'closed';

/**
 * A cluster represents a grouping of nodes
 *
 * Key behaviors:
 * - A node can belong to multiple clusters (N:M relationship)
 * - When closed, cluster is rendered as a single node
 * - When open, internal nodes are visible normally
 * - Edges to internal nodes are aggregated to the cluster node when closed
 */
export interface Cluster {
  /** Unique identifier (auto-generated UUID) */
  cluster_id: string;

  /** Human-readable name (not necessarily unique) */
  cluster_name: string;

  /** Class/category - multiple clusters can share the same class */
  cluster_class: string;

  /** Geometric shape for rendering the cluster node */
  figure: ClusterFigure;

  /** Whether the cluster is expanded (open) or collapsed (closed) */
  state: ClusterState;

  /** Array of node IDs that belong to this cluster */
  node_ids: string[];

  /** Optional color for the cluster node (hex color) */
  color?: string;

  /** Optional description */
  description?: string;

  /** ID of the program that created this cluster (for merge logic) */
  source_program_id?: string;
}

/**
 * A cluster program is JavaScript code that generates clusters
 *
 * The program receives a context object with { nodes, edges, selectedNodeIds }
 * and must return an array of Cluster objects (without cluster_id, which is auto-generated)
 */
export interface ClusterProgram {
  /** Unique identifier (auto-generated UUID) */
  program_id: string;

  /** Human-readable name */
  program_name: string;

  /** Optional description */
  description?: string;

  /** JavaScript code that returns Cluster[] */
  code: string;

  /** Timestamp when program was created */
  created_at: string;

  /** Timestamp when program was last modified */
  updated_at: string;
}

/**
 * Record of a cluster program execution
 * Used for debugging and audit trail
 */
export interface ClusterProgramExecution {
  /** ID of the program that was executed */
  program_id: string;

  /** Timestamp of execution */
  executed_at: string;

  /** Number of clusters generated */
  clusters_generated: number;

  /** Error message if execution failed */
  error?: string;

  /** Execution time in milliseconds */
  duration_ms?: number;
}

/**
 * Complete state for the cluster feature
 * Persisted in localStorage or database (as part of exploration state)
 */
export interface ClusterStoreState {
  /** All cluster programs */
  programs: ClusterProgram[];

  /** Current clusters (result of last program execution) */
  clusters: Cluster[];

  /** History of program executions */
  executions: ClusterProgramExecution[];
}

/**
 * Context object passed to cluster programs during execution
 * Provides access to current graph data
 */
export interface ClusterProgramContext {
  /** All nodes in the current graph */
  nodes: Array<{
    node_id: string;
    node_type: string;
    properties?: Record<string, unknown>;
  }>;

  /** All edges in the current graph */
  edges: Array<{
    edge_id: string;
    src: string;
    dst: string;
    relationship_type: string;
    properties?: Record<string, unknown>;
  }>;

  /** IDs of currently selected nodes */
  selectedNodeIds: string[];

  /** IDs of currently selected edges */
  selectedEdgeIds: string[];
}

/**
 * Result of cluster program execution
 */
export interface ClusterProgramResult {
  /** Whether execution succeeded */
  success: boolean;

  /** Generated clusters (if successful) */
  clusters?: Cluster[];

  /** Error message (if failed) */
  error?: string;

  /** Execution time in milliseconds */
  duration_ms?: number;
}

/**
 * Options for creating a cluster program
 * (excludes auto-generated fields, but allows optional program_id for fixed IDs)
 */
export type CreateClusterProgramInput = Omit<
  ClusterProgram,
  'program_id' | 'created_at' | 'updated_at'
> & {
  program_id?: string; // Optional: if provided, uses this ID instead of generating one
};

/**
 * Options for updating a cluster program
 * (all fields optional except program_id)
 */
export type UpdateClusterProgramInput = Partial<
  Omit<ClusterProgram, 'program_id' | 'created_at' | 'updated_at'>
>;

/**
 * Options for creating a cluster manually
 * (without running a program)
 * cluster_id is optional - if not provided, uses cluster_name as ID
 */
export type CreateClusterInput = Omit<Cluster, 'cluster_id'> & {
  cluster_id?: string;
};
