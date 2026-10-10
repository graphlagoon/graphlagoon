import { describe, it, expect } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { connectedComponents } from '@/utils/graphComponents'
import { useCommunityStore } from '@/stores/community'
import { useGraphStore } from '@/stores/graph'

// a⇄b→c⇄d, e alone, f→g
const nodes = ['g', 'f', 'e', 'd', 'c', 'b', 'a']
const edges: [string, string][] = [['a', 'b'], ['b', 'a'], ['b', 'c'], ['c', 'd'], ['d', 'c'], ['f', 'g'], ['x', 'a']]
const groups = (m: Map<string, number>) => {
  const out: string[][] = []
  for (const [n, id] of m) (out[id] ??= []).push(n)
  return out.map((g) => g.sort())
}

describe('connected components (F3.7)', () => {
  it('weak: ignores direction; 0 is the largest, ties by smallest node id', () => {
    expect(groups(connectedComponents(nodes, edges, 'weak'))).toEqual([['a', 'b', 'c', 'd'], ['f', 'g'], ['e']])
  })

  it('strong: follows direction', () => {
    expect(groups(connectedComponents(nodes, edges, 'strong'))).toEqual([['a', 'b'], ['c', 'd'], ['e'], ['f'], ['g']])
  })

  it('is a community option that honours the edge type filter', async () => {
    setActivePinia(createPinia())
    const graph = useGraphStore()
    const community = useCommunityStore()
    graph.nodes = ['a', 'b', 'c'].map((id) => ({ node_id: id, node_type: 'T' }))
    graph.edges = [
      { edge_id: 'e1', src: 'a', dst: 'b', relationship_type: 'PIX' },
      { edge_id: 'e2', src: 'b', dst: 'c', relationship_type: 'TED' },
    ]
    await nextTick()
    community.algorithm = 'weak-components'
    await community.runDetection()
    expect(community.communityCount).toBe(1)
    community.edgeTypeFilter = ['PIX']
    await community.runDetection()
    expect(Object.fromEntries(community.communityMap)).toEqual({ a: 0, b: 0, c: 1 })
    expect(community.selectedProgramId).toBeNull()
  })
})
