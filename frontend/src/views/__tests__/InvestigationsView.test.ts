import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import InvestigationsView from '@/views/InvestigationsView.vue'

const push = vi.fn()
const replace = vi.fn()
const routeQuery: { value: Record<string, string> } = { value: {} }
vi.mock('vue-router', () => ({ useRouter: () => ({ push, replace }), useRoute: () => ({ query: routeQuery.value }) }))
vi.mock('@/services/api', () => ({
  api: { getInvestigationPage: vi.fn(), getCaseTypes: vi.fn(), createInvestigation: vi.fn(), getTasks: vi.fn(async () => []) },
}))

import { api } from '@/services/api'

const now = new Date().toISOString()
const deadline = (hours_left: number, total_hours: number, phase = 'analysis') => ({
  phase, due_at: now, hours_left, days_left: Math.ceil(hours_left / 24), total_hours, urgent: hours_left <= total_hours * 0.2, overdue: hours_left < 0,
})
const MERCHANT = {
  slug: 'merchant_review', label: 'Merchant review', builtin: false, outcomes: [], actions: [], stages: [], vocabularies: { roles: [], tags: [], link_attributes: [] },
  sla_hours: {}, roles_multi: false, starter_queries: [], report_templates: [],
  fields: [
    { id: 'merchant_id', label: 'Merchant', type: 'text', options: [], required: true, in_queue: true },
    { id: 'amount_at_risk', label: 'Amount at risk', type: 'money', options: [], required: false, in_queue: true },
    { id: 'mcc', label: 'MCC', type: 'enum', options: ['5411', '5999'], required: false, in_queue: false },
  ],
}
const GENERAL = { ...MERCHANT, slug: 'general', label: 'General', builtin: true, fields: [] }
const CASES = [
  { id: 'aaaaaaaa-1', title: 'Mule network', status: 'analysis', case_type: 'merchant_review', fields: { merchant_id: 'M-1', amount_at_risk: 84000 }, tags: [], owner_email: 'me@x.com', assignee_email: 'ana@x.com', created_at: now, updated_at: now, item_count: 2, suggested_count: 1, has_write_access: true, deadline: deadline(1080, 2160) },
  { id: 'cccccccc-3', title: 'Urgent', status: 'open', case_type: 'general', fields: {}, tags: [], owner_email: 'me@x.com', created_at: now, updated_at: now, item_count: 0, has_write_access: true, deadline: deadline(10, 240, 'open') },
  { id: 'dddddddd-4', title: 'Lent to me', status: 'analysis', case_type: 'general', fields: {}, tags: [], owner_email: 'zoe@x.com', assignee_email: 'zoe@x.com', created_at: now, updated_at: now, item_count: 3, has_write_access: false },
]
const page = (items = CASES, total = items.length) => ({ items, total, limit: 50, offset: 0, counts: { open: 1, analysis: 2, closed: 4, total: 7, urgent: 1, overdue: 0, suggested: 1 } })

async function renderView() {
  const view = render(InvestigationsView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
  for (let i = 0; i < 6; i++) await Promise.resolve()
  return view
}
/** The params of the last page the view asked for (after the 250 ms debounce). */
async function lastQuery() {
  await vi.advanceTimersByTimeAsync(300)
  return vi.mocked(api.getInvestigationPage).mock.calls.at(-1)![0]!
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.useRealTimers()
  routeQuery.value = {}
  vi.mocked(api.getInvestigationPage).mockResolvedValue(page() as any)
  vi.mocked(api.getCaseTypes).mockResolvedValue([GENERAL, MERCHANT] as any)
})

describe('InvestigationsView', () => {
  it('lists a page of cases with type, status, assignee, material, deadline; the counters come from the server', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true }
    const { getByTestId } = await renderView()
    expect(api.getInvestigationPage).toHaveBeenCalledWith(expect.objectContaining({ status: 'open,analysis', sort: '-updated_at', limit: 50, offset: 0 }))
    const row = getByTestId('investigation-row-aaaaaaaa-1')
    expect(row.querySelector('[data-testid="row-type"]')!.textContent).toBe('Merchant review')
    expect(row.textContent).toContain('In analysis')
    expect(row.textContent).toContain('ana@x.com')
    expect(row.textContent).toContain('2 items')
    expect(row.textContent).toContain('1 suggestion')
    expect(row.textContent).toContain('analysis · 45 d')
    // The server decides what is urgent (under 20% of the SLA left).
    const urgent = getByTestId('investigation-row-cccccccc-3')
    expect(urgent.querySelector('[data-testid="deadline"]')!.classList).toContain('late')
    expect(urgent.textContent).toContain('open · 10 h')
    expect(row.querySelector('[data-testid="deadline"]')!.classList).not.toContain('late')
    expect(getByTestId('counter-urgent').textContent).toContain('1')
    expect(getByTestId('counter-closed').textContent).toContain('4')
  })

  it('sends filters, sort and counters to the server; a type shows its queue fields as columns and filters', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true }
    localStorage.setItem('userEmail', 'me@x.com')
    const { getByTestId, queryByTestId } = await renderView()
    vi.useFakeTimers()
    expect(getByTestId('investigation-row-dddddddd-4').querySelector('[data-testid="access-mark"]')!.textContent).toContain('read only')
    expect(getByTestId('investigation-row-aaaaaaaa-1').querySelector('[data-testid="access-mark"]')).toBeNull()

    await fireEvent.update(getByTestId('investigations-type'), 'merchant_review')
    expect(await lastQuery()).toMatchObject({ case_type: 'merchant_review', offset: 0 })
    expect(getByTestId('investigation-row-aaaaaaaa-1').querySelector('[data-testid="row-field-amount_at_risk"]')!.textContent).toContain('84,000.00')
    await fireEvent.update(getByTestId('queue-field-amount_at_risk'), '100000')
    expect((await lastQuery()).fields).toEqual({ amount_at_risk: 'gte:100000' })
    await fireEvent.update(getByTestId('queue-field-merchant_id'), 'M-1')
    expect((await lastQuery()).fields).toEqual({ amount_at_risk: 'gte:100000', merchant_id: 'contains:M-1' })
    expect(queryByTestId('queue-field-mcc')).toBeNull() // not a queue field
    await fireEvent.click(getByTestId('sort-field-amount_at_risk'))
    expect((await lastQuery()).sort).toBe('-field.amount_at_risk')

    await fireEvent.update(getByTestId('investigations-assignee'), 'me')
    expect((await lastQuery()).assignee).toBe('me@x.com')
    await fireEvent.click(getByTestId('counter-urgent'))
    expect(await lastQuery()).toMatchObject({ deadline: 'urgent', status: undefined })
    await fireEvent.click(getByTestId('counter-urgent')) // again: back to "In progress"
    expect(await lastQuery()).toMatchObject({ status: 'open,analysis', deadline: undefined })
    await fireEvent.click(getByTestId('counter-suggested'))
    expect((await lastQuery()).suggested).toBe(true)
    await fireEvent.update(getByTestId('investigations-search'), 'mule')
    expect((await lastQuery()).q).toBe('mule')
    vi.useRealTimers()
  })

  it('pages through the queue', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true }
    vi.mocked(api.getInvestigationPage).mockResolvedValue(page(CASES, 120) as any)
    const { getByTestId } = await renderView()
    expect(getByTestId('queue-range').textContent).toBe('1–50 of 120')
    vi.useFakeTimers()
    await fireEvent.click(getByTestId('queue-next'))
    expect((await lastQuery()).offset).toBe(50)
    vi.useRealTimers()
  })

  it('creates a case of a type with its required fields', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, permissions: ['investigation.create'] }
    vi.mocked(api.createInvestigation).mockResolvedValue({ ...CASES[0], id: 'new-1' } as any)
    const { getByTestId } = await renderView()
    await fireEvent.click(getByTestId('new-investigation-btn'))
    await fireEvent.update(getByTestId('new-investigation-title'), 'Merchant 77')
    await fireEvent.update(getByTestId('new-investigation-type'), 'merchant_review')
    const submit = getByTestId('new-investigation-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true) // the merchant is required
    await fireEvent.update(getByTestId('new-field-merchant_id'), 'M-77')
    await fireEvent.update(getByTestId('new-field-mcc'), '5999')
    expect(submit.disabled).toBe(false)
    await fireEvent.click(submit)
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(api.createInvestigation).toHaveBeenCalledWith({ title: 'Merchant 77', case_type: 'merchant_review', fields: { merchant_id: 'M-77', mcc: '5999' }, assignee_email: undefined })
    expect(push).toHaveBeenCalledWith('/investigations/new-1')
  })

  it('hides "New investigation" without investigation.create', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, permissions: [] }
    const { queryByTestId } = await renderView()
    expect(queryByTestId('new-investigation-btn')).toBeNull()

    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, permissions: ['investigation.create'] }
    const again = await renderView()
    expect(again.container.querySelector('[data-testid="new-investigation-btn"]')).not.toBeNull()
  })

  it('keeps filters, sort and page in the URL and reads them back (Back returns to the same list)', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true }
    routeQuery.value = { q: 'mule', status: 'all', scope: 'shared', sort: 'status', page: '2' }
    const first = await renderView()
    expect(api.getInvestigationPage).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'mule', scope: 'shared', sort: 'status', offset: 50 }))
    expect(vi.mocked(api.getInvestigationPage).mock.calls.at(-1)![0]!.status).toBeUndefined()

    first.unmount()
    vi.useFakeTimers()
    routeQuery.value = {}
    const { getByTestId } = await renderView()
    await fireEvent.update(getByTestId('investigations-scope'), 'owned')
    await fireEvent.click(getByTestId('sort-assignee'))
    expect((await lastQuery())).toMatchObject({ scope: 'owned', sort: 'assignee' })
    expect(replace).toHaveBeenLastCalledWith({ query: { scope: 'owned', sort: 'assignee' } })
  })

  it('a filter with no match offers to clear the filters; a failed load offers Retry', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true }
    vi.useFakeTimers()
    vi.mocked(api.getInvestigationPage).mockResolvedValue({ ...page([], 0), counts: { total: 0 } } as any)
    const { getByTestId, queryByTestId } = await renderView()
    expect(getByTestId('investigations-empty')).toBeTruthy() // no filter: the "no cases" state
    await fireEvent.update(getByTestId('investigations-search'), 'zzz')
    await lastQuery()
    expect(queryByTestId('investigations-empty')).toBeNull()
    await fireEvent.click(getByTestId('investigations-clear'))
    expect((await lastQuery()).q).toBeUndefined()

    vi.mocked(api.getInvestigationPage).mockRejectedValueOnce(new Error('boom'))
    await fireEvent.update(getByTestId('investigations-search'), 'x')
    await lastQuery()
    expect(getByTestId('investigations-error')).toBeTruthy()
    vi.mocked(api.getInvestigationPage).mockResolvedValue(page() as any)
    await fireEvent.click(getByTestId('investigations-retry'))
    await vi.advanceTimersByTimeAsync(10)
    expect(queryByTestId('investigations-error')).toBeNull()
  })

  it('"My tasks" lists the open tasks on me across cases; ?new=1 opens the new-case form', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, permissions: ['investigation.create'] }
    vi.mocked(api.getTasks).mockResolvedValue([
      { id: 't1', investigation_id: 'aaaaaaaa-1', case_title: 'Mule network', value: { title: 'Pull statements', due_at: null }, overdue: false },
    ] as any)
    const { getByTestId, unmount } = await renderView()
    await fireEvent.click(getByTestId('queue-tab-tasks'))
    await flushPromises()
    expect(api.getTasks).toHaveBeenCalledWith({ mine: true, state: 'open' })
    expect(getByTestId('my-task-t1').textContent).toContain('Pull statements')
    expect(getByTestId('my-task-t1').textContent).toContain('Mule network')

    unmount()
    routeQuery.value = { new: '1' }
    const second = await renderView()
    expect(second.getByTestId('new-investigation-title')).toBeTruthy()
  })
})
