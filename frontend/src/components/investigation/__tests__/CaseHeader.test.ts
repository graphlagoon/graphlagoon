import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import CaseHeader from '@/components/investigation/CaseHeader.vue'
import ShareDialog from '@/components/investigation/ShareDialog.vue'
import { useInvestigationStore } from '@/stores/investigation'

const push = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/services/api', () => ({
  api: {
    updateInvestigation: vi.fn(),
    reopenInvestigation: vi.fn(),
    deleteInvestigation: vi.fn(async () => {}),
    shareInvestigation: vi.fn(async () => {}),
    unshareInvestigation: vi.fn(async () => {}),
    getInvestigationEvents: vi.fn(async () => []),
    recordInvestigationDecision: vi.fn(),
    getInvestigationItems: vi.fn(async () => []),
  },
}))

import { api } from '@/services/api'

const now = new Date().toISOString()
const CASE = {
  id: '0412aaaa-1111-2222-3333-444444444444',
  title: 'Golpe Pix',
  description: null,
  status: 'open',
  case_type: 'general',
  fields: {},
  tags: [],
  settings: {},
  owner_email: 'me@x.com',
  assignee_email: 'ana@x.com',
  state: {},
  shared_with: [{ email: 'bob@x.com', role: 'reader' }],
  has_write_access: true,
  can_manage: true,
  created_at: now,
  updated_at: now,
  deadline: { phase: 'open', due_at: now, hours_left: 120, days_left: 5, total_hours: 1080, urgent: true, overdue: false },
}

const stubs = { RouterLink: { template: '<a><slot /></a>' } }

function mount(overrides: Record<string, unknown> = {}) {
  const store = useInvestigationStore()
  store.current = { ...CASE, ...overrides } as any
  return render(CaseHeader, { global: { stubs } })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('CaseHeader', () => {
  it('renames inline, lists only the allowed transitions and patches the status', async () => {
    vi.mocked(api.updateInvestigation).mockImplementation(async (_id, patch) => ({ ...CASE, ...patch }) as any)
    const { getByTestId, queryByTestId } = mount()
    expect(getByTestId('case-header').textContent).toContain('#0412aa')
    expect(getByTestId('workspace-deadline').classList).toContain('urgent')

    await fireEvent.click(getByTestId('investigation-title'))
    const input = getByTestId('case-title-input') as HTMLInputElement
    await fireEvent.update(input, 'Golpe Pix · falsa central')
    await fireEvent.keyDown(input, { key: 'Enter' })
    await flushPromises()
    expect(api.updateInvestigation).toHaveBeenCalledWith(CASE.id, { title: 'Golpe Pix · falsa central' })
    expect(getByTestId('investigation-title').textContent).toContain('falsa central')

    const options = [...(getByTestId('case-status') as HTMLSelectElement).options].map((o) => o.value)
    expect(options).toEqual(['open', 'analysis']) // closed only through a decision
    await fireEvent.update(getByTestId('case-status'), 'analysis')
    await flushPromises()
    expect(api.updateInvestigation).toHaveBeenLastCalledWith(CASE.id, { status: 'analysis' })
    expect(queryByTestId('case-reopen')).toBeNull()
  })

  it('reopens a closed case from the menu and deletes after a confirmation', async () => {
    const decisions = [{ id: 'd1', outcome_label: 'No action', closes_case: true, review: null }]
    vi.mocked(api.reopenInvestigation).mockResolvedValue({ ...CASE, status: 'analysis', decisions } as any)
    const { getByTestId, queryByTestId } = mount({ status: 'closed', decisions })
    expect(queryByTestId('case-decide')).toBeNull() // closed
    expect((getByTestId('case-status') as HTMLSelectElement).disabled).toBe(true)

    await fireEvent.click(getByTestId('case-menu'))
    await fireEvent.click(getByTestId('case-reopen'))
    await flushPromises()
    expect(api.reopenInvestigation).toHaveBeenCalledWith(CASE.id)
    expect((getByTestId('case-status') as HTMLSelectElement).value).toBe('analysis')

    await fireEvent.click(getByTestId('case-menu'))
    await fireEvent.click(getByTestId('case-delete'))
    expect(api.deleteInvestigation).not.toHaveBeenCalled()
    await fireEvent.click(getByTestId('case-delete-yes'))
    await flushPromises()
    expect(api.deleteInvestigation).toHaveBeenCalledWith(CASE.id)
    expect(push).toHaveBeenCalledWith('/investigations')
  })

  it('picks a stage of the case type; a decision waiting for review hides Decide', async () => {
    vi.mocked(api.updateInvestigation).mockImplementation(async (_id, patch) => ({ ...CASE, case_type: 'merchant_review', ...patch }) as any)
    const store = useInvestigationStore()
    store.caseTypes = [{ slug: 'merchant_review', label: 'Merchant review', stages: ['Waiting for documents', 'Escalated'], outcomes: [], actions: [], fields: [] }] as any
    const { getByTestId, queryByTestId } = mount({ case_type: 'merchant_review', status: 'analysis', deadline: { phase: 'analysis', due_at: now, hours_left: 1920, days_left: 80, total_hours: 2160, urgent: false, overdue: false } })
    expect(getByTestId('workspace-deadline').textContent).toContain('analysis · 80 d')
    expect(getByTestId('workspace-deadline').classList).not.toContain('urgent')
    expect([...(getByTestId('case-stage') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['', 'Waiting for documents', 'Escalated'])
    await fireEvent.update(getByTestId('case-stage'), 'Escalated')
    await flushPromises()
    expect(api.updateInvestigation).toHaveBeenLastCalledWith(CASE.id, { stage: 'Escalated' })
    await fireEvent.update(getByTestId('case-stage'), '')
    await flushPromises()
    expect(api.updateInvestigation).toHaveBeenLastCalledWith(CASE.id, { stage: null })
    expect(getByTestId('case-decide')).toBeTruthy()
    expect(queryByTestId('review-pending')).toBeNull()

    store.current = { ...store.current!, decisions: [{ id: 'd1', outcome_label: 'Offboard', closes_case: true, review: 'pending' }] } as any
    await flushPromises()
    expect(getByTestId('review-pending').textContent).toContain('waiting for review')
    expect(queryByTestId('case-decide')).toBeNull()
  })

  it('is read-only without write access', () => {
    const { getByTestId, queryByTestId } = mount({ has_write_access: false, can_manage: false })
    expect(getByTestId('investigation-title').classList).not.toContain('editable')
    expect((getByTestId('case-status') as HTMLSelectElement).disabled).toBe(true)
    expect(queryByTestId('case-share')).toBeNull()
    expect(queryByTestId('case-decide')).toBeNull()
  })
})

describe('ShareDialog', () => {
  it('shares with a named e-mail and removes a share', async () => {
    const store = useInvestigationStore()
    store.current = { ...CASE } as any
    const { getByTestId, queryByTestId } = render(ShareDialog, { props: { open: true } })
    expect(getByTestId('share-row-bob@x.com').textContent).toContain('can read')

    await fireEvent.update(getByTestId('share-email'), 'carla@x.com')
    await fireEvent.update(getByTestId('share-permission'), 'editor')
    await fireEvent.click(getByTestId('share-submit'))
    await flushPromises()
    expect(api.shareInvestigation).toHaveBeenCalledWith(CASE.id, 'carla@x.com', 'editor')
    expect(getByTestId('share-row-carla@x.com').textContent).toContain('can write')

    await fireEvent.click(getByTestId('share-remove-bob@x.com'))
    await flushPromises()
    expect(api.unshareInvestigation).toHaveBeenCalledWith(CASE.id, 'bob@x.com')
    expect(queryByTestId('share-row-bob@x.com')).toBeNull()
  })
})
