import type { Edge } from '@/types/graph'

let edgeCounter = 0

export function createEdge(overrides: Partial<Edge> = {}): Edge {
  edgeCounter++
  return {
    edge_id: `edge-${edgeCounter}`,
    src: `node-${edgeCounter}`,
    dst: `node-${edgeCounter + 1}`,
    relationship_type: 'KNOWS',
    ...overrides,
  }
}

export function resetEdgeCounter() {
  edgeCounter = 0
}
