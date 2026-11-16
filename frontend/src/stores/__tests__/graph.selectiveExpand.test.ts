import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore, EXPAND_DIALOG_THRESHOLD } from '@/stores/graph'

vi.mock('@/services/api', () => ({
  api: {
    neighborSummary: vi.fn(),
    expandFromNode: vi.fn(),
  },
}))

const warning = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ warning, info: vi.fn(), success: vi.fn(), error: vi.fn() }),
}))

import { api } from '@/services/api'

function hubEdges(n: number, from = 0) {
  return Array.from({ length: n }, (_, i) => ({
    edge_id: `e${from + i}`,
    src: `p${from + i}`,
    dst: 'hub',
    relationship_type: 'SOCIO_DE',
  }))
}

function setup() {
  const store = useGraphStore()
  store.currentContext = { id: 'ctx-1' } as any
  store.nodes = [{ node_id: 'hub', node_type: 'Company' }]
  store.edges = []
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(api.expandFromNode).mockResolvedValue({ nodes: [], edges: [] } as any)
})

describe('requestExpand', () => {
  it(`up to ${EXPAND_DIALOG_THRESHOLD} edges: expands at once, no dialog`, async () => {
    const store = setup()
    vi.mocked(api.neighborSummary).mockResolvedValue({
      supported: true,
      total_edges: 30,
      buckets: [{ relationship_type: 'SOCIO_DE', direction: 'in', edges: 30 }],
    })
    await store.requestExpand('hub')
    expect(store.expandChoice).toBeNull()
    expect(api.expandFromNode).toHaveBeenCalledWith('ctx-1', expect.objectContaining({ node_id: 'hub', depth: 1, edge_types: [] }))
  })

  it('above the threshold: opens the choice and loads nothing yet', async () => {
    const store = setup()
    const summary = {
      supported: true,
      total_edges: 380,
      buckets: [{ relationship_type: 'SOCIO_DE', direction: 'in' as const, edges: 380 }],
    }
    vi.mocked(api.neighborSummary).mockResolvedValue(summary)
    await store.requestExpand('hub')
    expect(store.expandChoice).toEqual({ nodeId: 'hub', summary })
    expect(api.expandFromNode).not.toHaveBeenCalled()
  })

  it('a datasource that cannot count, or a failed count, expands as before', async () => {
    const store = setup()
    vi.mocked(api.neighborSummary).mockResolvedValueOnce({ supported: false, total_edges: 0, buckets: [] })
    await store.requestExpand('hub')
    vi.mocked(api.neighborSummary).mockRejectedValueOnce(new Error('boom'))
    await store.requestExpand('hub')
    expect(api.expandFromNode).toHaveBeenCalledTimes(2)
    expect(store.expandChoice).toBeNull()
  })
})

describe('expand progress and truncation', () => {
  it('"N of M loaded" while the node has fewer edges than the source; gone once complete', async () => {
    const store = setup()
    vi.mocked(api.neighborSummary).mockResolvedValue({
      supported: true,
      total_edges: 120,
      buckets: [{ relationship_type: 'SOCIO_DE', direction: 'in', edges: 120 }],
    })
    await store.requestExpand('hub')
    vi.mocked(api.expandFromNode).mockResolvedValueOnce({
      nodes: hubEdges(100).map((e) => ({ node_id: e.src, node_type: 'Person' })),
      edges: hubEdges(100),
      truncated: true,
    } as any)
    await store.expandFromNode('hub', 1, [], 100)
    expect(store.expandProgress.get('hub')).toEqual({ loaded: 100, total: 120 })
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('100 of its 120 edges'), expect.any(Number))

    vi.mocked(api.expandFromNode).mockResolvedValueOnce({
      nodes: hubEdges(20, 100).map((e) => ({ node_id: e.src, node_type: 'Person' })),
      edges: hubEdges(20, 100),
    } as any)
    await store.expandFromNode('hub', 1, [], 200)
    expect(store.expandProgress.has('hub')).toBe(false)
  })

  it('a cut expand without a count still warns; with every own edge loaded it does not', async () => {
    const store = setup()
    vi.mocked(api.expandFromNode).mockResolvedValueOnce({ nodes: [], edges: hubEdges(4), truncated: true } as any)
    await store.expandFromNode('hub', 1, [], 4)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning.mock.calls[0][0]).toBe('Expand stopped at 4 edges.')

    store.expandTotals = new Map([['hub', 4]])
    vi.mocked(api.expandFromNode).mockResolvedValueOnce({ nodes: [], edges: [], truncated: true } as any)
    await store.expandFromNode('hub', 1, [], 4)
    expect(warning).toHaveBeenCalledTimes(1)
  })

  it('a new query clears the counts', async () => {
    const store = setup()
    store.expandTotals = new Map([['hub', 500]])
    expect(store.expandProgress.size).toBe(1)
    store.queryRunSeq++
    await Promise.resolve()
    expect(store.expandTotals.size).toBe(0)
  })
})
