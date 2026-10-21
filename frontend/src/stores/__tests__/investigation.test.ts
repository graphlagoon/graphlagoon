import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useInvestigationStore } from '@/stores/investigation'

vi.mock('@/services/api', () => ({
  api: {
    getInvestigations: vi.fn(),
    getInvestigationPage: vi.fn(),
    getCaseTypes: vi.fn(async () => []),
    getInvestigation: vi.fn(),
    getInvestigationItems: vi.fn(),
    getInvestigationAnnotations: vi.fn(async () => []),
    getInvestigationEvents: vi.fn(async () => []),
    getInvestigationItemSnapshot: vi.fn(),
    getInvestigationItemContent: vi.fn(),
    getGraphContext: vi.fn(),
    createInvestigation: vi.fn(),
    createInvestigationItem: vi.fn(),
    createInvestigationAnnotation: vi.fn(),
    deleteInvestigationAnnotation: vi.fn(async () => {}),
    pinInvestigationItem: vi.fn(),
  },
}))

import { api } from '@/services/api'

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'graph', subkind: 'exploration_ref', title: id, tags: [], status: 'confirmed', author_kind: 'human',
  author_email: 'me@x.com', provenance: {}, current_version: 0, position: 0, accessible: true, pinned: [], ...extra,
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(api.getInvestigationAnnotations).mockResolvedValue([])
  vi.mocked(api.getInvestigationEvents).mockResolvedValue([])
})

describe('investigation store', () => {
  it('adds explorations one by one as live references and reports a partial failure', async () => {
    vi.mocked(api.getInvestigation).mockResolvedValue({ id: 'inv1' } as any)
    vi.mocked(api.getInvestigationItems).mockResolvedValue([])
    vi.mocked(api.getInvestigationPage).mockResolvedValue({ items: [{ id: 'inv1', item_count: 1 }], total: 1, limit: 50, offset: 0, counts: {} } as any)
    vi.mocked(api.createInvestigationItem)
      .mockResolvedValueOnce(item('s1') as any)
      .mockRejectedValueOnce({ response: { data: { detail: 'No access to context' } } })

    const store = useInvestigationStore()
    await store.fetchInvestigations()
    await store.openInvestigation('inv1')
    const result = await store.addExplorations('inv1', ['e1', 'e2', 'e3'])

    expect(result.added).toBe(1)
    expect(result.error).toContain('No access')
    expect(api.createInvestigationItem).toHaveBeenCalledTimes(2) // stops at the failure
    expect(api.createInvestigationItem).toHaveBeenCalledWith('inv1', { kind: 'graph', subkind: 'exploration_ref', exploration_id: 'e1' })
    expect(store.items.map((s) => s.id)).toEqual(['s1'])
    expect(store.investigations[0].item_count).toBe(2)
  })

  it('unifies the canvas items, keeps unchecked ones off the canvas and applies confirmed same_as', async () => {
    vi.mocked(api.getInvestigation).mockResolvedValue({ id: 'inv1', settings: {} } as any)
    vi.mocked(api.getInvestigationItems).mockResolvedValue([
      item('g1', { context_id: 'c1' }),
      item('t1', { kind: 'table', subkind: 'csv', context_id: null, current_version: 1, mapping: { as: 'graph', spec: {} } }),
      item('d1', { kind: 'document', subkind: 'markdown', current_version: 1 }),
    ] as any)
    vi.mocked(api.getInvestigationAnnotations).mockResolvedValue([
      { id: 'a1', kind: 'same_as', targets: ['Pessoa:1', 'x@t1'], value: {}, status: 'suggested', author_kind: 'agent', author_email: 'me@x.com' },
    ] as any)
    vi.mocked(api.getInvestigationItemSnapshot).mockImplementation(async (_i, id) =>
      id === 'g1'
        ? { item_id: 'g1', title: 'g1', context_id: 'c1', snapshot: { nodes: [{ id: 'p', type: 'Pessoa', properties: { cpf: '1' } }], edges: [] }, identity_keys: [], edge_semantics: null }
        : { item_id: 't1', title: 't1', context_id: null, snapshot: { nodes: [{ id: 'x', type: 'Conta', properties: {} }], edges: [] }, identity_keys: [], edge_semantics: null } as any,
    )
    vi.mocked(api.getGraphContext).mockResolvedValue({
      id: 'c1', title: 'Pix', identity_keys: [{ node_type: 'Pessoa', entity: 'Pessoa', source: { kind: 'prop', name: 'cpf' }, normalize: 'none' }],
    } as any)

    const store = useInvestigationStore()
    await store.openInvestigation('inv1')
    expect(store.graphItems.map((i) => i.id)).toEqual(['g1', 't1']) // the document is not a graph item
    await store.loadWorkspace()
    expect(store.unified.nodes.map((n) => n.node_id).sort()).toEqual(['Pessoa:1', 'x@t1'])
    expect(store.contexts.t1.title).toBe('t1') // a mapped table carries its own pseudo-context

    store.toggleCanvas('t1', false)
    expect(store.unified.nodes.map((n) => n.node_id)).toEqual(['Pessoa:1'])
    store.toggleCanvas('t1', true)

    // A suggested match does nothing; the confirmed one folds the second node in.
    expect(store.unified.nodes).toHaveLength(2)
    store.annotations[0] = { ...store.annotations[0], status: 'confirmed' }
    expect(store.unified.nodes).toHaveLength(1)
    expect(store.unified.nodes[0].__sources.map((s) => s.sourceId)).toEqual(['g1', 't1'])
  })

  it('enrichment files add properties to the canvas, re-keyed when the mapping changes (BYOD-2)', async () => {
    const spec = { name: 'Risk', input: { delimiter: ';', header: true }, key_column: 'doc', columns: ['risk'], match_node_types: [], match_source: 'node_id' }
    const enrich = item('e1', { kind: 'table', subkind: 'csv', current_version: 1, mapping: { as: 'enrichment', spec }, latest: { content_type: 'text/csv' } })
    vi.mocked(api.getInvestigation).mockResolvedValue({ id: 'inv1', settings: {} } as any)
    vi.mocked(api.getInvestigationItems).mockResolvedValue([item('g1', { context_id: 'c1' }), enrich] as any)
    vi.mocked(api.getInvestigationItemSnapshot).mockResolvedValue({
      item_id: 'g1', title: 'g1', context_id: 'c1', identity_keys: [], edge_semantics: null,
      snapshot: { nodes: [{ id: 'p', type: 'Person', properties: { risk: 'low', doc: '1.1' } }, { id: 'q', type: 'Person', properties: {} }], edges: [] },
    } as any)
    vi.mocked(api.getGraphContext).mockResolvedValue({ id: 'c1', title: 'Bank', identity_keys: [] } as any)
    vi.mocked(api.getInvestigationItemContent).mockResolvedValue(new TextEncoder().encode('doc;risk\np;high\nq;mid\n11;top\n').buffer as any)

    const store = useInvestigationStore()
    await store.openInvestigation('inv1')
    expect(store.graphItems.map((i) => i.id)).toEqual(['g1']) // no nodes of its own
    await store.loadWorkspace()
    const byId = () => Object.fromEntries(store.unified.nodes.map((n) => [n.node_id, n]))
    // An empty type list is every type; the value already there wins and the file's is a conflict.
    expect(byId()['q@c1'].properties?.risk).toBe('mid')
    expect(byId()['p@c1'].properties?.risk).toBe('low')
    expect(byId()['p@c1'].__conflicts?.risk).toEqual([{ value: 'high', sourceId: 'e1' }])

    // A mapping edit (no new version) re-keys the cached rows: by the doc property, digits only.
    store.items[1] = { ...store.items[1], mapping: { as: 'enrichment', spec: { ...spec, match_source: { kind: 'prop', name: 'doc' }, normalize: 'digits', overwrite: true } } } as any
    expect(byId()['p@c1'].properties?.risk).toBe('top')
    expect(api.getInvestigationItemContent).toHaveBeenCalledTimes(1)
  })

  it('roles come from confirmed annotations; pinEvidence adds an item and pins it', async () => {
    vi.mocked(api.getInvestigation).mockResolvedValue({ id: 'inv1' } as any)
    vi.mocked(api.getInvestigationItems).mockResolvedValue([])
    vi.mocked(api.getInvestigationAnnotations)
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { id: 'r1', kind: 'role', targets: ['a'], value: { role: 'mula' }, status: 'confirmed', author_kind: 'human', author_email: 'me@x.com' },
        { id: 'r2', kind: 'role', targets: ['b'], value: { role: 'vítima' }, status: 'suggested', author_kind: 'agent', author_email: 'me@x.com' },
      ] as any)
    vi.mocked(api.createInvestigationAnnotation).mockResolvedValue({ id: 'r1' } as any)
    const store = useInvestigationStore()
    await store.openInvestigation('inv1')
    await store.setRole('a', 'mula')
    expect(api.createInvestigationAnnotation).toHaveBeenCalledWith('inv1', { kind: 'role', targets: ['a'], value: { role: 'mula' } })
    expect(store.roles).toEqual({ a: 'mula' }) // the suggestion is not a role yet
    expect(store.suggestions).toHaveLength(1)

    vi.mocked(api.createInvestigationItem).mockResolvedValue(item('res', { kind: 'table', subkind: 'result', current_version: 1 }) as any)
    vi.mocked(api.pinInvestigationItem).mockResolvedValue({ version: 1, sha256: 'ab'.repeat(32) } as any)
    vi.mocked(api.getInvestigationItems).mockResolvedValue([item('res', { kind: 'table', subkind: 'result', current_version: 1, pinned: [{ version: 1, sha256: 'ab'.repeat(32), pinned_at: 'x' }] })] as any)
    const pinned = await store.pinEvidence({ title: 'Trace', kind: 'trace', params: { allocation: 'fifo' }, snapshot: { exits: {} } })
    expect(pinned?.sha256).toBe('ab'.repeat(32))
    expect(api.createInvestigationItem).toHaveBeenCalledWith('inv1', expect.objectContaining({ kind: 'table', subkind: 'result', provenance: { tool: 'trace', params: { allocation: 'fifo' } } }))
    expect(api.pinInvestigationItem).toHaveBeenCalledWith('inv1', 'res', {})
    expect(store.evidence).toHaveLength(1)
  })

  it('a failed open clears the case and keeps the error', async () => {
    vi.mocked(api.getInvestigation).mockRejectedValue(new Error('404'))
    vi.mocked(api.getInvestigationItems).mockResolvedValue([])
    const store = useInvestigationStore()
    await store.openInvestigation('missing')
    expect(store.current).toBeNull()
    expect(store.error).toBeTruthy()
  })
})
