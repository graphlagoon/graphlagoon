import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore, type InvestigationGraphMode } from '@/stores/graph'

vi.mock('@/services/api', () => ({
  api: { expandFromNode: vi.fn() },
}))

import { api } from '@/services/api'

const node = (node_id: string) => ({ node_id, node_type: 'T', properties: {} })

function mode(overrides: Partial<InvestigationGraphMode> = {}): InvestigationGraphMode {
  return {
    origins: new Map([
      ['Pessoa:1', [
        { sourceId: 's1', contextId: 'c1', nodeId: 'p1' },
        { sourceId: 's2', contextId: 'c2', nodeId: '9' },
      ]],
      ['a@c1', [{ sourceId: 's1', contextId: 'c1', nodeId: 'a' }]],
    ]),
    rings: new Map(),
    chooseOrigin: vi.fn(async (origins) => origins[1]),
    applyExpansion: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(api.expandFromNode).mockResolvedValue({ nodes: [], edges: [], truncated: false })
})

describe('graph store · investigation mode', () => {
  it('loads without a context and keeps the selection of entities still present', () => {
    const store = useGraphStore()
    const m = mode()
    store.loadInvestigationGraph(m, [node('Pessoa:1'), node('a@c1')], [])
    store.selectNode('Pessoa:1')
    store.selectNode('a@c1', true)

    store.loadInvestigationGraph(m, [node('Pessoa:1')], [])
    expect(store.currentContext).toBeNull()
    expect([...store.selectedNodeIds]).toEqual(['Pessoa:1'])
  })

  it('asks for the context only when the node has more than one, then expands there', async () => {
    const store = useGraphStore()
    const m = mode()
    store.loadInvestigationGraph(m, [node('Pessoa:1'), node('a@c1')], [])

    await store.expandFromNode('a@c1', 1)
    expect(m.chooseOrigin).not.toHaveBeenCalled()
    expect(api.expandFromNode).toHaveBeenLastCalledWith('c1', expect.objectContaining({ node_id: 'a' }))

    await store.expandFromNode('Pessoa:1', 1)
    expect(m.chooseOrigin).toHaveBeenCalledTimes(1)
    expect(api.expandFromNode).toHaveBeenLastCalledWith('c2', expect.objectContaining({ node_id: '9' }))
    expect(m.applyExpansion).toHaveBeenLastCalledWith(
      { sourceId: 's2', contextId: 'c2', nodeId: '9' },
      expect.objectContaining({ nodes: [] }),
    )
  })

  it('does nothing when the picker is cancelled; clear() leaves the mode', async () => {
    const store = useGraphStore()
    const m = mode({ chooseOrigin: vi.fn(async () => null) })
    store.loadInvestigationGraph(m, [node('Pessoa:1')], [])
    await store.expandFromNode('Pessoa:1', 1)
    expect(api.expandFromNode).not.toHaveBeenCalled()

    store.clear()
    expect(store.investigationMode).toBeNull()
  })
})
