import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import InvestigationAgentsView from '@/views/InvestigationAgentsView.vue'

vi.mock('@/services/api', () => ({
  api: {
    getInvestigation: vi.fn(),
    getInvestigationSources: vi.fn(async () => []),
    getInvestigationEvents: vi.fn(async () => []),
    getInvestigationProposals: vi.fn(),
    acceptProposal: vi.fn(),
    rejectProposal: vi.fn(),
    getAgentTokens: vi.fn(async () => []),
    createAgentToken: vi.fn(),
    revokeAgentToken: vi.fn(),
  },
}))

import { api } from '@/services/api'

const proposal = {
  id: 'p1', kind: 'role', payload: { entity: 'acct:5520-3', role: 'mule' }, rationale: 'Saque em 31 min',
  actor: { kind: 'agent', email: 'me@x.com', agent_name: 'Claude' }, status: 'pending',
}
const stubs = { RouterLink: { template: '<a><slot /></a>' } }

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  window.__GRAPH_LAGOON_CONFIG__ = { agents_enabled: true, permissions: ['investigation.agent'] }
  vi.mocked(api.getInvestigation).mockResolvedValue({ id: 'inv', title: 'Case', status: 'analise', has_write_access: true } as any)
  vi.mocked(api.getInvestigationProposals).mockResolvedValue([proposal] as any)
})

describe('InvestigationAgentsView', () => {
  it('requires a reason to reject a proposal', async () => {
    vi.mocked(api.acceptProposal).mockResolvedValue({ ...proposal, status: 'accepted' } as any)
    vi.mocked(api.rejectProposal).mockResolvedValue({ ...proposal, id: 'p2', status: 'rejected' } as any)
    const { getByTestId, findByText } = render(InvestigationAgentsView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    expect(await findByText('mark acct:5520-3 as Mule / suspect')).toBeTruthy()

    await fireEvent.click(getByTestId('proposal-reject'))
    expect((getByTestId('proposal-reject-confirm') as HTMLButtonElement).disabled).toBe(true)
    await fireEvent.update(getByTestId('proposal-reason'), 'conta da vítima')
    await fireEvent.click(getByTestId('proposal-reject-confirm'))
    await flushPromises()
    expect(api.rejectProposal).toHaveBeenCalledWith('inv', 'p1', 'conta da vítima')
  })

  it('accept calls the server and drops the card', async () => {
    vi.mocked(api.acceptProposal).mockResolvedValue({ ...proposal, status: 'accepted' } as any)
    const { getByTestId, queryByTestId } = render(InvestigationAgentsView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    await fireEvent.click(getByTestId('proposal-accept'))
    await flushPromises()
    expect(api.acceptProposal).toHaveBeenCalledWith('inv', 'p1')
    expect(queryByTestId('proposal-p1')).toBeNull()
  })

  it('creates a token and shows it once in the MCP command', async () => {
    vi.mocked(api.createAgentToken).mockResolvedValue({
      id: 't1', name: 'Claude Code', scopes: ['read'], active: true, expires_at: new Date(Date.now() + 864e5).toISOString(), token: 'glt_secret',
    } as any)
    const { getByTestId } = render(InvestigationAgentsView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    await fireEvent.click(getByTestId('token-create'))
    await flushPromises()
    expect(api.createAgentToken).toHaveBeenCalledWith({
      name: 'Claude Code', scopes: ['read', 'analyze', 'write', 'propose'], expires_in_days: 30,
    })
    expect(getByTestId('token-command').textContent).toContain('Bearer glt_secret')
    expect(getByTestId('token-t1')).toBeTruthy()
  })
})
