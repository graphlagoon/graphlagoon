import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'
import { useClusterStore } from '@/stores/cluster'

const info = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info, warning: vi.fn(), success: vi.fn(), error: vi.fn() }),
}))

function setup() {
  const g = useGraphStore()
  g.nodes = [
    { node_id: 'hub', node_type: 'Company' },
    { node_id: 'other', node_type: 'Company' },
    ...Array.from({ length: 8 }, (_, i) => ({ node_id: `p${i}`, node_type: 'Person' })),
    ...Array.from({ length: 3 }, (_, i) => ({ node_id: `c${i}`, node_type: 'Company' })),
  ]
  g.edges = [
    ...Array.from({ length: 8 }, (_, i) => ({ edge_id: `e${i}`, src: `p${i}`, dst: 'hub', relationship_type: 'SOCIO_DE' })),
    ...Array.from({ length: 3 }, (_, i) => ({ edge_id: `c${i}`, src: `c${i}`, dst: 'hub', relationship_type: 'SOCIO_DE' })),
    { edge_id: 'x', src: 'p0', dst: 'other', relationship_type: 'SOCIO_DE' },
  ]
  return { g, c: useClusterStore() }
}

beforeEach(() => {
  setActivePinia(createPinia())
  info.mockClear()
})

describe('leaf collections (hubs-densos F1)', () => {
  it('one closed cluster per kind with at least 5 leaves; linked neighbours stay out', () => {
    const { c } = setup()
    const made = c.groupLeafNeighbors('hub', 'Aurora')
    expect(made).toHaveLength(1) // 3 Company leaves are too few
    expect(made[0].state).toBe('closed')
    expect(made[0].cluster_name).toBe('SOCIO_DE <- Person')
    expect(made[0].description).toContain('Aurora')
    expect(made[0].node_ids).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'])
    expect(c.collectionsOf('hub')).toHaveLength(1)
  })

  it('a member that gains another link leaves the collection, with a note', async () => {
    const { g, c } = setup()
    c.groupLeafNeighbors('hub', 'Aurora')
    g.edges = [...g.edges, { edge_id: 'y', src: 'p3', dst: 'other', relationship_type: 'SOCIO_DE' }]
    await nextTick()
    expect(c.collectionsOf('hub')[0].node_ids).not.toContain('p3')
    expect(info).toHaveBeenCalledWith(expect.stringContaining('1 left'), expect.any(Number))
  })

  it('pulled-out members stay out when regrouping; ungroup removes every collection; state round-trips', () => {
    const { c } = setup()
    const [col] = c.groupLeafNeighbors('hub', 'Aurora')
    c.pullOut(col.cluster_id, 'p2')
    c.groupLeafNeighbors('hub', 'Aurora')
    expect(c.collectionsOf('hub')[0].node_ids).not.toContain('p2')

    const saved = JSON.parse(JSON.stringify(c.getState()))
    c.ungroupLeafNeighbors('hub')
    expect(c.collectionsOf('hub')).toHaveLength(0)
    c.loadState(saved)
    expect(c.collectionsOf('hub')[0].collection?.excluded).toEqual(['p2'])
  })
})
