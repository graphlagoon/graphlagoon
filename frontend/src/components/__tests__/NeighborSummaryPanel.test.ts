import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'
import { useClusterStore } from '@/stores/cluster'
import NeighborSummaryPanel from '../NeighborSummaryPanel.vue'

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info: vi.fn(), warning: vi.fn(), success: vi.fn(), error: vi.fn() }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
})

function setup() {
  const g = useGraphStore()
  g.nodes = [
    { node_id: 'hub', node_type: 'Company' },
    { node_id: 'other', node_type: 'Company' },
    ...Array.from({ length: 6 }, (_, i) => ({ node_id: `p${i}`, node_type: 'Person' })),
  ]
  g.edges = [
    ...Array.from({ length: 6 }, (_, i) => ({ edge_id: `e${i}`, src: `p${i}`, dst: 'hub', relationship_type: 'SOCIO_DE' })),
    { edge_id: 'x', src: 'p0', dst: 'other', relationship_type: 'SOCIO_DE' },
  ]
  g.expandTotals = new Map([['hub', 380]])
  return g
}

describe('NeighborSummaryPanel', () => {
  it('counts, the leaf / linked split, and "of M loaded"', () => {
    setup()
    const w = mount(NeighborSummaryPanel, { props: { nodeId: 'hub' } })
    expect(w.get('[data-testid=neighbor-summary-count]').text()).toContain('6 of 380 edges loaded')
    expect(w.get('[data-testid=neighbor-row-SOCIO_DE-in-Person]').text()).toContain('6')
    expect(w.get('[data-testid=neighbor-summary-split]').text()).toMatch(/nothing else: 5.*another link: 1/)
  })

  it('"select" on the linked neighbours selects them; group leaves makes a collection', async () => {
    const g = setup()
    const w = mount(NeighborSummaryPanel, { props: { nodeId: 'hub' } })
    await w.get('[data-testid=neighbor-select-linked]').trigger('click')
    expect([...g.selectedNodeIds]).toEqual(['p0'])
    await w.get('[data-testid=neighbor-group-leaves]').trigger('click')
    expect(useClusterStore().collectionsOf('hub')[0].node_ids).toHaveLength(5)
    expect(w.find('[data-testid=neighbor-ungroup-leaves]').exists()).toBe(true)
  })
})
