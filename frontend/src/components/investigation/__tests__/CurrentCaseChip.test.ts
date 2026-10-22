import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import CurrentCaseChip from '@/components/investigation/CurrentCaseChip.vue'

const push = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push }), useRoute: () => ({ name: 'graph', params: {}, query: {} }) }))
const api = vi.hoisted(() => ({
  getInvestigationPage: vi.fn(async () => ({ items: [{ id: 'abcd1234', title: 'Mule network', status: 'analysis' }, { id: 'ffff', title: 'Closed one', status: 'closed' }], total: 2, counts: {} })),
  createInvestigation: vi.fn(),
  getInvestigation: vi.fn(async () => ({ id: 'x', title: 'x' })),
}))
vi.mock('@/services/api', () => ({ api }))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.useFakeTimers()
  window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, permissions: ['investigation.create'] } as any
})

describe('CurrentCaseChip (UX-1)', () => {
  it('searches on the server (open cases only) instead of downloading the queue, and says when it fails', async () => {
    const { getByTestId, queryByTestId } = render(CurrentCaseChip)
    await fireEvent.click(getByTestId('current-case-chip'))
    expect(api.getInvestigationPage).not.toHaveBeenCalled()
    await fireEvent.update(getByTestId('current-case-search'), '#abcd')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(api.getInvestigationPage).toHaveBeenCalledWith({ q: 'abcd', status: 'open,analysis', limit: 20 })
    expect(getByTestId('current-case-pick-abcd1234')).toBeTruthy()
    expect(queryByTestId('current-case-pick-ffff')).toBeNull()

    api.getInvestigationPage.mockRejectedValueOnce(new Error('down'))
    await fireEvent.update(getByTestId('current-case-search'), 'zzz')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(getByTestId('current-case-search-error')).toBeTruthy()
  })

  it('offers the full new-case form, with the type and its fields', async () => {
    const { getByTestId } = render(CurrentCaseChip)
    await fireEvent.click(getByTestId('current-case-chip'))
    await fireEvent.click(getByTestId('current-case-new-full'))
    expect(push).toHaveBeenCalledWith({ path: '/investigations', query: { new: '1' } })
  })
})
