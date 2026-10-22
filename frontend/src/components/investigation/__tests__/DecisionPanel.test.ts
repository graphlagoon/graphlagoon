import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import DecisionPanel from '@/components/investigation/DecisionPanel.vue'
import { useInvestigationStore } from '@/stores/investigation'

const api = vi.hoisted(() => ({
  recordInvestigationDecision: vi.fn(async (id: string, _body: unknown) => ({ id, status: 'closed', decisions: [], has_write_access: true })),
  setInvestigationAnnotationStatus: vi.fn(async () => ({})),
  getInvestigationAnnotations: vi.fn(async () => []),
  getInvestigationEvents: vi.fn(async () => []),
  getInvestigation: vi.fn(async () => ({ id: 'inv-1', status: 'analysis', decisions: [] })),
}))
vi.mock('@/services/api', () => ({ api }))

const RING = {
  slug: 'fraud_ring', label: 'Fraud ring', stages: [], fields: [], notice: null,
  outcomes: [
    { id: 'escalate', label: 'Escalate as a ring', closes_case: true, requires_review: false },
    { id: 'monitor', label: 'Keep monitoring', closes_case: false, requires_review: false },
  ],
  actions: [{ id: 'block', label: 'Block the accounts', due_hours: 2 }],
}
const PROPOSAL = {
  id: 'p1', kind: 'decision_proposal', targets: ['Customer:c1'], status: 'suggested', author_kind: 'agent', author_email: 'me@x.com',
  value: { outcome: 'monitor', rationale: 'Shared phone (E1).', tasks: [{ action: 'block' }, { title: 'Pull statements', assignee_kind: 'agent', agent_name: 'claude' }] },
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.spyOn(window, 'confirm').mockReturnValue(true) // confirmAction falls back to it without the dialog host
  const store = useInvestigationStore()
  store.current = { id: 'inv-1', status: 'analysis', case_type: 'fraud_ring', has_write_access: true, settings: {}, state: {}, decisions: [] } as any
  store.caseTypes = [RING] as any
})

describe('DecisionPanel · an agent proposal (06 P8)', () => {
  it('opens with the draft and records it as the decision that takes it up', async () => {
    useInvestigationStore().annotations = [PROPOSAL] as any
    const { getByTestId } = render(DecisionPanel)
    expect(getByTestId('decision-proposal').textContent).toContain('Proposed by the agent')
    expect(getByTestId('decision-proposal').textContent).toContain('task “Pull statements” for agent claude')
    expect((getByTestId('decision-outcome-monitor') as HTMLInputElement).checked).toBe(true)
    expect((getByTestId('decision-target-Customer:c1') as HTMLInputElement).checked).toBe(true)
    expect((getByTestId('decision-action-block') as HTMLInputElement).checked).toBe(true)
    expect((getByTestId('decision-rationale') as HTMLTextAreaElement).value).toBe('Shared phone (E1).')
    await fireEvent.click(getByTestId('decision-outcome-escalate')) // the person changes the outcome
    await fireEvent.click(getByTestId('decision-record'))
    await flushPromises()
    expect(api.recordInvestigationDecision).toHaveBeenCalledWith('inv-1', {
      outcome: 'escalate', rationale: 'Shared phone (E1).', targets: ['Customer:c1'],
      tasks: [{ action: 'block' }, { title: 'Pull statements', assignee_kind: 'agent', agent_name: 'claude' }], proposal_id: 'p1',
    })
  })

  it('dismissing rejects the proposal and the panel is the person\'s own again', async () => {
    useInvestigationStore().annotations = [PROPOSAL] as any
    const { getByTestId, queryByTestId } = render(DecisionPanel)
    await fireEvent.click(getByTestId('decision-proposal-dismiss'))
    await flushPromises()
    expect(api.setInvestigationAnnotationStatus).toHaveBeenCalledWith('inv-1', 'p1', 'rejected')
    expect(queryByTestId('decision-proposal')).toBeNull()
    await fireEvent.update(getByTestId('decision-rationale'), 'My own reasons')
    await fireEvent.click(getByTestId('decision-record'))
    await flushPromises()
    expect(api.recordInvestigationDecision.mock.calls[0][1]).not.toHaveProperty('proposal_id')
  })
})
