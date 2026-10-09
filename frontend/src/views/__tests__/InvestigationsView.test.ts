import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import InvestigationsView from '@/views/InvestigationsView.vue'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/services/api', () => ({
  api: { getInvestigations: vi.fn() },
}))

import { api } from '@/services/api'

const now = new Date().toISOString()
const CASES = [
  { id: 'aaaaaaaa-1', title: 'Golpe Pix', status: 'analise', typology: 'Golpe Pix', owner_email: 'me@x.com', assignee_email: 'ana@x.com', created_at: now, updated_at: now, source_count: 2 },
  { id: 'bbbbbbbb-2', title: 'Old case', status: 'arquivado', owner_email: 'me@x.com', created_at: now, updated_at: now, source_count: 1 },
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
  it('lists open cases with status, assignee, sources and deadline', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true }
    const { getByTestId, queryByTestId } = await renderView()
    const row = getByTestId('investigation-row-aaaaaaaa-1')
    expect(row.textContent).toContain('In analysis')
    expect(row.textContent).toContain('ana@x.com')
    expect(row.textContent).toContain('2 sources')
    expect(row.textContent).toContain('analysis · 45 d left')
    // Archived cases are outside the default "Open" filter.
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
