import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import CaseFilterChips from '@/components/investigation/CaseFilterChips.vue'
import { useInvestigationStore } from '@/stores/investigation'
import { useGraphStore } from '@/stores/graph'
import { useCaseFilters } from '@/stores/caseFilters'

const api = vi.hoisted(() => ({
  createInvestigationItem: vi.fn(async (_id: string, body: any) => ({ id: 'view-1', pinned: [], current_version: 1, tags: [], accessible: true, position: 0, status: 'confirmed', author_kind: 'human', author_email: 'me', ...body })),
  getInvestigationEvents: vi.fn(async () => []),
  postInvestigationEvent: vi.fn(async () => ({})),
}))
vi.mock('@/services/api', () => ({ api }))

const node = (id: string, type: string, props: Record<string, unknown> = {}) => ({ node_id: id, node_type: type, properties: props })

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  const inv = useInvestigationStore()
  inv.current = { id: 'inv-1', status: 'analysis', has_write_access: true, settings: {}, state: { canvas_items: 'all' }, kind_preset: 'livre' } as any
  inv.items = [
    { id: 's1', kind: 'graph', subkind: 'exploration_ref', title: 'Pix', tags: [], status: 'confirmed', accessible: true, current_version: 0, pinned: [], provenance: {} },
    { id: 's2', kind: 'graph', subkind: 'exploration_ref', title: 'KYC', tags: [], status: 'confirmed', accessible: true, current_version: 0, pinned: [], provenance: {} },
  ] as any
  inv.contexts = { c1: { id: 'c1', identity_keys: [] }, c2: { id: 'c2', identity_keys: [] } } as any
  inv.sourceGraphs = [
    { id: 's1', contextId: 'c1', nodes: [node('a', 'Pessoa'), node('b', 'Conta')], edges: [{ edge_id: 'e1', src: 'a', dst: 'b', relationship_type: 'OWNS', properties: { quando: '2024-03-15T10:00:00' } }], state: null, error: null },
    { id: 's2', contextId: 'c2', nodes: [node('c', 'Pessoa')], edges: [], state: null, error: null },
  ] as any
  inv.annotations = [
    { id: 'r1', kind: 'role', targets: ['a@c1'], value: { role: 'mula' }, status: 'confirmed', author_kind: 'human', author_email: 'me' },
    { id: 't1', kind: 'tag', targets: ['c@c2'], value: { tag: 'kyc' }, status: 'confirmed', author_kind: 'human', author_email: 'me' },
    { id: 'g1', kind: 'group', targets: ['a@c1', 'c@c2'], value: { name: 'Dupla' }, status: 'confirmed', author_kind: 'human', author_email: 'me' },
  ] as any
})

describe('CaseFilterChips (05 §3)', () => {
  it('chips hide nodes visually (no layout reset) and clear together', async () => {
    const graph = useGraphStore()
    const filters = useCaseFilters()
    const { getByTestId } = render(CaseFilterChips, { props: { canEdit: true } })
    expect(graph.caseHiddenNodeIds).toBeNull()

    await fireEvent.click(getByTestId('chip-sources'))
    await fireEvent.click(getByTestId('chip-opt-sources-s1'))
    await flushPromises()
    expect([...graph.caseHiddenNodeIds!]).toEqual(['c@c2'])
    expect(getByTestId('chip-sources').textContent).toContain('source: Pix')

    await fireEvent.click(getByTestId('chip-roles'))
    await fireEvent.click(getByTestId('chip-opt-roles-mula'))
    await flushPromises()
    expect([...graph.caseHiddenNodeIds!].sort()).toEqual(['b@c1', 'c@c2'])

    filters.clear()
    await flushPromises()
    await fireEvent.click(getByTestId('chip-tags'))
    await fireEvent.click(getByTestId('chip-opt-tags-kyc'))
    await flushPromises()
    expect([...graph.caseHiddenNodeIds!].sort()).toEqual(['a@c1', 'b@c1'])

    filters.clear()
    await fireEvent.click(getByTestId('chip-groups'))
    await fireEvent.click(getByTestId('chip-opt-groups-g1'))
    await flushPromises()
    expect([...graph.caseHiddenNodeIds!]).toEqual(['b@c1'])

    await fireEvent.click(getByTestId('chips-clear'))
    await flushPromises()
    expect(graph.caseHiddenNodeIds).toBeNull()
    expect(graph.nodes).toHaveLength(0) // the chips never touch the graph store's data
  })

  it('the time window hides entities whose dated edges fall outside; undated ones stay; 👁 is journaled', async () => {
    const inv = useInvestigationStore()
    inv.current!.settings = { edge_semantics: { OWNS: { timestamp_prop: 'quando' } } }
    const filters = useCaseFilters()
    const graph = useGraphStore()
    const { getByTestId } = render(CaseFilterChips, { props: { canEdit: true } })
    filters.window = [Date.parse('2024-03-16T00:00:00'), Date.parse('2024-03-17T00:00:00')]
    await flushPromises()
    expect([...graph.caseHiddenNodeIds!].sort()).toEqual(['a@c1', 'b@c1'])
    expect(getByTestId('chip-window').textContent).toContain('⏱')
    await fireEvent.click(getByTestId('chip-window'))
    await flushPromises()
    expect(graph.caseHiddenNodeIds).toBeNull()
  })

  it('saves the chips, the layout and the closed groups as a graph/view item and applies one back', async () => {
    const filters = useCaseFilters()
    const inv = useInvestigationStore()
    const graph = useGraphStore()
    filters.toggle('roles', 'mula')
    graph.applyFilters({ node_types: ['Pessoa'] })
    const { getByTestId, emitted } = render(CaseFilterChips, { props: { canEdit: true } })
    await fireEvent.click(getByTestId('chip-views'))
    await fireEvent.update(getByTestId('view-name'), 'Mulas')
    await fireEvent.click(getByTestId('view-save'))
    await flushPromises()
    expect(api.createInvestigationItem).toHaveBeenCalledWith('inv-1', expect.objectContaining({
      kind: 'graph', subkind: 'view', title: 'Mulas',
      content_json: { filters: { sources: [], roles: ['mula'], tags: [], groups: [], types: ['Pessoa'], window: null }, layout: 'force', groups_closed: [], canvas_items: 'all' },
    }))
    expect(inv.views.map((v) => v.title)).toEqual(['Mulas'])

    filters.clear()
    await flushPromises()
    expect(filters.roles).toEqual([])
    await fireEvent.click(getByTestId('chip-views'))
    await fireEvent.click(getByTestId('view-apply-view-1'))
    await flushPromises()
    expect(filters.roles).toEqual(['mula'])
    expect(graph.filters.node_types).toEqual(['Pessoa'])
    expect(emitted('apply-view')).toBeTruthy()
  })
})
