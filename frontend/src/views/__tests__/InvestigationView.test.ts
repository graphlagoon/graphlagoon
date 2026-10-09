import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import InvestigationView from '@/views/InvestigationView.vue'
import { useGraphStore } from '@/stores/graph'
import { useCommunityStore } from '@/stores/community'

vi.mock('@/services/api', () => ({
  api: {
    getInvestigation: vi.fn(),
    getInvestigationSources: vi.fn(),
    getInvestigationSourceSnapshot: vi.fn(),
    getGraphContext: vi.fn(),
    getInvestigationNotes: vi.fn(),
    getInvestigationEvents: vi.fn(),
    updateInvestigationState: vi.fn(),
    createInvestigationNote: vi.fn(),
    getInvestigationArtifacts: vi.fn(async () => []),
    getInvestigationProposals: vi.fn(async () => []),
  },
}))
vi.mock('@/components/GraphCanvas3D.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/LayoutPanel.vue', () => ({ default: { render: () => null } }))
vi.mock('@/services/metricsCalculator', () => ({ resetMetricsCalculator: vi.fn() }))

import { api } from '@/services/api'

const source = (id: string, contextId: string) => ({
  id, kind: 'exploration', position: 0, title_snapshot: id, accessible: true,
  exploration_id: `e-${id}`, context_id: contextId, mode: 'live',
})
const snapshot = (ids: string[]) => ({
  exploration: { state: {} },
  snapshot: { nodes: ids.map((id) => ({ id, type: 'T', properties: {} })), edges: [] },
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(api.getInvestigation).mockResolvedValue({ id: 'inv', title: 'Case', status: 'analise', has_write_access: true } as any)
  vi.mocked(api.getInvestigationSources).mockResolvedValue([source('s1', 'c1'), source('s2', 'c2')] as any)
  vi.mocked(api.getInvestigationSourceSnapshot).mockImplementation(async (_i, sid) =>
    (sid === 's1' ? snapshot(['a', 'b']) : snapshot(['x'])) as any,
  )
  vi.mocked(api.getGraphContext).mockImplementation(async (id) => ({ id, title: id, identity_keys: [] }) as any)
  vi.mocked(api.getInvestigationNotes).mockResolvedValue([])
  vi.mocked(api.getInvestigationEvents).mockResolvedValue([])
})

const stubs = {
  RouterLink: { template: '<a><slot /></a>' },
  GraphCanvas3D: true,
  LayoutPanel: true,
  AddToInvestigationModal: true,
}

describe('InvestigationView', () => {
  it('keeps the unified view communities across tab switches', async () => {
    const { getByTestId } = render(InvestigationView, {
      props: { id: 'inv' },
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          GraphCanvas3D: true,
          LayoutPanel: true,
          AddToInvestigationModal: true,
        },
      },
    })
    await flushPromises()
    const graph = useGraphStore()
    const community = useCommunityStore()
    expect(graph.nodes.map((n) => n.node_id).sort()).toEqual(['a@c1', 'b@c1', 'x@c2'])

    community.loadState({ communityMap: { 'a@c1': 0, 'b@c1': 0, 'x@c2': 1 }, communityCount: 2 })
    await fireEvent.click(getByTestId('tab-s2'))
    await flushPromises()
    expect(graph.nodes.map((n) => n.node_id)).toEqual(['x@c2'])

    await fireEvent.click(getByTestId('tab-unified'))
    await flushPromises()
    expect(graph.nodes).toHaveLength(3)
    expect(community.communityCount).toBe(2)
    expect(community.communityMap.get('x@c2')).toBe(1)
  })

  it('sets a role (node fill) and adds a note from the inspector', async () => {
    vi.mocked(api.updateInvestigationState).mockResolvedValue({
      id: 'inv', title: 'Case', status: 'analise', has_write_access: true, state: { roles: { 'a@c1': 'victim' } },
    } as any)
    vi.mocked(api.createInvestigationNote).mockImplementation(async (_i, anchor, body) =>
      ({ id: 'n1', anchor, body, author_email: 'me@x.com' }) as any,
    )
    const { getByTestId, findByText } = render(InvestigationView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    const graph = useGraphStore()
    graph.selectNode('a@c1')
    await flushPromises()

    await fireEvent.update(getByTestId('inspector-role'), 'victim')
    await flushPromises()
    expect(api.updateInvestigationState).toHaveBeenCalledWith('inv', { roles: { 'a@c1': 'victim' } })
    expect(graph.roleColors?.get('a@c1')).toBe('#2563eb')

    await fireEvent.click(getByTestId('inspector-notes-tab'))
    await fireEvent.update(getByTestId('note-input'), 'KYC mismatch')
    await fireEvent.click(getByTestId('note-add'))
    await flushPromises()
    expect(api.createInvestigationNote).toHaveBeenCalledWith('inv', { kind: 'node', id: 'a@c1' }, 'KYC mismatch')
    expect(await findByText('KYC mismatch')).toBeTruthy()
    expect(api.getInvestigationEvents).toHaveBeenCalled()
  })
})
