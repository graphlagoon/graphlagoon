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
})

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
})
