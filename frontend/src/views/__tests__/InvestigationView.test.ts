import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import InvestigationView from '@/views/InvestigationView.vue'
import { useGraphStore } from '@/stores/graph'
import { useContextMenu } from '@/composables/useContextMenu'
import fixture from '@/__tests__/fixtures/trace/golpe-pix.json'

vi.mock('@/services/api', () => ({
  api: {
    getInvestigation: vi.fn(),
    getInvestigationItems: vi.fn(),
    getInvestigationAnnotations: vi.fn(async () => []),
    getInvestigationItemSnapshot: vi.fn(),
    getGraphContext: vi.fn(),
    getInvestigationEvents: vi.fn(async () => []),
    getInvestigationBrief: vi.fn(async () => ({ item: null, text: '' })),
    createInvestigationAnnotation: vi.fn(),
    setInvestigationAnnotationStatus: vi.fn(),
    createInvestigationItem: vi.fn(),
    lookupEnrichment: vi.fn(),
    postInvestigationEvent: vi.fn(async () => ({})),
  },
}))
vi.mock('@/components/GraphCanvas3D.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/LayoutPanel.vue', () => ({ default: { render: () => null } }))
vi.mock('@/services/metricsCalculator', () => ({ resetMetricsCalculator: vi.fn() }))

import { api } from '@/services/api'

const item = (id: string, contextId: string) => ({
  id, kind: 'graph', subkind: 'exploration_ref', title: id, tags: [], status: 'confirmed', author_kind: 'human',
  author_email: 'me@x.com', provenance: {}, exploration_id: `e-${id}`, context_id: contextId, current_version: 0,
  position: 0, accessible: true, pinned: [],
})
const snapshot = (ids: string[]) => ({
  exploration: { state: {} },
  snapshot: { nodes: ids.map((id) => ({ id, type: 'T', properties: {} })), edges: [] },
  identity_keys: [], edge_semantics: null,
})
const pix = () => ({
  exploration: { state: {} },
  snapshot: {
    nodes: fixture.nodes.map((n) => ({ id: n.node_id, type: n.node_type, properties: n.properties ?? {} })),
    edges: fixture.edges.map((e) => ({ id: e.edge_id, source: e.src, target: e.dst, type: e.relationship_type, properties: e.properties })),
  },
  identity_keys: [], edge_semantics: null,
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(api.getInvestigation).mockResolvedValue({ id: 'inv', title: 'Case', status: 'analysis', has_write_access: true, settings: {} } as any)
  vi.mocked(api.getInvestigationItems).mockResolvedValue([item('s1', 'c1'), item('s2', 'c2')] as any)
  vi.mocked(api.getInvestigationAnnotations).mockResolvedValue([])
  vi.mocked(api.getInvestigationItemSnapshot).mockImplementation(async (_i, sid) =>
    (sid === 's1' ? snapshot(['a', 'b']) : snapshot(['x'])) as any,
  )
  vi.mocked(api.getGraphContext).mockImplementation(async (id) => ({ id, title: id, identity_keys: [] }) as any)
  vi.mocked(api.getInvestigationEvents).mockResolvedValue([])
  vi.mocked(api.getInvestigationBrief).mockResolvedValue({ item: null, text: '' })
})

const stubs = {
  RouterLink: { template: '<a><slot /></a>' },
  GraphCanvas3D: true,
  LayoutPanel: true,
  AddToInvestigationModal: true,
  FileImportWizard: true,
}

describe('InvestigationView', () => {
  it('unifies the graph items and the "on canvas" checkbox removes an item without a reload', async () => {
    const { getByTestId } = render(InvestigationView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    const graph = useGraphStore()
    expect(graph.nodes.map((n) => n.node_id).sort()).toEqual(['a@c1', 'b@c1', 'x@c2'])
    expect(getByTestId('workspace-status').textContent).toContain('2 sources')

    await fireEvent.click(getByTestId('item-canvas-s2'))
    await flushPromises()
    expect(graph.nodes.map((n) => n.node_id)).toEqual(['a@c1', 'b@c1'])
    expect(api.getInvestigationItemSnapshot).toHaveBeenCalledTimes(2) // no reload

    await fireEvent.click(getByTestId('item-canvas-s2'))
    await flushPromises()
    expect(graph.nodes).toHaveLength(3)
  })

  it('sets a role (annotation), adds a note (item) and confirms a suggestion from the inspector', async () => {
    vi.mocked(api.createInvestigationAnnotation).mockResolvedValue({ id: 'r1' } as any)
    vi.mocked(api.getInvestigationAnnotations)
      .mockResolvedValueOnce([
        { id: 's9', kind: 'role', targets: ['a@c1'], value: { role: 'mula' }, status: 'suggested', author_kind: 'agent', author_email: 'me@x.com', reason: 'repassa' },
      ] as any)
      .mockResolvedValue([
        { id: 'r1', kind: 'role', targets: ['a@c1'], value: { role: 'vítima' }, status: 'confirmed', author_kind: 'human', author_email: 'me@x.com' },
      ] as any)
    vi.mocked(api.createInvestigationItem).mockImplementation(async (_i, body) =>
      ({ id: 'n1', ...body, status: 'confirmed', author_kind: 'human', author_email: 'me@x.com', pinned: [], current_version: 1, accessible: true, provenance: {} }) as any,
    )
    vi.mocked(api.setInvestigationAnnotationStatus).mockResolvedValue({ id: 's9', status: 'confirmed' } as any)
    const { getByTestId, findAllByText } = render(InvestigationView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    const graph = useGraphStore()
    graph.selectNode('a@c1')
    await flushPromises()

    expect(getByTestId('suggestion-s9').textContent).toContain('role: mula')
    await fireEvent.update(getByTestId('inspector-role'), 'vítima')
    await flushPromises()
    expect(api.createInvestigationAnnotation).toHaveBeenCalledWith('inv', { kind: 'role', targets: ['a@c1'], value: { role: 'vítima' } })
    expect(graph.roleColors?.get('a@c1')).toBe('#2563eb')

    await fireEvent.click(getByTestId('inspector-notes-tab'))
    await fireEvent.update(getByTestId('note-input'), 'KYC mismatch')
    await fireEvent.click(getByTestId('note-add'))
    await flushPromises()
    expect(api.createInvestigationItem).toHaveBeenCalledWith('inv', expect.objectContaining({ kind: 'note', subkind: 'anchored', content: 'KYC mismatch', anchor: { entity_ids: ['a@c1'] } }))
    expect((await findAllByText('KYC mismatch')).length).toBeGreaterThan(0) // inspector and material list
    expect(api.getInvestigationEvents).toHaveBeenCalled()
  })

  it('confirming an agent suggestion calls the confirm route', async () => {
    vi.mocked(api.getInvestigationAnnotations).mockResolvedValue([
      { id: 's9', kind: 'role', targets: ['a@c1'], value: { role: 'mula' }, status: 'suggested', author_kind: 'agent', author_email: 'me@x.com' },
    ] as any)
    vi.mocked(api.setInvestigationAnnotationStatus).mockResolvedValue({ id: 's9', status: 'confirmed' } as any)
    const { getByTestId } = render(InvestigationView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    expect(getByTestId('status-suggestions').textContent).toContain('1 suggestions')
    useGraphStore().selectNode('a@c1')
    await flushPromises()
    await fireEvent.click(getByTestId('suggestion-confirm-s9'))
    await flushPromises()
    expect(api.setInvestigationAnnotationStatus).toHaveBeenCalledWith('inv', 's9', 'confirmed')
  })

  it('shows enrichment rows and promotes shared devices to a node', async () => {
    const devices = {
      name: 'devices', label: 'Login devices', table: 'main.risk.devices', key_column: 'account_id',
      match_node_types: ['T'], match_source: 'node_id', cardinality: 'many', columns: ['device_id'],
      promote: { node_type: 'Dispositivo', id_column: 'device_id', edge_type: 'USOU' },
    }
    vi.mocked(api.getGraphContext).mockImplementation(async (id) =>
      ({ id, title: id, identity_keys: [], enrichment_tables: id === 'c1' ? [devices] : [] }) as any,
    )
    vi.mocked(api.lookupEnrichment).mockResolvedValue({
      rows: { a: [{ device_id: 'd1' }], b: [{ device_id: 'd1' }] }, truncated: false,
    } as any)
    const { getByTestId } = render(InvestigationView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    const graph = useGraphStore()
    graph.selectNode('a@c1')
    await flushPromises()

    await fireEvent.click(getByTestId('inspector-enrichment-tab'))
    await flushPromises()
    expect(api.lookupEnrichment).toHaveBeenCalledWith('c1', 'devices', ['a', 'b'])
    expect(getByTestId('enrichment-rows').textContent).toContain('d1')

    await fireEvent.click(getByTestId('enrichment-promote'))
    await flushPromises()
    expect(api.postInvestigationEvent).toHaveBeenCalledWith('inv', 'nodes.promoted', expect.objectContaining({ nodes: 1, edges: 2 }))
    expect(graph.nodes.map((n) => n.node_id)).toContain('Dispositivo:d1@c1')
    expect(graph.edges.filter((e) => e.dst === 'Dispositivo:d1@c1').map((e) => e.src).sort()).toEqual(['a@c1', 'b@c1'])
  })

  it('follow the money: the menu action opens T5 with the traced subgraph by layer and its exits', async () => {
    vi.mocked(api.getInvestigationItems).mockResolvedValue([item('s1', 'c1')] as any)
    vi.mocked(api.getInvestigationItemSnapshot).mockResolvedValue(pix() as any)
    vi.mocked(api.getGraphContext).mockImplementation(async (id) =>
      ({ id, title: id, identity_keys: [], edge_semantics: fixture.edge_semantics }) as any,
    )
    const { getByTestId, queryByTestId } = render(InvestigationView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    const graph = useGraphStore()
    expect(graph.nodes).toHaveLength(9)

    const action = useContextMenu().actions.value.find((a) => a.id === 'trace-forward')!
    await action.handler({ type: 'node', id: '0001-9@c1', label: '0001-9' })
    await flushPromises()

    expect(getByTestId('trace-exits').textContent).toContain('Saque ATM')
    expect(getByTestId('trace-coverage').textContent).toContain('(91%)')
    expect(graph.layoutAlgorithm).toBe('trace-layers')
    expect(graph.traceLayers?.labels).toEqual(['Seed', 'Layer 1', 'Layer 2', 'Exits'])
    expect(graph.nodes).toHaveLength(8) // the untraced external bank is left out
    expect(queryByTestId('workspace-inspector')).toBeNull()

    await fireEvent.click(getByTestId('tab-unified'))
    await flushPromises()
    expect(graph.layoutAlgorithm).toBe('force')
    expect(graph.nodes).toHaveLength(9)
    expect(getByTestId('tab-trace')).toBeTruthy()
  })

  it('path to: the next node clicked is the target and the path is selected', async () => {
    vi.mocked(api.getInvestigationItems).mockResolvedValue([item('s1', 'c1')] as any)
    vi.mocked(api.getInvestigationItemSnapshot).mockResolvedValue(pix() as any)
    const { getByTestId } = render(InvestigationView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    const graph = useGraphStore()

    const action = useContextMenu().actions.value.find((a) => a.id === 'path-to')!
    expect(action.visible?.({ type: 'edge', id: 'x', label: '' })).toBe(false)
    await action.handler({ type: 'node', id: '0001-9@c1', label: '0001-9' })
    await flushPromises()
    expect(getByTestId('path-pick').textContent).toContain('vítima')

    graph.selectNode('saque-atm@c1')
    await flushPromises()
    expect([...graph.selectedNodeIds]).toEqual(['0001-9@c1', '4471-0@c1', '5520-3@c1', 'saque-atm@c1'])
    expect(graph.selectedEdgeIds.size).toBe(3)
    expect(getByTestId('path-result').textContent).toContain('3 hops')
  })

  it('typology badges: a badge cites CC 4.001, highlights its entities, and accepting it writes a typology annotation', async () => {
    vi.mocked(api.getInvestigationItems).mockResolvedValue([item('s1', 'c1')] as any)
    vi.mocked(api.getInvestigationItemSnapshot).mockResolvedValue(pix() as any)
    vi.mocked(api.getGraphContext).mockImplementation(async (id) =>
      ({ id, title: id, identity_keys: [], edge_semantics: fixture.edge_semantics }) as any,
    )
    vi.mocked(api.createInvestigationAnnotation).mockResolvedValue({ id: 't1' } as any)
    const { getByTestId } = render(InvestigationView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    await fireEvent.click(getByTestId('workspace-typologies-btn'))
    const badge = getByTestId('typology-passagem')
    expect(badge.textContent).toContain('CC 4.001 IV-k, IV-ad')

    await fireEvent.click(badge)
    const graph = useGraphStore()
    expect(graph.selectedNodeIds.has('4471-0@c1')).toBe(true)

    vi.mocked(api.getInvestigationAnnotations).mockResolvedValue([
      { id: 't1', kind: 'typology', targets: ['4471-0@c1'], value: { typology: 'passagem' }, status: 'confirmed', author_kind: 'human', author_email: 'me@x.com' },
    ] as any)
    await fireEvent.click(getByTestId('typology-accept-passagem'))
    await flushPromises()
    expect(api.createInvestigationAnnotation).toHaveBeenCalledWith('inv', expect.objectContaining({
      kind: 'typology', value: expect.objectContaining({ typology: 'passagem', norm_ref: 'CC 4.001 IV-k, IV-ad' }),
    }))
    expect(getByTestId('typology-accepted')).toBeTruthy()

    await fireEvent.click(getByTestId('typology-bipartite'))
    expect(graph.layoutAlgorithm).toBe('hive')
    expect(graph.layoutModeConfig.hive.maxAxes).toBe(1)
  })
})
