import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import GroupLegend from '@/components/GroupLegend.vue'
import { useGraphStore } from '@/stores/graph'
import { useCommunityStore } from '@/stores/community'
import { useClusterStore } from '@/stores/cluster'

async function seed(k: number, n = k) {
  const graph = useGraphStore()
  graph.nodes = Array.from({ length: n }, (_, i) => ({ node_id: `n${i}`, node_type: 'T' }))
  await nextTick()
  useCommunityStore().communityMap = new Map(Array.from({ length: n }, (_, i) => [`n${i}`, i % k]))
  return graph
}

beforeEach(() => {
  setActivePinia(createPinia())
  useClusterStore().clearAll()
  // Wide enough that the floating legend starts unfolded.
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true })
})

describe('GroupLegend', () => {
  it('renders nothing without groups', () => {
    const { queryByTestId } = render(GroupLegend)
    expect(queryByTestId('group-legend')).toBeNull()
  })

  it('click shows only a group, Shift+click adds one, "show all" clears', async () => {
    const graph = await seed(3)
    const { getByTestId } = render(GroupLegend)
    await fireEvent.click(getByTestId('group-legend-community:1'))
    expect(graph.isolation).toMatchObject({ kind: 'community', ids: [1] })
    await fireEvent.click(getByTestId('group-legend-community:2'), { shiftKey: true })
    expect(graph.isolation).toMatchObject({ kind: 'community', ids: [1, 2] })
    await fireEvent.click(getByTestId('group-legend-show-all'))
    expect(graph.isolation).toBeNull()
  })

  it('shows at most `max` rows; "+N more" asks for the panel', async () => {
    await seed(5)
    const { getByTestId, queryByTestId, emitted } = render(GroupLegend, { props: { max: 3 } })
    expect(queryByTestId('group-legend-community:4')).toBeNull()
    expect(getByTestId('group-legend-more').textContent).toContain('+2')
    await fireEvent.click(getByTestId('group-legend-more'))
    expect(emitted('open-panel')).toBeTruthy()
  })

  it('the chips variant has its own "show all" and no fold', async () => {
    const graph = await seed(2)
    const { getByTestId, queryByTestId } = render(GroupLegend, { props: { variant: 'chips' } })
    expect(queryByTestId('group-legend-fold')).toBeNull()
    expect(queryByTestId('group-legend-show-all')).toBeNull()
    await fireEvent.click(getByTestId('group-legend-community:0'))
    await fireEvent.click(getByTestId('group-legend-show-all'))
    expect(graph.isolation).toBeNull()
  })

  it('the floating legend folds into a pill and unfolds', async () => {
    await seed(2)
    const { getByTestId, queryByTestId } = render(GroupLegend)
    await fireEvent.click(getByTestId('group-legend-fold'))
    expect(queryByTestId('group-legend-community:0')).toBeNull()
    expect(getByTestId('group-legend-unfold').textContent).toContain('2 groups')
    await fireEvent.click(getByTestId('group-legend-unfold'))
    expect(getByTestId('group-legend-community:0')).toBeTruthy()
  })

  it('starts folded on a narrow screen', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 600, configurable: true })
    await seed(2)
    const { getByTestId } = render(GroupLegend)
    expect(getByTestId('group-legend-unfold')).toBeTruthy()
  })

  it('lists program clusters when there is no coloring', async () => {
    await seed(1)
    useCommunityStore().clearCommunities()
    useClusterStore().clusters = [
      { cluster_id: 'k1', cluster_name: 'People', cluster_class: 'by-type', figure: 'circle', state: 'open', node_ids: ['n0'] },
    ]
    const { getByTestId } = render(GroupLegend)
    expect(getByTestId('group-legend-cluster:k1').textContent).toContain('People')
  })
})
