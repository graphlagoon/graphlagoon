import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useInvestigationStore } from '@/stores/investigation'
import { useCaseAnalyses, type LinksContent } from '@/composables/useCaseAnalyses'

const api = vi.hoisted(() => ({
  createInvestigationItem: vi.fn(async (_id: string, body: any) => ({ id: 'links-1', pinned: [], current_version: 1, tags: [], accessible: true, position: 0, status: 'confirmed', author_kind: 'human', author_email: 'me', ...body })),
  getInvestigationEvents: vi.fn(async () => []),
}))
vi.mock('@/services/api', () => ({ api }))

const node = (id: string, type: string, props: Record<string, unknown> = {}) => ({ node_id: id, node_type: type, properties: props })

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  const inv = useInvestigationStore()
  inv.current = { id: 'inv-1', status: 'analysis', has_write_access: true, settings: {}, state: {}, kind_preset: 'fraude_sintetica' } as any
  inv.items = [{ id: 's1', kind: 'table', subkind: 'csv', mapping: { as: 'graph', spec: {} }, title: 'Cadastros', tags: [], status: 'confirmed', accessible: true, current_version: 1, pinned: [], provenance: {} }] as any
  inv.contexts = { s1: { id: 's1', identity_keys: [{ node_type: 'Pessoa', entity: 'Pessoa', source: 'node_id', normalize: 'cpf_cnpj' }, { node_type: 'Telefone', entity: 'Telefone', source: 'node_id', normalize: 'phone' }] } } as any
  inv.sourceGraphs = [
    {
      id: 's1', contextId: 's1', state: null, error: null,
      nodes: [
        node('11111111111', 'Pessoa', { nome: 'Ana', device_id: 'DEV-1' }),
        node('22222222222', 'Pessoa', { nome: 'Bia', device_id: 'dev-1' }),
        node('33333333333', 'Pessoa', { nome: 'Caio', device_id: 'dev-9' }),
        node('+55 11 99999-0000', 'Telefone'),
      ],
      edges: [
        { edge_id: 'e1', src: '11111111111', dst: '+55 11 99999-0000', relationship_type: 'USA_TELEFONE', properties: {} },
        { edge_id: 'e2', src: '22222222222', dst: '+55 11 99999-0000', relationship_type: 'USA_TELEFONE', properties: {} },
      ],
    },
  ] as any
})

describe('Vínculos as a graph/derived item (05 §4b)', () => {
  it('links the entities sharing phone + device, saves them as a derived item with provenance, and the canvas merges the layer by unified id', async () => {
    const inv = useInvestigationStore()
    const analyses = useCaseAnalyses()
    const item = await analyses.runLinks({ attributes: ['Telefone', 'device_id'], minShared: 2, maxEntities: 10 })
    expect(item?.subkind).toBe('derived')
    const [id, body] = api.createInvestigationItem.mock.calls[0]
    expect(id).toBe('inv-1')
    expect(body).toMatchObject({ kind: 'graph', subkind: 'derived', provenance: { tool: 'links', params: { attributes: ['Telefone', 'device_id'], minShared: 2 } } })
    const content = body.content_json as LinksContent
    expect(content.unified).toBe(true)
    expect(content.pairs).toEqual([{ left: 'Pessoa:11111111111', right: 'Pessoa:22222222222', shared: ['Telefone', 'device_id'] }])
    expect(content.edges.map((e) => e.type).sort()).toEqual(['compartilha_Telefone', 'compartilha_device_id'])
    expect(content.nodes.map((n) => n.id).sort()).toEqual(['Pessoa:11111111111', 'Pessoa:22222222222'])
    expect(item?.title).toContain('1 par')

    // Loaded back as a source flagged `unified`, the layer merges into the existing entities (ring, no new node).
    inv.sourceGraphs = [
      ...inv.sourceGraphs,
      { id: 'links-1', contextId: 'links-1', unified: true, state: null, error: null,
        nodes: content.nodes.map((n) => ({ node_id: n.id, node_type: n.type, properties: n.properties })),
        edges: content.edges.map((e) => ({ edge_id: e.id, src: e.source, dst: e.target, relationship_type: e.type, properties: e.properties })) },
    ] as any
    expect(inv.unified.nodes).toHaveLength(4)
    const ana = inv.unified.nodes.find((n) => n.node_id === 'Pessoa:11111111111')!
    expect(ana.__sources.map((s) => s.sourceId)).toEqual(['s1', 'links-1'])
    expect(inv.unified.edges.filter((e) => e.relationship_type.startsWith('compartilha_'))).toHaveLength(2)
  })

  it('reports an error instead of an item when nothing can run', async () => {
    const analyses = useCaseAnalyses()
    const item = await analyses.saveMetricsTable()
    expect(item).toBeNull()
    expect(analyses.error.value).toContain('No metric computed')
  })
})
