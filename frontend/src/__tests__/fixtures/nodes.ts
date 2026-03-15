import type { Node } from '@/types/graph'

let nodeCounter = 0

export function createNode(overrides: Partial<Node> = {}): Node {
  nodeCounter++
  return {
    node_id: `node-${nodeCounter}`,
    node_type: 'Person',
    ...overrides,
  }
}

export function createNodes(count: number, overrides: Partial<Node> = {}): Node[] {
  return Array.from({ length: count }, () => createNode(overrides))
}

export function resetNodeCounter() {
  nodeCounter = 0
}
