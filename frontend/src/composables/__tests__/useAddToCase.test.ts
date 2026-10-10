import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAddToCase, classifyPaste, queryParameterNames } from '@/composables/useAddToCase'
import { useCurrentCaseStore } from '@/stores/currentCase'
import { useGraphStore } from '@/stores/graph'
import { useToast } from '@/composables/useToast'

vi.mock('@/services/api', () => ({
  api: {
    getInvestigation: vi.fn(),
    createInvestigationItem: vi.fn(async (_id: string, data: any) => ({ id: 'item-1', title: data.title ?? 'x', tags: [], pinned: [], latest: null })),
    uploadInvestigationItem: vi.fn(async () => ({ id: 'item-2', title: 'f.csv', tags: [], pinned: [] })),
    runInvestigationQuery: vi.fn(async () => ({ id: 'q1', latest: { run: { row_count: 3, duration_ms: 12 } } })),
  },
}))
import { api } from '@/services/api'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  vi.clearAllMocks()
  useToast().toasts.value.splice(0)
})

describe('useAddToCase', () => {
  it('adds a table, a saved query (declaring :params) and a note to the current case with one toast', async () => {
    const current = useCurrentCaseStore()
    current.setCurrentCase({ id: 'inv-1', title: 'Golpe Pix', status: 'analysis', has_write_access: true } as any)
    const add = useAddToCase()
    expect(add.enabled.value).toBe(true)

    await add.addTable({ columns: ['cpf', 'v'], rows: [['1', 2]], title: 'Resultado', provenance: { tool: 'console' } })
    expect(api.createInvestigationItem).toHaveBeenCalledWith('inv-1', {
      kind: 'table', subkind: 'result', title: 'Resultado', description: undefined, provenance: { tool: 'console' },
      content_json: { columns: ['cpf', 'v'], rows: [['1', 2]], row_count: 1 },
    })

    await add.saveQuery({ context_id: 'c1', text: 'SELECT * FROM t WHERE cpf IN (:cpfs) AND uf = :uf', language: 'sql' })
    const query = vi.mocked(api.createInvestigationItem).mock.calls[1][1]
    expect(query.kind).toBe('query')
    expect(query.subkind).toBe('sql')
    expect(query.context_id).toBe('c1')
    expect(query.query?.parameters.map((p) => p.id)).toEqual(['cpfs', 'uf'])
    expect(query.query?.output).toBe('table')

    await add.addNote('Achado importante', { entity_ids: ['p1'] })
    expect(vi.mocked(api.createInvestigationItem).mock.calls[2][1]).toMatchObject({ kind: 'note', subkind: 'anchored', anchor: { entity_ids: ['p1'] } })

    const toasts = useToast().toasts.value
    expect(toasts.filter((t) => t.message.startsWith('Adicionado ao caso Golpe Pix'))).toHaveLength(3)
  })

  it('addSelection stores the selected nodes and their edges as graph/selection; nothing selected = no call', async () => {
    useCurrentCaseStore().setCurrentCase({ id: 'inv-1', title: 'Caso' })
    const graph = useGraphStore()
    graph.currentContext = { id: 'c1', title: 'Pix' } as any
    graph.nodes = [
      { node_id: 'a', node_type: 'Conta', properties: { x: 1 } },
      { node_id: 'b', node_type: 'Conta', properties: {} },
      { node_id: 'c', node_type: 'Conta', properties: {} },
    ] as any
    graph.edges = [
      { edge_id: 'ab', src: 'a', dst: 'b', relationship_type: 'PIX', properties: {} },
      { edge_id: 'bc', src: 'b', dst: 'c', relationship_type: 'PIX', properties: {} },
    ] as any
    const add = useAddToCase()
    await add.addSelection(['a', 'b'])
    const body = vi.mocked(api.createInvestigationItem).mock.calls[0][1]
    expect(body.kind).toBe('graph')
    expect(body.subkind).toBe('selection')
    expect(body.context_id).toBe('c1')
    expect((body.content_json as any).nodes.map((n: any) => n.id)).toEqual(['a', 'b'])
    expect((body.content_json as any).edges.map((e: any) => e.id)).toEqual(['ab'])

    await add.addSelection([])
    expect(api.createInvestigationItem).toHaveBeenCalledTimes(1)
  })

  it('without a current case nothing is sent and the person is told to pick one; an explicit caseId wins', async () => {
    const add = useAddToCase()
    expect(add.enabled.value).toBe(false)
    expect(await add.addExploration('e1')).toBeNull()
    expect(api.createInvestigationItem).not.toHaveBeenCalled()
    expect(useToast().toasts.value[0].message).toContain('Escolha um caso')

    const explicit = useAddToCase('inv-9')
    await explicit.addExploration('e1')
    expect(api.createInvestigationItem).toHaveBeenCalledWith('inv-9', { kind: 'graph', subkind: 'exploration_ref', exploration_id: 'e1' })
  })

  it('classifies pasted text and finds :parameters', () => {
    expect(classifyPaste('https://x.gov.br/a')).toEqual({ kind: 'url' })
    expect(classifyPaste('a;b\n1;2\n3;4')).toEqual({ kind: 'table', columns: ['a', 'b'], rows: [['1', '2'], ['3', '4']] })
    expect(classifyPaste('a;b\n1;2;3')).toEqual({ kind: 'note' })
    expect(classifyPaste('só uma frase')).toEqual({ kind: 'note' })
    expect(queryParameterNames('SELECT :a, :a, t.c, x::int, :d_1')).toEqual(['a', 'd_1'])
  })
})
