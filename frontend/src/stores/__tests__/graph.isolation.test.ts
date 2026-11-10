/**
 * "Show only" (isolation): a rule on the graph store, applied through the
 * visual hide-set the canvas already reads, saved with the exploration.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'
import { useCommunityStore } from '@/stores/community'
import { useClusterStore } from '@/stores/cluster'

async function setup() {
  const graph = useGraphStore()
  graph.nodes = [
    { node_id: 'a', node_type: 'Person', properties: { branch: 'x' } },
    { node_id: 'b', node_type: 'Person', properties: { branch: 'y' } },
    { node_id: 'c', node_type: 'Company', properties: { branch: 'x' } },
  ]
  // The community store clears itself when the nodes change: let that pass first.
  await nextTick()
  const communities = useCommunityStore()
  communities.communityMap = new Map([['a', 0], ['b', 1], ['c', 1]])
  return { graph, communities }
}

const hidden = (s: Set<string> | null) => (s ? [...s].sort() : [])

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('graph store isolation', () => {
  it('isolate hides every node outside the rule', async () => {
    const { graph } = await setup()
    expect(graph.searchHiddenNodeIds).toBeNull()
    graph.isolate({ kind: 'community', ids: [1], label: 'Community 1' })
    expect(hidden(graph.searchHiddenNodeIds)).toEqual(['a'])
    expect([...graph.isolatedNodeIds!].sort()).toEqual(['b', 'c'])
  })

  it('the selected node is always kept', async () => {
    const { graph } = await setup()
    graph.selectedNodeIds = new Set(['a'])
    graph.isolate({ kind: 'value', field: 'branch', value: 'y', mode: 'same', label: 'branch = y' })
    expect(hidden(graph.searchHiddenNodeIds)).toEqual(['c'])
  })

  it('addToIsolation unions communities; clearIsolation shows everything', async () => {
    const { graph } = await setup()
    graph.isolate({ kind: 'community', ids: [0], label: 'Community 0' })
    expect(hidden(graph.searchHiddenNodeIds)).toEqual(['b', 'c'])
    graph.addToIsolation({ kind: 'community', ids: [1], label: 'Community 1' })
    expect(graph.isolation).toEqual({ kind: 'community', ids: [0, 1], label: '2 communities' })
    expect(graph.searchHiddenNodeIds?.size ?? 0).toBe(0)
    graph.clearIsolation()
    expect(graph.isolation).toBeNull()
    expect(graph.searchHiddenNodeIds).toBeNull()
  })

  it('merges with the case chips hide-set', async () => {
    const { graph } = await setup()
    graph.caseHiddenNodeIds = new Set(['b'])
    graph.isolate({ kind: 'community', ids: [0], label: 'Community 0' })
    expect(hidden(graph.searchHiddenNodeIds)).toEqual(['b', 'c'])
  })

  it('a stale community rule (communities cleared) hides nothing', async () => {
    const { graph, communities } = await setup()
    graph.isolate({ kind: 'community', ids: [1], label: 'Community 1' })
    communities.clearCommunities()
    expect(graph.isolatedNodeIds).toBeNull()
    expect(graph.searchHiddenNodeIds).toBeNull()
  })

  it('a cluster rule follows the cluster members', async () => {
    const { graph } = await setup()
    useClusterStore().clusters = [
      { cluster_id: 'k', cluster_name: 'K', cluster_class: 'x', figure: 'circle', state: 'open', node_ids: ['c'] },
    ]
    graph.isolate({ kind: 'cluster', ids: ['k'], label: 'K' })
    expect(hidden(graph.searchHiddenNodeIds)).toEqual(['a', 'b'])
  })

  it('clear() resets the rule', async () => {
    const { graph } = await setup()
    graph.isolate({ kind: 'community', ids: [1], label: 'Community 1' })
    graph.clear()
    expect(graph.isolation).toBeNull()
  })

  it('getExplorationState carries the rule (a copy)', async () => {
    const { graph } = await setup()
    expect(graph.getExplorationState().isolation).toBeNull()
    const rule = { kind: 'value' as const, field: 'branch', value: 'x', mode: 'same' as const, label: 'branch = x' }
    graph.isolate(rule)
    const state = graph.getExplorationState()
    expect(state.isolation).toEqual(rule)
    expect(state.isolation).not.toBe(graph.isolation)
  })
})
