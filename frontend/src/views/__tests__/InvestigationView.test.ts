import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import InvestigationView from '@/views/InvestigationView.vue'
import { useGraphStore } from '@/stores/graph'
import { useInvestigationStore } from '@/stores/investigation'
import { useContextMenu } from '@/composables/useContextMenu'
import fixture from '@/__tests__/fixtures/trace/flow-chain.json'
import { roleColor } from '@/utils/graphAppearance'

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
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
    pinInvestigationItem: vi.fn(),
    lookupEnrichment: vi.fn(),
    postInvestigationEvent: vi.fn(async () => ({})),
    setInvestigationAnnotationsStatus: vi.fn(async () => ({ applied: [{ id: 's9' }], skipped: [] })),
    updateInvestigation: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({
      id: 'inv', title: 'Case', status: 'analysis', has_write_access: true, settings: {}, shared_with: [], tags: [], state: {}, ...patch,
    })),
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
let created = 0

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  created = 0
  vi.mocked(api.getInvestigation).mockResolvedValue({ id: 'inv', title: 'Case', status: 'analysis', has_write_access: true, settings: {}, state: {}, shared_with: [], tags: [] } as any)
  vi.mocked(api.getInvestigationItems).mockResolvedValue([item('s1', 'c1'), item('s2', 'c2')] as any)
  vi.mocked(api.getInvestigationAnnotations).mockResolvedValue([])
  vi.mocked(api.getInvestigationItemSnapshot).mockImplementation(async (_i, sid) =>
    (sid === 's1' ? snapshot(['a', 'b']) : snapshot(['x'])) as any,
  )
  vi.mocked(api.getGraphContext).mockImplementation(async (id) => ({ id, title: id, identity_keys: [] }) as any)
  vi.mocked(api.getInvestigationEvents).mockResolvedValue([])
  vi.mocked(api.getInvestigationBrief).mockResolvedValue({ item: null, text: '' })
  vi.mocked(api.createInvestigationItem).mockImplementation(async (_i, body) =>
    ({ id: `n${++created}`, tags: [], ...body, status: 'confirmed', author_kind: 'human', author_email: 'me@x.com', pinned: [], current_version: 1, accessible: true, position: 0, provenance: body.provenance ?? {} }) as any,
  )
})

const stubs = {
  RouterLink: { template: '<a><slot /></a>' },
  GraphCanvas3D: true,
  LayoutPanel: true,
  AddItemsPopover: true,
  FileImportWizard: true,
  CaseSettingsDrawer: true,
  ShareDialog: true,
}

const pixCase = () => {
  vi.mocked(api.getInvestigationItems).mockResolvedValue([item('s1', 'c1')] as any)
  vi.mocked(api.getInvestigationItemSnapshot).mockResolvedValue(pix() as any)
  vi.mocked(api.getGraphContext).mockImplementation(async (id) => ({ id, title: id, identity_keys: [], edge_semantics: fixture.edge_semantics }) as any)
}

describe('InvestigationView', () => {
  it('opens one graph at a time; the legend picks, "All graphs" unifies and the choice is saved in the case (UX-1)', async () => {
    const { getByTestId, queryByTestId } = render(InvestigationView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    const graph = useGraphStore()
    expect(graph.nodes.map((n) => n.node_id).sort()).toEqual(['a@c1', 'b@c1'])
    expect(queryByTestId('unification-summary')).toBeNull()

    graph.positionsResetRequested = false
    await fireEvent.click(getByTestId('legend-item-s2'))
    await flushPromises()
    expect(graph.nodes.map((n) => n.node_id)).toEqual(['x@c2'])
    expect(api.updateInvestigation).toHaveBeenLastCalledWith('inv', { state: { canvas_items: ['s2'] } })
    expect(graph.positionsResetRequested).toBe(true) // another graph: a clean canvas, laid out on its own

    graph.positionsResetRequested = false
    await fireEvent.click(getByTestId('legend-item-s1'), { shiftKey: true })
    await flushPromises()
    expect(graph.nodes.map((n) => n.node_id).sort()).toEqual(['a@c1', 'b@c1', 'x@c2'])
    expect(graph.positionsResetRequested).toBe(false) // Shift adds to what is laid out

    // A graph picked in the material list shows alone too, on a clean canvas.
    await fireEvent.click(getByTestId('item-s2'))
    await flushPromises()
    expect(graph.nodes.map((n) => n.node_id)).toEqual(['x@c2'])
    expect(graph.positionsResetRequested).toBe(true)

    await fireEvent.click(getByTestId('canvas-all'))
    await flushPromises()
    expect(api.updateInvestigation).toHaveBeenLastCalledWith('inv', { state: { canvas_items: 'all' } })
    expect(graph.nodes.map((n) => n.node_id).sort()).toEqual(['a@c1', 'b@c1', 'x@c2'])
    expect(getByTestId('workspace-status').textContent).toContain('2 sources')
    expect(api.getInvestigationItemSnapshot).toHaveBeenCalledTimes(2) // switching graphs never reloads them
  })

  it('a graph item that loads nothing says why, in the legend and the material list', async () => {
    vi.mocked(api.getInvestigationItemSnapshot).mockImplementation(async (_i, sid) =>
      (sid === 's1' ? snapshot(['a']) : { ...snapshot([]), snapshot: null }) as any,
    )
    const { getByTestId } = render(InvestigationView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    expect(getByTestId('legend-item-s2').getAttribute('title')).toContain('No saved graph')
    expect(getByTestId('item-error-s2')).toBeTruthy()
  })

  it('the "on canvas" checkbox removes an item without a reload', async () => {
    vi.mocked(api.getInvestigation).mockResolvedValue({ id: 'inv', title: 'Case', status: 'analysis', has_write_access: true, settings: {}, state: { canvas_items: 'all' }, shared_with: [], tags: [] } as any)
    const { getByTestId } = render(InvestigationView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    const graph = useGraphStore()
    expect(graph.nodes.map((n) => n.node_id).sort()).toEqual(['a@c1', 'b@c1', 'x@c2'])

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
        { id: 's9', kind: 'role', targets: ['a@c1'], value: { role: 'mule' }, status: 'suggested', author_kind: 'agent', author_email: 'me@x.com', reason: 'forwards' },
      ] as any)
      .mockResolvedValue([
        { id: 'r1', kind: 'role', targets: ['a@c1'], value: { role: 'mule' }, status: 'confirmed', author_kind: 'human', author_email: 'me@x.com' },
      ] as any)
    vi.mocked(api.setInvestigationAnnotationStatus).mockResolvedValue({ id: 's9', status: 'confirmed' } as any)
    const { getByTestId, findAllByText } = render(InvestigationView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    const graph = useGraphStore()
    graph.selectNode('a@c1')
    await flushPromises()

    expect(getByTestId('suggestion-s9').textContent).toContain('role: mule')
    await fireEvent.update(getByTestId('inspector-role'), 'mule')
    await flushPromises()
    expect(api.createInvestigationAnnotation).toHaveBeenCalledWith('inv', { kind: 'role', targets: ['a@c1'], value: { role: 'mule' } })
    expect(graph.roleColors?.get('a@c1')).toBe(roleColor('mule'))

    await fireEvent.click(getByTestId('inspector-notes-tab'))
    await fireEvent.update(getByTestId('note-input'), 'KYC mismatch')
    await fireEvent.click(getByTestId('note-add'))
    await flushPromises()
    expect(api.createInvestigationItem).toHaveBeenCalledWith('inv', expect.objectContaining({ kind: 'note', subkind: 'anchored', content: 'KYC mismatch', anchor: { entity_ids: ['a@c1'] } }))
    expect((await findAllByText('KYC mismatch')).length).toBeGreaterThan(0) // inspector and material list
    expect(api.getInvestigationEvents).toHaveBeenCalled()
  })

  it('confirming an agent suggestion calls the confirm route; the suggestions tab confirms in bulk', async () => {
    vi.mocked(api.getInvestigationAnnotations).mockResolvedValue([
      { id: 's9', kind: 'role', targets: ['a@c1'], value: { role: 'mule' }, status: 'suggested', author_kind: 'agent', author_email: 'me@x.com' },
    ] as any)
    vi.mocked(api.setInvestigationAnnotationStatus).mockResolvedValue({ id: 's9', status: 'confirmed' } as any)
    const { getByTestId } = render(InvestigationView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    expect(getByTestId('status-suggestions').textContent).toContain('1 suggestion')
    await fireEvent.click(getByTestId('timeline-tab-suggestions'))
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    await fireEvent.click(getByTestId('suggestions-confirm-role:agent'))
    await flushPromises()
    expect(api.setInvestigationAnnotationsStatus).toHaveBeenCalledWith('inv', ['s9'], 'confirmed') // one request for the group
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

  it('follow the money: the menu action saves a trace item, shows its exits in the strip and lays the canvas by layer', async () => {
    pixCase()
    const { getByTestId, queryByTestId } = render(InvestigationView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    const graph = useGraphStore()
    expect(graph.nodes).toHaveLength(9)

    const action = useContextMenu().actions.value.find((a) => a.id === 'trace-forward')!
    await action.handler({ type: 'node', id: '0001-9@c1', label: '0001-9' })
    await flushPromises()

    expect(api.createInvestigationItem).toHaveBeenCalledWith('inv', expect.objectContaining({ kind: 'table', subkind: 'result', provenance: expect.objectContaining({ tool: 'trace' }) }))
    expect(getByTestId('trace-exits').textContent).toContain('ATM withdrawal')
    expect(getByTestId('trace-coverage').textContent).toContain('(91%)')
    expect(graph.layoutAlgorithm).toBe('trace-layers')
    expect(graph.traceLayers?.labels).toEqual(['Seed', 'Layer 1', 'Layer 2', 'Exits'])
    expect(graph.nodes).toHaveLength(8) // the untraced external bank is left out
    expect(getByTestId('inspector-item-title').textContent).toContain('Trace FIFO')

    await fireEvent.click(getByTestId('trace-view-graph'))
    await flushPromises()
    expect(graph.layoutAlgorithm).toBe('force')
    expect(graph.nodes).toHaveLength(9)
    expect(queryByTestId('trace-exits')).toBeTruthy()

    vi.mocked(api.pinInvestigationItem).mockResolvedValue({ version: 1, sha256: 'ab'.repeat(32) } as any)
    vi.mocked(api.getInvestigationItems).mockResolvedValue([item('s1', 'c1')] as any)
    await fireEvent.click(getByTestId('trace-save-evidence'))
    await flushPromises()
    expect(api.pinInvestigationItem).toHaveBeenCalledWith('inv', 'n1', {})
  })

  it('paths: the popover takes source and target from clicks, the result item highlights the path', async () => {
    pixCase()
    const { getByTestId } = render(InvestigationView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    const graph = useGraphStore()

    const action = useContextMenu().actions.value.find((a) => a.id === 'path-to')!
    expect(action.visible?.({ type: 'edge', id: 'x', label: '' })).toBe(false)
    await action.handler({ type: 'node', id: '0001-9@c1', label: '0001-9' })
    await flushPromises()
    expect(getByTestId('path-source').textContent).toContain('victim')
    expect(getByTestId('path-pick-target').textContent).toContain('click a node')

    graph.selectNode('atm-cash@c1')
    await flushPromises()
    expect(getByTestId('path-target').textContent).toContain('ATM withdrawal')
    await fireEvent.click(getByTestId('path-run'))
    await flushPromises()
    expect(api.createInvestigationItem).toHaveBeenCalledWith('inv', expect.objectContaining({ provenance: expect.objectContaining({ tool: 'paths', params: expect.objectContaining({ mode: 'shortest' }) }) }))
    expect([...graph.selectedNodeIds]).toEqual(['0001-9@c1', '4471-0@c1', '5520-3@c1', 'atm-cash@c1'])
    expect(graph.selectedEdgeIds.size).toBe(3)
    expect(getByTestId('path-result').textContent).toContain('3 hops')
  })

  it('groups: a closed group from the selection collapses into a cluster node and reloading keeps it', async () => {
    vi.mocked(api.getInvestigationAnnotations).mockResolvedValue([
      { id: 'g1', kind: 'group', targets: ['a@c1', 'b@c1'], value: { name: 'Dupla', color: 1 }, status: 'confirmed', author_kind: 'human', author_email: 'me@x.com' },
    ] as any)
    vi.mocked(api.getInvestigation).mockResolvedValue({ id: 'inv', title: 'Case', status: 'analysis', has_write_access: true, settings: {}, state: { groups_closed: ['g1'], canvas_items: 'all' }, shared_with: [], tags: [] } as any)
    const { getByTestId } = render(InvestigationView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    const graph = useGraphStore()
    const store = useInvestigationStore()
    expect(store.groups.map((g) => g.name)).toEqual(['Dupla'])
    expect(getByTestId('status-groups').textContent).toContain('1 group')
    // enhancedNodes: the two members collapse into one cluster node beside x@c2
    expect(graph.enhancedNodes.map((n) => n.node_id).sort()).toEqual(['group:g1', 'x@c2'])
    expect(getByTestId('chip-groups').textContent).toContain('group')
  })
})
