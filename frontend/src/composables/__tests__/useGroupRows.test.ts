import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useGroupRows } from '@/composables/useGroupRows'
import { useGraphStore } from '@/stores/graph'
import { useCommunityStore } from '@/stores/community'
import { useClusterStore } from '@/stores/cluster'
import type { Cluster } from '@/types/cluster'

const cluster = (id: string, cls: string, nodeIds: string[], state: 'open' | 'closed' = 'open'): Cluster => ({
  cluster_id: id, cluster_name: id.toUpperCase(), cluster_class: cls, figure: 'circle', state, node_ids: nodeIds,
})

async function setup() {
  const graph = useGraphStore()
  graph.nodes = ['a', 'b', 'c', 'd'].map((id) => ({ node_id: id, node_type: 'T' }))
  await nextTick()
  const communities = useCommunityStore()
  // Community 0 has 3 members, 1 has 1: sorted by size.
  communities.communityMap = new Map([['a', 0], ['b', 0], ['c', 0], ['d', 1]])
  const clusters = useClusterStore()
  clusters.clusters = [
    cluster('community-0', 'community', ['a', 'b', 'c'], 'closed'),
    cluster('k1', 'by-type', ['a']),
    cluster('k2', 'by-type', ['b', 'c']),
    cluster('group:g1', 'group', ['d']),
  ]
  return { graph, communities, clusters, rows: useGroupRows() }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useGroupRows', () => {
  it('lists the communities and the program clusters, not the community or case-group clusters', async () => {
    const { rows } = await setup()
    expect(rows.communityRows.value.map((r) => [r.key, r.count])).toEqual([['community:0', 3], ['community:1', 1]])
    // A community collapsed by "Collapse" carries its cluster state.
    expect(rows.communityRows.value[0]).toMatchObject({ collapsed: true, clusterId: 'community-0' })
    expect(rows.communityRows.value[1].collapsed).toBeUndefined()
    expect(rows.clusterRows.value.map((r) => r.key)).toEqual(['cluster:k1', 'cluster:k2'])
  })

  it('clicking a name shows only it; again shows everything', async () => {
    const { rows, graph } = await setup()
    const [c0] = rows.communityRows.value
    rows.clickRow(c0)
    expect(graph.isolation).toEqual({ kind: 'community', ids: [0], label: 'Community 0' })
    expect(rows.isSolo(c0)).toBe(true)
    expect(rows.isShown(rows.communityRows.value[1])).toBe(false)
    rows.clickRow(c0)
    expect(graph.isolation).toBeNull()
    expect(rows.isShown(rows.communityRows.value[1])).toBe(true)
  })

  it('Shift+click and toggleShown add and remove a group', async () => {
    const { rows, graph } = await setup()
    const [k1, k2] = rows.clusterRows.value
    rows.solo(k1)
    rows.clickRow(k2, new MouseEvent('click', { shiftKey: true }))
    // Every cluster shown again: no rule at all.
    expect(graph.isolation).toBeNull()
    rows.solo(k1)
    rows.toggleShown(k1)
    // Hiding the last visible group shows everything rather than a blank canvas.
    expect(graph.isolation).toBeNull()
    expect(rows.shownCount('cluster')).toBe(2)
  })

  it('the eye on a group with nothing isolated hides that one group', async () => {
    const { rows, graph } = await setup()
    rows.toggleShown(rows.communityRows.value[1])
    expect(graph.isolation).toEqual({ kind: 'community', ids: [0], label: 'Community 0' })
    expect(rows.shownCount('community')).toBe(1)
  })

  it('a rule of another kind shows none of this kind', async () => {
    const { rows, graph } = await setup()
    graph.isolate({ kind: 'value', field: 'x', value: '1', mode: 'same', label: 'x = 1' })
    expect(rows.isShown(rows.communityRows.value[0])).toBe(false)
  })

  it('selectMembers selects the nodes; toggleCollapsed flips the cluster', async () => {
    const { rows, graph, clusters } = await setup()
    rows.selectMembers(rows.clusterRows.value[1])
    expect([...graph.selectedNodeIds].sort()).toEqual(['b', 'c'])
    rows.selectMembers(rows.communityRows.value[1])
    expect([...graph.selectedNodeIds]).toEqual(['d'])
    rows.toggleCollapsed(rows.clusterRows.value[0])
    expect(clusters.clusters.find((c) => c.cluster_id === 'k1')!.state).toBe('closed')
    expect(rows.membersOf(rows.communityRows.value[0]).sort()).toEqual(['a', 'b', 'c'])
  })
})
