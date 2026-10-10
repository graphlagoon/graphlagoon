import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, within } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import InvestigationDossierView from '@/views/InvestigationDossierView.vue'

vi.mock('@/services/api', () => ({
  api: {
    getInvestigation: vi.fn(),
    getInvestigationSources: vi.fn(async () => [
      { id: 's1', accessible: true, title_snapshot: 'Pix' },
      { id: 's2', accessible: false, title_snapshot: 'Cartões' },
    ]),
    getInvestigationEvidence: vi.fn(),
    getInvestigationEvents: vi.fn(async () => [
      { id: 'ev1', at: '2026-10-09T14:20:00', actor_email: 'ana@x.com', kind: 'case.created', payload: { title: 'Golpe Pix' }, hash: 'h' },
    ]),
    getInvestigationNotes: vi.fn(async () => []),
    getInvestigationProposals: vi.fn(async () => [{ id: 'p1' }]),
    createInvestigationHypothesis: vi.fn(),
    updateInvestigationHypothesis: vi.fn(),
    recordInvestigationDecision: vi.fn(),
  },
}))

import { api } from '@/services/api'

const H1 = { id: 'H1', text: '4471-0 é conta de passagem', status: 'sustentada', evidence_for: ['e1'], evidence_against: [] }
const CASE = {
  id: 'inv-1', title: 'Golpe Pix · falsa central', status: 'analise', typology: 'CC 4.001 IV-k', description: 'Pix de R$ 4.870',
  has_write_access: true, created_at: new Date().toISOString(), state: { roles: { a: 'mule', b: 'mule' }, hypotheses: [H1] },
}
const EVIDENCE = [
  { id: 'e1', title: 'Rastreio FIFO, 2 camadas', kind: 'trace', sha256: '7c1e'.padEnd(60, '0') + '90ab', created_by: 'ana@x.com',
    params: { direction: 'forward', maxHops: 2, maxDwellMs: 86_400_000, minAmount: 50, allocation: 'fifo', stopTypes: ['Saque'], stopNodes: [], window: null, seedEdgeIds: ['s1:e2'] } },
  { id: 'e2', title: 'KYC da 4471-0', kind: 'table', sha256: 'b'.repeat(64), created_by: 'ana@x.com', params: { table: 'kyc' } },
]
const stubs = { RouterLink: { template: '<a><slot /></a>' } }

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  vi.mocked(api.getInvestigation).mockResolvedValue(structuredClone(CASE) as any)
  vi.mocked(api.getInvestigationEvidence).mockResolvedValue(EVIDENCE as any)
})

describe('InvestigationDossierView (T7)', () => {
  it('shows summary, indicators, hypotheses with evidence for and against, evidence and journal', async () => {
    const { getByTestId } = render(InvestigationDossierView, { props: { id: 'inv-1' }, global: { stubs } })
    await flushPromises()
    const summary = getByTestId('dossier-summary').textContent!
    expect(summary).toContain('Pix de R$ 4.870')
    expect(summary).toContain('CC 4.001 IV-k')
    expect(summary).toContain('2 Mule')
    const ind = getByTestId('dossier-indicators').textContent!
    expect(ind).toMatch(/2\s*Sources\s*1 restricted/)
    expect(ind).toMatch(/2\s*Evidence/)
    expect(ind).toContain('1 supported · 0 open · 0 refuted')
    expect(ind).toMatch(/1\s*Proposals/)

    expect(getByTestId('hypothesis-evidence_for-H1').textContent).toContain('E1 Rastreio FIFO, 2 camadas')
    expect(getByTestId('hypothesis-evidence_against-H1').textContent).toContain('none')
    const e1 = getByTestId('evidence-e1').textContent!
    expect(e1).toContain('E1 · Rastreio FIFO, 2 camadas')
    expect(e1).toContain('hash 7c1e…90ab')
    expect(e1).toContain('FIFO')
    expect(getByTestId('dossier-journal').textContent).toContain('created the case “Golpe Pix”')
  })

  it('adds a hypothesis, changes a status and links evidence through the API', async () => {
    const updated = { ...CASE, state: { ...CASE.state, hypotheses: [{ ...H1, status: 'refutada' }] } }
    vi.mocked(api.updateInvestigationHypothesis).mockResolvedValue(updated as any)
    vi.mocked(api.createInvestigationHypothesis).mockResolvedValue(updated as any)
    const { getByTestId } = render(InvestigationDossierView, { props: { id: 'inv-1' }, global: { stubs } })
    await flushPromises()

    await fireEvent.update(getByTestId('hypothesis-input'), 'a aposta é o destino principal')
    await fireEvent.click(getByTestId('hypothesis-add'))
    expect(api.createInvestigationHypothesis).toHaveBeenCalledWith('inv-1', { text: 'a aposta é o destino principal' })

    await fireEvent.update(getByTestId('hypothesis-status-H1'), 'refutada')
    expect(api.updateInvestigationHypothesis).toHaveBeenCalledWith('inv-1', 'H1', { status: 'refutada' })
    await flushPromises()

    const against = within(getByTestId('hypothesis-evidence_against-H1'))
    await fireEvent.update(against.getByRole('combobox'), 'e2')
    expect(api.updateInvestigationHypothesis).toHaveBeenLastCalledWith('inv-1', 'H1', { evidence_against: ['e2'] })
  })

  it('records the decision and then shows it frozen and read-only', async () => {
    const decided = {
      ...CASE, status: 'decidido', frozen_hash: 'f'.repeat(4) + '0'.repeat(56) + 'beef',
      decision: { outcome: 'comunicar', actions: ['dict'], rationale: 'Conta de passagem (E1).', decided_by: 'ana@x.com', decided_at: '2026-10-09T15:00:00' },
    }
    vi.mocked(api.recordInvestigationDecision).mockResolvedValue(decided as any)
    const { getByTestId, queryByTestId } = render(InvestigationDossierView, { props: { id: 'inv-1' }, global: { stubs } })
    await flushPromises()

    expect((getByTestId('decision-record') as HTMLButtonElement).disabled).toBe(true)
    await fireEvent.click(getByTestId('decision-action-dict'))
    await fireEvent.update(getByTestId('decision-rationale'), ' Conta de passagem (E1). ')
    await fireEvent.click(getByTestId('decision-record'))
    await flushPromises()
    expect(api.recordInvestigationDecision).toHaveBeenCalledWith('inv-1', {
      outcome: 'comunicar', actions: ['dict'], rationale: 'Conta de passagem (E1).',
    })
    expect(queryByTestId('decision-form')).toBeNull()
    expect(getByTestId('decision-outcome').textContent).toContain('Communicate to COAF')
    expect(getByTestId('decision-hash').textContent).toContain('ffff…beef')
    expect(queryByTestId('hypothesis-input')).toBeNull()
  })
})
