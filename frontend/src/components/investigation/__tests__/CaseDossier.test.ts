import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, within } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import CaseDossier from '@/components/investigation/CaseDossier.vue'

vi.mock('@/services/api', () => ({
  api: {
    getInvestigation: vi.fn(),
    getInvestigationItems: vi.fn(),
    getInvestigationAnnotations: vi.fn(),
    getInvestigationEvents: vi.fn(async () => [
      { id: 'ev1', at: '2026-10-09T14:20:00', actor_email: 'ana@x.com', kind: 'case.created', payload: { title: 'Golpe Pix' } },
    ]),
    getInvestigationBrief: vi.fn(async () => ({ item: null, text: '# Brief\nResumo do agente' })),
    getInvestigationItemContent: vi.fn(async () => new TextEncoder().encode(JSON.stringify({ columns: ['cpf', 'exposicao'], rows: [{ cpf: '***.456.789-**', exposicao: 1200 }] })).buffer),
    createInvestigationAnnotation: vi.fn(),
    updateInvestigationAnnotation: vi.fn(),
    updateInvestigationItem: vi.fn(),
    recordInvestigationDecision: vi.fn(),
    exportInvestigation: vi.fn(async () => ({ blob: new Blob(['{}']), filename: 'investigation-inv-1-siscoaf.json' })),
  },
}))

import { api } from '@/services/api'

const base = { tags: [], status: 'confirmed', author_kind: 'human', author_email: 'ana@x.com', provenance: {}, position: 0, accessible: true, pinned: [] }
const pin = (version: number, sha256: string) => ({ version, sha256, pinned_by: 'ana@x.com', pinned_at: '2026-10-09T12:00:00', content_type: 'application/json' })
const ITEMS = [
  { ...base, id: 'g1', kind: 'graph', subkind: 'exploration_ref', title: 'Pix', context_id: 'c1', current_version: 0 },
  { ...base, id: 'g2', kind: 'graph', subkind: 'exploration_ref', title: 'Cartões', context_id: 'c2', current_version: 0, accessible: false },
  { ...base, id: 'e1', kind: 'table', subkind: 'result', title: 'Rastreio FIFO, 2 camadas', current_version: 1,
    provenance: { tool: 'trace', params: { direction: 'forward', maxHops: 2, maxDwellMs: 86_400_000, minAmount: 50, allocation: 'fifo', stopTypes: ['Saque'], stopNodes: [], window: null, seedEdgeIds: ['s1:e2'] } },
    pinned: [pin(1, '7c1e'.padEnd(60, '0') + '90ab')] },
  { ...base, id: 'e2', kind: 'table', subkind: 'csv', title: 'KYC da 4471-0', current_version: 1, pinned: [pin(1, 'b'.repeat(64))] },
  { ...base, id: 'q1', kind: 'table', subkind: 'result', title: 'Exposição por CPF', current_version: 2, tags: ['dossie'], latest: { version: 2, sha256: 'c'.repeat(64), run: { row_count: 1, duration_ms: 310 } } },
]
const H1 = { id: 'h1', kind: 'hypothesis', targets: [], value: { text: '4471-0 é conta de passagem', status: 'supported', evidence_for: ['e1'], evidence_against: [] }, status: 'confirmed', author_kind: 'human', author_email: 'ana@x.com' }
const ANNOTATIONS = [
  H1,
  { id: 'r1', kind: 'role', targets: ['a'], value: { role: 'mula' }, status: 'confirmed', author_kind: 'human', author_email: 'ana@x.com' },
  { id: 'r2', kind: 'role', targets: ['b'], value: { role: 'mula' }, status: 'confirmed', author_kind: 'agent', author_email: 'ana@x.com' },
  { id: 'r3', kind: 'role', targets: ['c'], value: { role: 'vítima' }, status: 'suggested', author_kind: 'agent', author_email: 'ana@x.com' },
  { id: 't1', kind: 'typology', targets: ['a'], value: { typology: 'passagem', norm_ref: 'CC 4.001 IV-k', label: 'Conta de passagem' }, status: 'confirmed', author_kind: 'human', author_email: 'ana@x.com' },
  { id: 'grp', kind: 'group', targets: ['a', 'b'], value: { name: 'Cluster sintético', color: 2 }, status: 'confirmed', author_kind: 'human', author_email: 'ana@x.com' },
]
const CASE = {
  id: 'inv-1', title: 'Golpe Pix · falsa central', status: 'analysis', kind_preset: 'pix_med', description: 'Pix de R$ 4.870',
  tags: ['MED'], has_write_access: true, created_at: new Date().toISOString(), settings: {}, state: {}, shared_with: [],
}
const stubs = { RouterLink: { template: '<a><slot /></a>' } }

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  vi.mocked(api.getInvestigation).mockResolvedValue(structuredClone(CASE) as any)
  vi.mocked(api.getInvestigationItems).mockResolvedValue(structuredClone(ITEMS) as any)
  vi.mocked(api.getInvestigationAnnotations).mockResolvedValue(structuredClone(ANNOTATIONS) as any)
})

describe('CaseDossier (mode=dossie)', () => {
  it('shows summary, brief, groups, indicators, hypotheses with evidence, pinned evidence, flagged tables and journal', async () => {
    const { getByTestId } = render(CaseDossier, { props: { id: 'inv-1' }, global: { stubs } })
    await flushPromises()
    const summary = getByTestId('dossier-summary').textContent!
    expect(summary).toContain('Pix de R$ 4.870')
    expect(summary).toContain('Resumo do agente')
    expect(summary).toContain('CC 4.001 IV-k · Conta de passagem')
    expect(summary).toContain('Pix com MED')
    expect(summary).toContain('2 Mule')
    expect(getByTestId('dossier-group-grp').textContent).toContain('Cluster sintético · 2')
    const ind = getByTestId('dossier-indicators').textContent!
    expect(ind).toMatch(/2\s*Grafos\s*1 restrito/)
    expect(ind).toMatch(/2\s*Evidências/)
    expect(ind).toContain('1 sustentada(s) · 0 aberta(s) · 0 refutada(s)')
    expect(ind).toMatch(/1\s*Sugestões/)

    expect(getByTestId('hypothesis-evidence_for-H1').textContent).toContain('E1 Rastreio FIFO, 2 camadas')
    expect(getByTestId('hypothesis-evidence_against-H1').textContent).toContain('nenhuma')
    const e1 = getByTestId('evidence-e1').textContent!
    expect(e1).toContain('E1 · Rastreio FIFO, 2 camadas')
    expect(e1).toContain('hash 7c1e…90ab')
    expect(e1).toContain('FIFO')
    await flushPromises()
    const table = getByTestId('dossier-table-q1').textContent!
    expect(table).toContain('Exposição por CPF')
    expect(table).toContain('***.456.789-**')
    expect(getByTestId('dossier-journal').textContent).toContain('created the case “Golpe Pix”')
  })

  it('adds a hypothesis, changes a status and links evidence through the annotations API', async () => {
    vi.mocked(api.createInvestigationAnnotation).mockResolvedValue({ id: 'h2' } as any)
    vi.mocked(api.updateInvestigationAnnotation).mockResolvedValue({ ...H1 } as any)
    const { getByTestId } = render(CaseDossier, { props: { id: 'inv-1' }, global: { stubs } })
    await flushPromises()

    await fireEvent.update(getByTestId('hypothesis-input'), 'a aposta é o destino principal')
    await fireEvent.click(getByTestId('hypothesis-add'))
    await flushPromises()
    expect(api.createInvestigationAnnotation).toHaveBeenCalledWith('inv-1', { kind: 'hypothesis', value: { text: 'a aposta é o destino principal', status: 'open' } })

    await fireEvent.update(getByTestId('hypothesis-status-H1'), 'refuted')
    await flushPromises()
    expect(api.createInvestigationAnnotation).toHaveBeenLastCalledWith('inv-1', { kind: 'hypothesis_status', targets: ['h1'], value: { status: 'refuted' } })

    const against = within(getByTestId('hypothesis-evidence_against-H1'))
    await fireEvent.update(against.getByRole('combobox'), 'e2')
    await flushPromises()
    expect(api.updateInvestigationAnnotation).toHaveBeenLastCalledWith('inv-1', 'h1', { value: { evidence_against: ['e2'] } })
  })

  it('the guided decision pre-fills the rationale, records with a reviewer and then shows the case frozen', async () => {
    const decided = {
      ...CASE, status: 'decided', frozen_hash: 'f'.repeat(4) + '0'.repeat(56) + 'beef',
      decision: { outcome: 'comunicar', actions: ['dict'], rationale: 'Conta de passagem (E1).', reviewer_email: 'rev@x.com', decided_by: 'ana@x.com', decided_at: '2026-10-09T15:00:00' },
    }
    vi.mocked(api.recordInvestigationDecision).mockResolvedValue(decided as any)
    const { getByTestId, queryByTestId } = render(CaseDossier, { props: { id: 'inv-1' }, global: { stubs } })
    await flushPromises()

    const rationale = getByTestId('decision-rationale') as HTMLTextAreaElement
    expect(rationale.value).toContain('H1 4471-0 é conta de passagem')
    expect(rationale.value).toContain('E1 Rastreio FIFO, 2 camadas')
    expect(getByTestId('decision-tipping-off').textContent).toContain('never told')
    await fireEvent.click(getByTestId('decision-action-dict'))
    await fireEvent.update(rationale, ' Conta de passagem (E1). ')
    await fireEvent.update(getByTestId('decision-reviewer'), 'rev@x.com')
    await fireEvent.click(getByTestId('decision-record'))
    await flushPromises()
    expect(api.recordInvestigationDecision).toHaveBeenCalledWith('inv-1', {
      outcome: 'comunicar', actions: ['dict'], rationale: 'Conta de passagem (E1).', reviewer_email: 'rev@x.com',
    })
    expect(queryByTestId('decision-form')).toBeNull()
    expect(getByTestId('decision-outcome').textContent).toContain('Comunicar ao COAF')
    expect(getByTestId('decision-hash').textContent).toContain('ffff…beef')
    expect(getByTestId('dossier-decision').textContent).toContain('revisor rev@x.com')
    expect(getByTestId('dossier-decision').textContent).toContain('09/10/2026 15:00')
    expect(queryByTestId('hypothesis-input')).toBeNull()
  })

  it('exports download from the server; laudo prints the page', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    const { getByTestId } = render(CaseDossier, { props: { id: 'inv-1' }, global: { stubs } })
    await flushPromises()
    await fireEvent.click(getByTestId('export-siscoaf'))
    await flushPromises()
    expect(api.exportInvestigation).toHaveBeenCalledWith('inv-1', 'siscoaf')
    expect(URL.createObjectURL).toHaveBeenCalled()
    await fireEvent.click(getByTestId('export-laudo'))
    await flushPromises()
    expect(print).toHaveBeenCalled()
  })
})
