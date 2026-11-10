/**
 * The Clusters panel, results first: run bar, groups as layers, display,
 * the program library in a modal and Similarity in its own tab.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import ClusterProgramPanel from '@/components/ClusterProgramPanel.vue'
import { useGraphStore } from '@/stores/graph'
import { useCommunityStore } from '@/stores/community'
import { useClusterStore } from '@/stores/cluster'

async function seedGraph(n = 4) {
  const graph = useGraphStore()
  graph.nodes = Array.from({ length: n }, (_, i) => ({ node_id: `n${i}`, node_type: 'T' }))
  await nextTick()
  return graph
}

/** Communities as a run would leave them: node i in community i % k. */
function seedCommunities(k: number, n = 4) {
  const communities = useCommunityStore()
  communities.communityMap = new Map(Array.from({ length: n }, (_, i) => [`n${i}`, i % k]))
  return communities
}

beforeEach(() => {
  setActivePinia(createPinia())
  useClusterStore().clearAll()
})

describe('ClusterProgramPanel', () => {
  it('opens on the run bar when there are no groups', async () => {
    await seedGraph()
    const { getByTestId, queryByTestId } = render(ClusterProgramPanel)
    expect(getByTestId('cluster-run-bar')).toBeTruthy()
    expect(getByTestId('community-algorithm-select')).toBeTruthy()
    expect(getByTestId('groups-empty')).toBeTruthy()
    expect(queryByTestId('cluster-run-summary')).toBeNull()
  })

  it('Output Color / Collapse sets the community collapse flag', async () => {
    await seedGraph()
    const communities = useCommunityStore()
    const { getByTestId } = render(ClusterProgramPanel)
    await fireEvent.click(getByTestId('cluster-output-collapse'))
    expect(communities.collapseEnabled).toBe(true)
    await fireEvent.click(getByTestId('cluster-output-color'))
    expect(communities.collapseEnabled).toBe(false)
  })

  it('Run detects, then folds into the summary; "change" opens it again', async () => {
    await seedGraph()
    const communities = useCommunityStore()
    const spy = vi.spyOn(communities, 'runDetection').mockImplementation(async () => {
      seedCommunities(2)
    })
    const { getByTestId, queryByTestId } = render(ClusterProgramPanel)
    await fireEvent.click(getByTestId('cluster-run'))
    await nextTick()
    await nextTick()
    expect(spy).toHaveBeenCalled()
    expect(getByTestId('cluster-run-summary').textContent).toContain('Louvain')
    expect(queryByTestId('cluster-run-bar')).toBeNull()
    await fireEvent.click(getByTestId('cluster-run-change'))
    expect(getByTestId('cluster-run-bar')).toBeTruthy()
  })

  it('a group name shows only it, clicking again shows all; the eye hides one', async () => {
    const graph = await seedGraph()
    seedCommunities(2)
    const { getByTestId, queryByTestId } = render(ClusterProgramPanel)
    expect(getByTestId('group-row-community:0')).toBeTruthy()
    await fireEvent.click(getByTestId('group-name-community:1'))
    expect(graph.isolation).toMatchObject({ kind: 'community', ids: [1] })
    expect(getByTestId('groups-showing').textContent).toContain('Showing 1 of 2')
    await fireEvent.click(getByTestId('group-name-community:1'))
    expect(graph.isolation).toBeNull()
    expect(queryByTestId('groups-showing')).toBeNull()

    await fireEvent.click(getByTestId('group-eye-community:0'))
    expect(graph.isolation).toMatchObject({ kind: 'community', ids: [1] })
    await fireEvent.click(getByTestId('groups-show-all'))
    expect(graph.isolation).toBeNull()
  })

  it('Shift+click adds a group to what is shown', async () => {
    const graph = await seedGraph(6)
    seedCommunities(3, 6)
    const { getByTestId } = render(ClusterProgramPanel)
    await fireEvent.click(getByTestId('group-name-community:0'))
    await fireEvent.click(getByTestId('group-name-community:2'), { shiftKey: true })
    expect(graph.isolation).toMatchObject({ kind: 'community', ids: [0, 2] })
  })

  it('the search box appears only with more than 10 groups and filters them', async () => {
    await seedGraph(12)
    seedCommunities(2, 12)
    const first = render(ClusterProgramPanel)
    expect(first.queryByTestId('groups-search')).toBeNull()
    first.unmount()

    seedCommunities(12, 12)
    const { getByTestId, queryByTestId } = render(ClusterProgramPanel)
    await fireEvent.update(getByTestId('groups-search'), 'Community 11')
    expect(getByTestId('group-row-community:11')).toBeTruthy()
    expect(queryByTestId('group-row-community:1')).toBeNull()
  })

  it('"Programs…" opens the library modal', async () => {
    await seedGraph()
    const { getByTestId, findByTestId } = render(ClusterProgramPanel)
    await fireEvent.click(getByTestId('cluster-manage-programs'))
    expect(await findByTestId('cluster-program-library')).toBeTruthy()
  })

  it('Similarity is its own tab', async () => {
    await seedGraph()
    const { getByTestId, queryByTestId, emitted } = render(ClusterProgramPanel, {
      global: { stubs: { SimilarityPanel: { template: '<div data-testid="similarity-stub" />' } } },
    })
    await fireEvent.click(getByTestId('clusters-tab-similarity'))
    expect(getByTestId('similarity-stub')).toBeTruthy()
    expect(queryByTestId('clusters-groups-pane')).toBeNull()
    expect(emitted('update:tab')?.at(-1)).toEqual(['similarity'])
  })

  it('tab "results" opens the program clusters list when both kinds exist', async () => {
    await seedGraph()
    seedCommunities(2)
    useClusterStore().clusters = [
      { cluster_id: 'k1', cluster_name: 'By type', cluster_class: 'by-type', figure: 'circle', state: 'open', node_ids: ['n0'] },
    ]
    const { getByTestId, queryByTestId } = render(ClusterProgramPanel, { props: { tab: 'results' } })
    expect(getByTestId('groups-kind-cluster')).toBeTruthy()
    expect(getByTestId('group-row-cluster:k1')).toBeTruthy()
    expect(queryByTestId('group-row-community:0')).toBeNull()
    await fireEvent.click(getByTestId('groups-kind-community'))
    expect(getByTestId('group-row-community:0')).toBeTruthy()
  })
})
