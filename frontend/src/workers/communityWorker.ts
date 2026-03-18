/**
 * Community Detection Worker
 *
 * Dedicated Web Worker for running community detection algorithms.
 * Currently supports Louvain method.
 */

import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import type { SerializedGraph } from '@/types/metrics';

// ============================================================================
// Message Types
// ============================================================================

export interface CommunityWorkerInput {
  type: 'RUN';
  graph: SerializedGraph;
  params: { resolution: number; edgeTypeFilter: string[] };
}

export type CommunityWorkerOutput =
  | { type: 'RESULT'; communities: Record<string, number>; count: number; modularity: number }
  | { type: 'ERROR'; error: string }
  | { type: 'PROGRESS'; message: string; progress: number };

// ============================================================================
// Message Handler
// ============================================================================

self.onmessage = (event: MessageEvent<CommunityWorkerInput>) => {
  const command = event.data;

  if (command.type !== 'RUN') return;

  try {
    sendProgress('Building graph...', 10);

    const g = buildUndirectedGraph(command.graph, command.params.edgeTypeFilter);

    if (g.order === 0) {
      postMessage({
        type: 'RESULT',
        communities: {},
        count: 0,
        modularity: 0,
      } as CommunityWorkerOutput);
      return;
    }

    sendProgress('Running Louvain community detection...', 30);

    const result = louvain.detailed(g, {
      resolution: command.params.resolution,
      weighted: true,
    });

    sendProgress('Done', 100);

    postMessage({
      type: 'RESULT',
      communities: result.communities,
      count: result.count,
      modularity: result.modularity,
    } as CommunityWorkerOutput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postMessage({ type: 'ERROR', error: message } as CommunityWorkerOutput);
  }
};

// ============================================================================
// Graph Building
// ============================================================================

/**
 * Build an undirected graphology graph from serialized data.
 * Louvain requires undirected graphs, so we merge directed edges.
 *
 * - Self-loops are dropped (meaningless for community structure).
 * - Multi-edges between the same pair are merged into a single weighted edge
 *   (weight = number of parallel edges).
 * - Optional edge type filtering: when edgeTypeFilter is non-empty, only
 *   edges whose relationship_type is in the list are included.
 */
function buildUndirectedGraph(serialized: SerializedGraph, edgeTypeFilter: string[]): Graph {
  const g = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });

  for (const node of serialized.nodes) {
    g.addNode(node.id, node.attributes);
  }

  const hasFilter = edgeTypeFilter.length > 0;
  const filterSet = hasFilter ? new Set(edgeTypeFilter) : null;

  for (const edge of serialized.edges) {
    // Skip self-loops
    if (edge.source === edge.target) continue;

    // Skip if edge type is filtered out
    if (filterSet) {
      const edgeType = edge.attributes.relationship_type as string;
      if (!edgeType || !filterSet.has(edgeType)) continue;
    }

    // Merge parallel edges: increment weight on existing edge
    if (g.hasEdge(edge.source, edge.target)) {
      const w = g.getEdgeAttribute(edge.source, edge.target, 'weight') ?? 1;
      g.setEdgeAttribute(edge.source, edge.target, 'weight', w + 1);
    } else {
      g.addEdge(edge.source, edge.target, { ...edge.attributes, weight: 1 });
    }
  }

  return g;
}

// ============================================================================
// Helpers
// ============================================================================

function sendProgress(message: string, progress: number): void {
  postMessage({ type: 'PROGRESS', message, progress } as CommunityWorkerOutput);
}
