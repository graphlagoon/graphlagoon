import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SelectionInspector from '@/components/investigation/SelectionInspector.vue'
import { useInvestigationStore } from '@/stores/investigation'
import { useGraphStore } from '@/stores/graph'

const api = vi.hoisted(() => ({
  createInvestigationAnnotation: vi.fn(async (_id: string, body: any) => ({ id: 'ann-1', status: 'confirmed', author_kind: 'human', author_email: 'me', ...body })),
  getInvestigationAnnotations: vi.fn(async () => []),
  deleteInvestigationAnnotation: vi.fn(async () => {}),
  createInvestigationItem: vi.fn(async (_id: string, body: any) => ({ id: 'it-1', pinned: [], current_version: 1, tags: [], accessible: true, position: 0, status: 'confirmed', author_kind: 'human', author_email: 'me', ...body })),
  updateInvestigationItem: vi.fn(async (_id: string, itemId: string, patch: any) => ({ ...ITEM, id: itemId, ...patch })),
  pinInvestigationItem: vi.fn(async () => ({ version: 1, sha256: 'ab'.repeat(32) })),
  getInvestigationItems: vi.fn(async () => [ITEM]),
  getInvestigationEvents: vi.fn(async () => []),
  updateInvestigation: vi.fn(async (_id: string, patch: any) => ({ ...CASE, ...patch })),
  getInvestigationItemContent: vi.fn(async (): Promise<ArrayBuffer> => new ArrayBuffer(0)),
}))
const CASE = { id: 'inv-1', status: 'analysis', has_write_access: true, settings: { vocabularies: { roles: ['real customer', 'synthetic identity', 'mule'], tags: [], link_attributes: [] } }, state: {}, case_type: 'fraud_ring', fields: {}, shared_with: [], tags: [] }
const ITEM = { id: 'it-1', kind: 'table', subkind: 'result', title: 'Rastreio FIFO', tags: [], status: 'suggested', author_kind: 'agent', author_email: 'me', provenance: { tool: 'trace', params: { maxHops: 3 } }, current_version: 1, pinned: [], accessible: true, position: 0, latest: { version: 1, sha256: 'c'.repeat(64) } }
vi.mock('@/services/api', () => ({ api }))

const node = (id: string, type: string, props: Record<string, unknown> = {}) => ({ node_id: id, node_type: type, properties: props })

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  const inv = useInvestigationStore()
  inv.current = { ...CASE } as any
  inv.items = [ITEM, { id: 's1', kind: 'graph', subkind: 'exploration_ref', title: 'KYC', tags: [], status: 'confirmed', accessible: true, current_version: 0, pinned: [], provenance: {}, exploration_id: 'e1', context_id: 'c1' }] as any
  inv.contexts = { c1: { id: 'c1', title: 'KYC', identity_keys: [] } } as any
  inv.sourceGraphs = [
    { id: 's1', contextId: 'c1', nodes: [node('a', 'Person', { name: 'Ana', document: '12345678901' }), node('b', 'Person', { name: 'Bia' }), node('c', 'Person', { name: 'Caio' })], edges: [], state: null, error: null },
  ] as any
})

const mount = (props: Partial<{ activeItem: any; canEdit: boolean; decideMode: boolean }> = {}) =>
  render(SelectionInspector, { props: { activeItem: null, canEdit: true, decideMode: false, ...props } })

describe('SelectionInspector (05 §3, three states)', () => {
  it('one entity: label, vocabulary roles of the preset, tags, every property', async () => {
    useGraphStore().selectNode('a@c1')
    const { getByTestId, queryByText, emitted } = mount()
    await flushPromises()
    expect(getByTestId('inspector-title').textContent).toBe('Ana')
    expect(getByTestId('inspector-role').textContent).toContain('synthetic identity')
    expect(queryByText('12345678901')).not.toBeNull() // what the person reads, as is
    await fireEvent.update(getByTestId('inspector-tag-input'), 'kyc')
    await fireEvent.keyDown(getByTestId('inspector-tag-input'), { key: 'Enter' })
    await flushPromises()
    expect(api.createInvestigationAnnotation).toHaveBeenCalledWith('inv-1', { kind: 'tag', targets: ['a@c1'], value: { tag: 'kyc' } })
    await fireEvent.click(getByTestId('inspector-open-entity'))
    expect(emitted('open-entity')).toBeTruthy()
  })

  it('multi-selection: composition, bulk role and tag, group from the selection (name, color, closed), same-as for two, save selection', async () => {
    const graph = useGraphStore()
    graph.selectedNodeIds = new Set(['a@c1', 'b@c1', 'c@c1'])
    const { getByTestId, queryByTestId } = mount()
    await flushPromises()
    expect(getByTestId('inspector-multi-title').textContent).toContain('3 entities')
    expect(getByTestId('inspector-composition').textContent).toContain('3 Person')
    expect(queryByTestId('bulk-same-as')).toBeNull() // only for exactly two

    await fireEvent.update(getByTestId('bulk-role'), 'mule')
    await fireEvent.click(getByTestId('bulk-role-apply'))
    await flushPromises()
    expect(api.createInvestigationAnnotation).toHaveBeenCalledTimes(3)
    expect(api.createInvestigationAnnotation).toHaveBeenCalledWith('inv-1', { kind: 'role', targets: ['c@c1'], value: { role: 'mule' } })

    await fireEvent.update(getByTestId('bulk-tag'), 'cluster')
    await fireEvent.click(getByTestId('bulk-tag-apply'))
    await flushPromises()
    expect(api.createInvestigationAnnotation).toHaveBeenLastCalledWith('inv-1', { kind: 'tag', targets: ['a@c1', 'b@c1', 'c@c1'], value: { tag: 'cluster' } })

    await fireEvent.update(getByTestId('bulk-group-name'), 'Cluster sintético')
    await fireEvent.click(getByTestId('bulk-group-color-3'))
    await fireEvent.click(getByTestId('bulk-group-closed'))
    await fireEvent.click(getByTestId('bulk-group-create'))
    await flushPromises()
    expect(api.createInvestigationAnnotation).toHaveBeenLastCalledWith('inv-1', { kind: 'group', targets: ['a@c1', 'b@c1', 'c@c1'], value: { name: 'Cluster sintético', color: 3, by: 'selection' } })
    expect(api.updateInvestigation).toHaveBeenCalledWith('inv-1', { state: { groups_closed: ['ann-1'] } })

    await fireEvent.click(getByTestId('bulk-save-selection'))
    await flushPromises()
    expect(api.createInvestigationItem).toHaveBeenCalledWith('inv-1', expect.objectContaining({ kind: 'graph', subkind: 'selection', content_json: expect.objectContaining({ unified: true }) }))
    expect(useInvestigationStore().canvasIds.has('it-1')).toBe(false)

    graph.selectedNodeIds = new Set(['a@c1', 'b@c1'])
    await flushPromises()
    await fireEvent.update(getByTestId('bulk-same-as-reason'), 'mesmo telefone')
    await fireEvent.click(getByTestId('bulk-same-as'))
    await flushPromises()
    expect(api.createInvestigationAnnotation).toHaveBeenLastCalledWith('inv-1', { kind: 'same_as', targets: ['a@c1', 'b@c1'], value: { score: 1 }, reason: 'mesmo telefone' })
  })

  it('item: card with provenance, confirm a suggested item, pin, flag for the dossier, open the analysis', async () => {
    const { getByTestId, emitted } = mount({ activeItem: ITEM })
    await flushPromises()
    expect(getByTestId('inspector-item-title').textContent).toBe('Rastreio FIFO')
    expect(getByTestId('item-suggested')).toBeTruthy()
    await fireEvent.click(getByTestId('item-pin'))
    await flushPromises()
    expect(api.pinInvestigationItem).toHaveBeenCalledWith('inv-1', 'it-1', {})
    await fireEvent.click(getByTestId('item-dossier'))
    await flushPromises()
    expect(api.updateInvestigationItem).toHaveBeenCalledWith('inv-1', 'it-1', { tags: ['dossier'] })
    await fireEvent.click(getByTestId('item-show-analysis'))
    expect(emitted('activate')).toBeTruthy()
  })

  it('item: previews a CSV version as a table and downloads it under its file name', async () => {
    const csv = { ...ITEM, id: 'it-csv', subkind: 'csv', title: 'Extrato SIMBA', status: 'confirmed', provenance: { filename: 'CASO17_EXTRATO.TXT' }, latest: { version: 1, sha256: 'd'.repeat(64), content_type: 'text/csv', size_bytes: 40 } }
    api.getInvestigationItemContent.mockResolvedValue(new TextEncoder().encode('CONTA\tVALOR\n109738-0\t3431900\n').buffer)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const { getByTestId } = mount({ activeItem: csv })
    await fireEvent.click(getByTestId('item-preview-open'))
    await flushPromises()
    const preview = getByTestId('item-preview')
    expect(preview.dataset.kind).toBe('table')
    expect(preview.textContent).toContain('VALOR')
    expect(preview.textContent).toContain('3431900')
    await fireEvent.click(getByTestId('item-download'))
    await flushPromises()
    expect(api.getInvestigationItemContent).toHaveBeenCalledTimes(1) // bytes reused
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe('CASO17_EXTRATO.TXT')
    click.mockRestore()
  })

  it('decision mode shows the guided panel in place', async () => {
    const { getByTestId } = mount({ decideMode: true })
    expect(getByTestId('decision-panel')).toBeTruthy()
    expect(getByTestId('decision-form')).toBeTruthy()
  })

  it('one node: the data tab is the shared details view (allowlist, hidden empties) and Open details asks the host', async () => {
    const graph = useGraphStore()
    graph.setPropertyVisibility('node', ['name'])
    graph.selectNode('a@c1')
    const { getByTestId, emitted } = mount()
    await flushPromises()
    expect(getByTestId('inspector-data').textContent).toContain('Ana')
    expect(getByTestId('inspector-data').textContent).not.toContain('12345678901')
    expect(getByTestId('property-visibility-hint').textContent).toContain('1 of 2')
    await fireEvent.click(getByTestId('inspector-open-details'))
    expect(emitted('open-details')).toHaveLength(1)
  })

  it('one node: "Default focus" saves the node (as the item knows it) on the one graph on the canvas', async () => {
    const inv = useInvestigationStore()
    inv.current = { ...CASE, state: { canvas_items: ['s1'] } } as any
    useGraphStore().selectNode('a@c1')
    const { getByTestId } = mount()
    await flushPromises()
    await fireEvent.click(getByTestId('inspector-default-focus'))
    await flushPromises()
    expect(api.updateInvestigationItem).toHaveBeenCalledWith('inv-1', 's1', { state: { look: { focus_node_id: 'a' } } })
  })

  it('one node: no default focus button in a read-only case or with several graphs on the canvas', async () => {
    const inv = useInvestigationStore()
    inv.current = { ...CASE, has_write_access: false, state: { canvas_items: ['s1'] } } as any
    useGraphStore().selectNode('a@c1')
    const { queryByTestId } = mount({ canEdit: false })
    await flushPromises()
    expect(queryByTestId('inspector-default-focus')).toBeNull()
  })

  it('one edge: type, readable endpoints that select, source chip, amount and time, follow the money both ways, a note on the edge', async () => {
    const inv = useInvestigationStore()
    inv.contexts = { c1: { id: 'c1', title: 'KYC', identity_keys: [], edge_semantics: { amount_prop: 'valor', time_prop: 'quando' } } } as any
    inv.sourceGraphs[0].edges = [
      { edge_id: 'e1', src: 'a', dst: 'b', relationship_type: 'PIX', properties: { valor: 1500, quando: '2026-03-01T10:00:00Z', memo: 'rent' } },
      { edge_id: 'e2', src: 'b', dst: 'c', relationship_type: 'PIX', properties: { valor: 500, quando: '2026-03-02T10:00:00Z' } },
    ] as any
    inv.items = [...inv.items, { id: 'n1', kind: 'note', subkind: 'anchored', title: 'Suspicious', description: 'Suspicious', tags: [], status: 'confirmed', author_kind: 'human', author_email: 'me', anchor: { edge_ids: ['s1:e1'] }, current_version: 1, pinned: [], accessible: true, position: 0 }] as any
    const graph = useGraphStore()
    graph.selectEdge('s1:e1') // unified edge ids are <source>:<edge_id>
    const { getByTestId, emitted } = mount()
    await flushPromises()
    expect(getByTestId('inspector-edge-title').textContent).toContain('Ana')
    expect(getByTestId('inspector-edge-title').textContent).toContain('Bia')
    expect(getByTestId('inspector-edge-source').textContent).toBe('KYC')
    expect(getByTestId('inspector-edge-amount').textContent).toContain('1')
    expect(getByTestId('inspector-edge-time')).toBeTruthy()
    expect(document.body.textContent).toContain('memo')

    await fireEvent.click(getByTestId('inspector-edge-trace-backward'))
    expect(emitted('trace')?.[0]).toEqual([{ type: 'edge', id: 's1:e1' }, 'backward']) // the unified id, what the analyses take

    await fireEvent.click(getByTestId('inspector-edge-notes-tab'))
    expect(getByTestId('inspector-edge-notes').textContent).toContain('Suspicious')
    await fireEvent.update(getByTestId('edge-note-input'), 'Check the receipt')
    await fireEvent.click(getByTestId('edge-note-add'))
    await flushPromises()
    expect(api.createInvestigationItem).toHaveBeenCalledWith('inv-1', expect.objectContaining({ kind: 'note', subkind: 'anchored', anchor: { edge_ids: ['s1:e1'] } }))

    await fireEvent.click(getByTestId('inspector-edge-dst'))
    expect(graph.selectedNodeIds.has('b@c1')).toBe(true)
  })

  it('several edges: count, composition by type and the total amount', async () => {
    const inv = useInvestigationStore()
    inv.contexts = { c1: { id: 'c1', title: 'KYC', identity_keys: [], edge_semantics: { amount_prop: 'valor', time_prop: 'quando' } } } as any
    inv.sourceGraphs[0].edges = [
      { edge_id: 'e1', src: 'a', dst: 'b', relationship_type: 'PIX', properties: { valor: 1500, quando: '2026-03-01T10:00:00Z' } },
      { edge_id: 'e2', src: 'b', dst: 'c', relationship_type: 'TED', properties: { valor: 500, quando: '2026-03-02T10:00:00Z' } },
    ] as any
    const graph = useGraphStore()
    graph.selectedEdgeIds = new Set(['s1:e1', 's1:e2'])
    const { getByTestId } = mount()
    await flushPromises()
    expect(getByTestId('inspector-edges-title').textContent).toContain('2 edges')
    expect(getByTestId('inspector-edges-composition').textContent).toContain('1 PIX')
    expect(getByTestId('inspector-edges-total').textContent).toContain('2')
  })
})
