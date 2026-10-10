import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import AddToInvestigationModal from '@/components/investigation/AddToInvestigationModal.vue'

vi.mock('@/services/api', () => ({
  api: {
    getAllExplorations: vi.fn(),
    getExploration: vi.fn(),
    getInvestigationSources: vi.fn(async () => []),
    getGraphContexts: vi.fn(async () => []),
  },
}))
vi.mock('@/stores/contexts', () => ({
  useContextsStore: () => ({ contexts: [{ id: 'c1', title: 'Pix', identity_keys: [] }], fetchContexts: vi.fn(async () => {}) }),
}))

import { api } from '@/services/api'

const exp = (id: string, title: string, node_count: number | null, updated_at: string) => ({
  id, title, graph_context_id: 'c1', owner_email: 'me@x.com', shared_with: [], has_write_access: true, state: {},
  created_at: updated_at, updated_at, node_count,
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.mocked(api.getAllExplorations).mockResolvedValue([
    exp('old', 'Old mules', 12, '2026-09-01T10:00:00Z'),
    exp('empty', 'Nothing saved', 0, '2026-10-01T10:00:00Z'),
    exp('new', 'Fresh trace', 40, '2026-10-09T10:00:00Z'),
  ] as any)
})

describe('AddToInvestigationModal', () => {
  it('opens on "my recent": owner = me, newest first, node counts, empty rows disabled', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true }
    const { getByTestId, queryByTestId, container } = render(AddToInvestigationModal, {
      props: { open: true, investigationId: 'inv-1' },
    })
    await flushPromises()
    expect(api.getAllExplorations).toHaveBeenCalledWith({ q: undefined, mine: true, limit: 50 })
    expect(getByTestId('add-scope-mine').classList).toContain('on')
    expect(queryByTestId('add-scope-all')).toBeNull() // superusers only
    const rows = [...container.querySelectorAll('[data-testid^="add-exp-"]')].map((r) => r.getAttribute('data-testid'))
    expect(rows).toEqual(['add-exp-new', 'add-exp-empty', 'add-exp-old'])
    expect(getByTestId('add-exp-new').textContent).toContain('40 nodes')
    expect((getByTestId('add-exp-empty').querySelector('input') as HTMLInputElement).disabled).toBe(true)
    expect(getByTestId('add-exp-empty').textContent).toContain('empty')

    await fireEvent.update(getByTestId('add-search'), 'trace')
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(api.getAllExplorations).toHaveBeenLastCalledWith({ q: 'trace', mine: true, limit: 50 })
  })

  it('offers "all contexts" to superusers and reloads with mine=false', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, is_superuser: true }
    const { getByTestId } = render(AddToInvestigationModal, { props: { open: true, investigationId: 'inv-1' } })
    await flushPromises()
    await fireEvent.click(getByTestId('add-scope-all'))
    await flushPromises()
    expect(api.getAllExplorations).toHaveBeenLastCalledWith({ q: undefined, mine: false, limit: 50 })
  })
})
