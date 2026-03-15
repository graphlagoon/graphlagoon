/**
 * Algorithm Registry
 *
 * Defines all available graph metrics algorithms with their parameters.
 * This registry enables dynamic UI generation and validation.
 */

import type { AlgorithmDefinition, ParamSchema } from '@/types/metrics';

/**
 * Common edge type filter parameter - added to all algorithms
 */
const EDGE_TYPE_FILTER_PARAM: ParamSchema = {
  key: 'edgeTypeFilter',
  label: 'Edge Types',
  type: 'edge-types',
  default: [],
  description: 'Only consider edges of selected types (empty = all)',
};

/**
 * Registry of all available algorithms
 */
export const ALGORITHMS: AlgorithmDefinition[] = [
  // ============================================================================
  // Node Centrality Metrics
  // ============================================================================
  {
    id: 'degree',
    name: 'Degree Centrality',
    category: 'centrality',
    description: 'Number of connections a node has',
    target: 'node',
    isIterative: false,
    requiresConnectedGraph: false,
    complexity: 'O(N)',
    defaultParams: { direction: 'all' },
    paramSchema: [
      {
        key: 'direction',
        label: 'Direction',
        type: 'select',
        default: 'all',
        options: [
          { value: 'all', label: 'All (In + Out)' },
          { value: 'in', label: 'In-Degree' },
          { value: 'out', label: 'Out-Degree' },
        ],
        description: 'Which edges to count',
      },
      EDGE_TYPE_FILTER_PARAM,
    ],
  },
  {
    id: 'weighted-degree',
    name: 'Weighted Degree',
    category: 'centrality',
    description: 'Sum of edge weights connected to a node',
    target: 'node',
    isIterative: false,
    requiresConnectedGraph: false,
    complexity: 'O(E)',
    defaultParams: { weightAttribute: null, direction: 'all' },
    paramSchema: [
      {
        key: 'weightAttribute',
        label: 'Weight Property',
        type: 'select',
        default: null,
        options: [],  // Populated dynamically from edge properties
        description: 'Edge property to use as weight',
      },
      {
        key: 'direction',
        label: 'Direction',
        type: 'select',
        default: 'all',
        options: [
          { value: 'all', label: 'All (In + Out)' },
          { value: 'in', label: 'In-Degree' },
          { value: 'out', label: 'Out-Degree' },
        ],
      },
      EDGE_TYPE_FILTER_PARAM,
    ],
  },
  {
    id: 'pagerank',
    name: 'PageRank',
    category: 'centrality',
    description: 'Importance based on incoming link quality',
    target: 'node',
    isIterative: true,
    requiresConnectedGraph: false,
    complexity: 'O(E*iter)',
    defaultParams: { alpha: 0.85, maxIterations: 100, tolerance: 1e-6 },
    paramSchema: [
      {
        key: 'alpha',
        label: 'Damping Factor',
        type: 'number',
        default: 0.85,
        min: 0.1,
        max: 0.99,
        step: 0.05,
        description: 'Probability of following a link vs random jump',
      },
      {
        key: 'maxIterations',
        label: 'Max Iterations',
        type: 'number',
        default: 100,
        min: 10,
        max: 1000,
        step: 10,
      },
      {
        key: 'tolerance',
        label: 'Convergence Tolerance',
        type: 'number',
        default: 1e-6,
        min: 1e-10,
        max: 1e-3,
        step: 1e-7,
      },
      EDGE_TYPE_FILTER_PARAM,
    ],
  },
  {
    id: 'eigenvector',
    name: 'Eigenvector Centrality',
    category: 'centrality',
    description: 'Influence based on connections to influential nodes',
    target: 'node',
    isIterative: true,
    requiresConnectedGraph: true,  // May not converge for disconnected
    complexity: 'O(E*iter)',
    defaultParams: { maxIterations: 100, tolerance: 1e-6 },
    paramSchema: [
      {
        key: 'maxIterations',
        label: 'Max Iterations',
        type: 'number',
        default: 100,
        min: 10,
        max: 1000,
        step: 10,
      },
      {
        key: 'tolerance',
        label: 'Convergence Tolerance',
        type: 'number',
        default: 1e-6,
        min: 1e-10,
        max: 1e-3,
      },
      EDGE_TYPE_FILTER_PARAM,
    ],
  },
  {
    id: 'betweenness',
    name: 'Betweenness Centrality',
    category: 'centrality',
    description: 'How often a node lies on shortest paths',
    target: 'node',
    isIterative: false,
    requiresConnectedGraph: false,
    complexity: 'O(N*E)',
    defaultParams: { normalized: true },
    paramSchema: [
      {
        key: 'normalized',
        label: 'Normalize',
        type: 'boolean',
        default: true,
        description: 'Scale values to [0, 1] range',
      },
      EDGE_TYPE_FILTER_PARAM,
    ],
  },
  {
    id: 'closeness',
    name: 'Closeness Centrality',
    category: 'centrality',
    description: 'Average distance to all other nodes',
    target: 'node',
    isIterative: false,
    requiresConnectedGraph: true,  // Infinite distance between components
    complexity: 'O(N*E)',
    defaultParams: { wassermanFaust: true },
    paramSchema: [
      {
        key: 'wassermanFaust',
        label: 'Wasserman-Faust',
        type: 'boolean',
        default: true,
        description: 'Handle disconnected components gracefully',
      },
      EDGE_TYPE_FILTER_PARAM,
    ],
  },
  {
    id: 'hits-authority',
    name: 'HITS Authority',
    category: 'centrality',
    description: 'Authority score (good content sources)',
    target: 'node',
    isIterative: true,
    requiresConnectedGraph: true,
    complexity: 'O(E*iter)',
    defaultParams: { maxIterations: 100, tolerance: 1e-8 },
    paramSchema: [
      {
        key: 'maxIterations',
        label: 'Max Iterations',
        type: 'number',
        default: 100,
        min: 10,
        max: 1000,
      },
      {
        key: 'tolerance',
        label: 'Convergence Tolerance',
        type: 'number',
        default: 1e-8,
        min: 1e-12,
        max: 1e-4,
      },
      EDGE_TYPE_FILTER_PARAM,
    ],
  },
  {
    id: 'hits-hub',
    name: 'HITS Hub',
    category: 'centrality',
    description: 'Hub score (good content aggregators)',
    target: 'node',
    isIterative: true,
    requiresConnectedGraph: true,
    complexity: 'O(E*iter)',
    defaultParams: { maxIterations: 100, tolerance: 1e-8 },
    paramSchema: [
      {
        key: 'maxIterations',
        label: 'Max Iterations',
        type: 'number',
        default: 100,
        min: 10,
        max: 1000,
      },
      {
        key: 'tolerance',
        label: 'Convergence Tolerance',
        type: 'number',
        default: 1e-8,
        min: 1e-12,
        max: 1e-4,
      },
      EDGE_TYPE_FILTER_PARAM,
    ],
  },

  // ============================================================================
  // Edge Metrics
  // ============================================================================
  {
    id: 'edge-betweenness',
    name: 'Edge Betweenness',
    category: 'edge',
    description: 'How often an edge lies on shortest paths',
    target: 'edge',
    isIterative: false,
    requiresConnectedGraph: false,
    complexity: 'O(N*E)',
    defaultParams: { normalized: true },
    paramSchema: [
      {
        key: 'normalized',
        label: 'Normalize',
        type: 'boolean',
        default: true,
        description: 'Scale values to [0, 1] range',
      },
      EDGE_TYPE_FILTER_PARAM,
    ],
  },
];

/**
 * Get algorithm definition by ID
 */
export function getAlgorithm(id: string): AlgorithmDefinition | undefined {
  return ALGORITHMS.find(a => a.id === id);
}

/**
 * Get algorithms by category
 */
export function getAlgorithmsByCategory(category: AlgorithmDefinition['category']): AlgorithmDefinition[] {
  return ALGORITHMS.filter(a => a.category === category);
}

/**
 * Get algorithms by target (node or edge)
 */
export function getAlgorithmsByTarget(target: AlgorithmDefinition['target']): AlgorithmDefinition[] {
  return ALGORITHMS.filter(a => a.target === target);
}

/**
 * Get node centrality algorithms
 */
export function getNodeAlgorithms(): AlgorithmDefinition[] {
  return ALGORITHMS.filter(a => a.target === 'node');
}

/**
 * Get edge algorithms
 */
export function getEdgeAlgorithms(): AlgorithmDefinition[] {
  return ALGORITHMS.filter(a => a.target === 'edge');
}

/**
 * Check if algorithm requires special handling for disconnected graphs
 */
export function requiresComponentHandling(algorithmId: string): boolean {
  const algo = getAlgorithm(algorithmId);
  return algo?.requiresConnectedGraph ?? false;
}

/**
 * Get default parameters for an algorithm
 */
export function getDefaultParams(algorithmId: string): Record<string, unknown> {
  const algo = getAlgorithm(algorithmId);
  return algo ? { ...algo.defaultParams } : {};
}

/**
 * Validate parameters against schema
 */
export function validateParams(
  algorithmId: string,
  params: Record<string, unknown>
): { valid: boolean; errors: string[] } {
  const algo = getAlgorithm(algorithmId);
  if (!algo) {
    return { valid: false, errors: [`Unknown algorithm: ${algorithmId}`] };
  }

  const errors: string[] = [];

  for (const schema of algo.paramSchema) {
    const value = params[schema.key];

    if (schema.type === 'number' && typeof value === 'number') {
      if (schema.min !== undefined && value < schema.min) {
        errors.push(`${schema.label} must be at least ${schema.min}`);
      }
      if (schema.max !== undefined && value > schema.max) {
        errors.push(`${schema.label} must be at most ${schema.max}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
