import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import InvestigationsView from '@/views/InvestigationsView.vue'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/services/api', () => ({
  api: { getInvestigations: vi.fn() },
}))

import { api } from '@/services/api'

const now = new Date().toISOString()
const CASES = [
  { id: 'aaaaaaaa-1', title: 'Golpe Pix', status: 'analysis', kind_preset: 'pix_med', tags: [], owner_email: 'me@x.com', assignee_email: 'ana@x.com', created_at: now, updated_at: now, item_count: 2, suggested_count: 1, has_write_access: true, deadline: { phase: 'analysis', due_at: now, days_left: 45 } },
  { id: 'cccccccc-3', title: 'Urgent', status: 'open', kind_preset: 'pix_med', tags: [], owner_email: 'me@x.com', created_at: now, updated_at: now, item_count: 0, has_write_access: true, deadline: { phase: 'open', due_at: now, days_left: 6 } },
  { id: 'bbbbbbbb-2', title: 'Old case', status: 'archived', kind_preset: 'livre', tags: [], owner_email: 'me@x.com', created_at: now, updated_at: now, item_count: 1, has_write_access: true },
  { id: 'dddddddd-4', title: 'Lent to me', status: 'analysis', kind_preset: 'lavagem', tags: [], owner_email: 'zoe@x.com', assignee_email: 'zoe@x.com', created_at: now, updated_at: now, item_count: 3, has_write_access: false, deadline: { phase: 'analysis', due_at: now, days_left: 20 } },
]

async function renderView() {
  const view = render(InvestigationsView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
  for (let i = 0; i < 5; i++) await Promise.resolve()
  return view
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(api.getInvestigations).mockResolvedValue(CASES as any)
})

describe('InvestigationsView', () => {
  it('lists open cases with status, assignee, material and deadline', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true }
    const { getByTestId, queryByTestId } = await renderView()
    const row = getByTestId('investigation-row-aaaaaaaa-1')
    expect(row.textContent).toContain('In analysis')
    expect(row.textContent).toContain('ana@x.com')
    expect(row.textContent).toContain('2 items')
    expect(row.textContent).toContain('1 suggested')
    expect(row.textContent).toContain('analysis · 45 d left')
    // F4.4: the server's deadline; under 7 days it turns orange and counts as urgent.
    const urgent = getByTestId('investigation-row-cccccccc-3')
    expect(urgent.querySelector('[data-testid="deadline"]')!.classList).toContain('late')
    expect(row.querySelector('[data-testid="deadline"]')!.classList).not.toContain('late')
    expect(getByTestId('counter-urgent').textContent).toContain('1')
    // Archived cases are outside the default "Open" filter.
    expect(queryByTestId('investigation-row-bbbbbbbb-2')).toBeNull()
  })

  it('filters by type and assignee, sorts by a column, marks read-only cases and uses counters as filters', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true }
    localStorage.setItem('userEmail', 'me@x.com')
    const { getByTestId, queryByTestId, container } = await renderView()
    const ids = () => [...container.querySelectorAll('tbody tr')].map((r) => r.getAttribute('data-testid'))
    expect(getByTestId('investigation-row-dddddddd-4').querySelector('[data-testid="access-mark"]')!.textContent).toContain('read-only')
    expect(getByTestId('investigation-row-aaaaaaaa-1').querySelector('[data-testid="access-mark"]')).toBeNull()

    await fireEvent.update(getByTestId('investigations-preset'), 'lavagem')
    expect(ids()).toEqual(['investigation-row-dddddddd-4'])
    await fireEvent.update(getByTestId('investigations-preset'), '')
    await fireEvent.update(getByTestId('investigations-assignee'), 'ana@x.com')
    expect(ids()).toEqual(['investigation-row-aaaaaaaa-1'])
    await fireEvent.update(getByTestId('investigations-assignee'), '')

    await fireEvent.click(getByTestId('sort-deadline'))
    expect(ids()).toEqual(['investigation-row-cccccccc-3', 'investigation-row-dddddddd-4', 'investigation-row-aaaaaaaa-1'])
    await fireEvent.click(getByTestId('sort-deadline'))
    expect(ids()[0]).toBe('investigation-row-aaaaaaaa-1')

    await fireEvent.click(getByTestId('counter-urgent'))
    expect(ids()).toEqual(['investigation-row-cccccccc-3'])
    await fireEvent.click(getByTestId('counter-urgent')) // again: back to "Open"
    expect(ids()).toHaveLength(3)
    await fireEvent.click(getByTestId('counter-decided'))
    expect(ids()).toEqual([])
    expect(queryByTestId('investigation-row-bbbbbbbb-2')).toBeNull()
  })

  it('hides "New investigation" without investigation.create', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, permissions: [] }
    const { queryByTestId } = await renderView()
    expect(queryByTestId('new-investigation-btn')).toBeNull()

    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, permissions: ['investigation.create'] }
    const again = await renderView()
    expect(again.container.querySelector('[data-testid="new-investigation-btn"]')).not.toBeNull()
  })
})
