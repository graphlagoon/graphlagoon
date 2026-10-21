import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('@/services/api', () => ({
  api: {
    createInvestigationItem: vi.fn(),
    addInvestigationItemVersion: vi.fn(),
    getInvestigationItemContent: vi.fn(),
    getInvestigationEvents: vi.fn(async () => []),
  },
}))

import { api } from '@/services/api'
import { useGraphStore } from '@/stores/graph'
import { useInvestigationStore } from '@/stores/investigation'
import { useSketch, type SketchContent } from '@/composables/useSketch'

/** BYOD-2: in a case, drawing writes one "Manual additions" item with unified ids. */
describe('useSketch in a case', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    const graph = useGraphStore()
    graph.loadInvestigationGraph({ rings: new Map() } as never, [
      { node_id: 'Person:1', node_type: 'Person', properties: { name: 'Ana' } },
      { node_id: 'acc@c1', node_type: 'Account', properties: {} },
    ], [])
    const store = useInvestigationStore()
    store.current = { id: 'inv', has_write_access: true, status: 'analysis' } as never
    store.items = []
  })

  it('the first drawing creates the item, with stubs for the nodes already there', async () => {
    const created = { id: 's1', kind: 'graph', subkind: 'sketch', current_version: 1, status: 'confirmed' }
    vi.mocked(api.createInvestigationItem).mockResolvedValue(created as never)
    const sketch = useSketch()
    expect(sketch.inCase.value).toBe(true)
    expect(sketch.canSketch.value).toBe(true)

    await sketch.addEdge('Person:1', 'acc@c1', 'OWNS')
    const body = vi.mocked(api.createInvestigationItem).mock.calls[0][1] as { subkind: string; title: string; content_json: SketchContent }
    expect(body.subkind).toBe('sketch')
    expect(body.title).toBe('Manual additions')
    expect(body.content_json.unified).toBe(true)
    expect(body.content_json.nodes).toEqual([
      { id: 'Person:1', type: 'Person', properties: {} },
      { id: 'acc@c1', type: 'Account', properties: {} },
    ])
    expect(body.content_json.edges[0]).toMatchObject({ source: 'Person:1', target: 'acc@c1', type: 'OWNS' })
  })

  it('later drawings add a version; removing a node drops its edges and the stubs left unused', async () => {
    const store = useInvestigationStore()
    const item = { id: 's1', kind: 'graph', subkind: 'sketch', current_version: 1, status: 'confirmed' }
    store.items = [item as never]
    const content: SketchContent = {
      unified: true,
      nodes: [{ id: 'Person:1', type: 'Person', properties: {} }, { id: 'sketch:p', type: 'Phone', properties: {} }],
      edges: [{ id: 'sketch:e', source: 'sketch:p', target: 'Person:1', type: 'USES', properties: {} }],
    }
    store.rememberContent(item as never, content)
    vi.mocked(api.addInvestigationItemVersion).mockResolvedValue({ ...item, current_version: 2 } as never)

    const sketch = useSketch()
    expect(sketch.isOwnNode('sketch:p')).toBe(true)
    expect(sketch.isOwnNode('Person:1')).toBe(false)
    await sketch.addNode({ type: 'Email', label: 'ana@x.com', linkTo: 'acc@c1', edgeType: 'CONTACT' })
    let sent = vi.mocked(api.addInvestigationItemVersion).mock.calls[0][2].content_json as SketchContent
    expect(sent.nodes.map((n) => n.id).slice(0, 2)).toEqual(['Person:1', 'sketch:p'])
    expect(sent.nodes.find((n) => n.type === 'Email')?.properties).toEqual({ label: 'ana@x.com' })
    expect(sent.nodes.some((n) => n.id === 'acc@c1')).toBe(true) // stub for the edge

    store.rememberContent({ ...item, current_version: 2 } as never, sent)
    store.items = [{ ...item, current_version: 2 } as never]
    await sketch.remove(['sketch:p'])
    sent = vi.mocked(api.addInvestigationItemVersion).mock.calls[1][2].content_json as SketchContent
    expect(sent.nodes.map((n) => n.id)).not.toContain('sketch:p')
    expect(sent.nodes.map((n) => n.id)).not.toContain('Person:1') // its only edge is gone
    expect(sent.edges.map((e) => e.type)).toEqual(['CONTACT'])
  })

  it('a closed case or a reader cannot draw', () => {
    useInvestigationStore().current = { id: 'inv', has_write_access: true, status: 'closed' } as never
    expect(useSketch().canSketch.value).toBe(false)
    useInvestigationStore().current = { id: 'inv', has_write_access: false, status: 'analysis' } as never
    expect(useSketch().canSketch.value).toBe(false)
  })
})
