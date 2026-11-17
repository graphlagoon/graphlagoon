import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'
import { useClusterStore } from '@/stores/cluster'
import NeighborSummaryPanel from '../NeighborSummaryPanel.vue'

vi.mock('@/services/api', () => ({ api: { nodeDegrees: vi.fn() } }))
import { api } from '@/services/api'

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
    expect(w.get('[data-testid=neighbor-summary-split]').text()).toMatch(/No other link loaded\s*5.*Other links\s*1/s)
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

  it('"check the source" counts the leaves\' links there and selects those with more than the canvas shows', async () => {
    const g = setup()
    g.currentContext = { id: 'ctx' } as any
    // p1..p5 are leaves on the canvas; in the source p2 and p4 have 3 links.
    vi.mocked(api.nodeDegrees).mockResolvedValue({ supported: true, degrees: { p1: 1, p2: 3, p3: 1, p4: 3, p5: 1 } })
    const w = mount(NeighborSummaryPanel, { props: { nodeId: 'hub' } })
    await w.get('[data-testid=neighbor-check-source]').trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(api.nodeDegrees).toHaveBeenCalledWith('ctx', ['p1', 'p2', 'p3', 'p4', 'p5'])
    expect(w.get('[data-testid=neighbor-source-check]').text()).toContain('2 of these 5 have links not loaded')
    await w.get('[data-testid=neighbor-source-check] button').trigger('click')
    expect([...g.selectedNodeIds].sort()).toEqual(['p2', 'p4'])
  })
})
