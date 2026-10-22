import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, within } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import CaseDossier from '@/components/investigation/CaseDossier.vue'
import { useAuthStore } from '@/stores/auth'

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
    reviewInvestigationDecision: vi.fn(),
    getCaseTypes: vi.fn(async () => [FRAUD_RING]),
    getOrgLibrary: vi.fn(async () => [
      { slug: 'generic-memo', title: 'Generic memo', kind: 'template', body: '', seeded: false },
      { slug: 'ring-memo', title: 'Ring memo', kind: 'template', body: '', seeded: false },
    ]),
    renderInvestigationReport: vi.fn(async () => ({ id: 'r1', kind: 'document', subkind: 'markdown', title: 'Ring memo · #inv1', tags: [], pinned: [], status: 'confirmed', author_kind: 'human', author_email: 'ana@x.com', provenance: { tool: 'report', template: 'ring-memo' }, current_version: 1, position: 9, accessible: true })),
    exportInvestigation: vi.fn(async () => ({ blob: new Blob(['{}']), filename: 'investigation-inv-1.json' })),
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
  { ...base, id: 'q1', kind: 'table', subkind: 'result', title: 'Exposição por CPF', current_version: 2, tags: ['dossier'], latest: { version: 2, sha256: 'c'.repeat(64), run: { row_count: 1, duration_ms: 310 } } },
]
const H1 = { id: 'h1', kind: 'hypothesis', targets: [], value: { text: '4471-0 é conta de passagem', status: 'supported', evidence_for: ['e1'], evidence_against: [] }, status: 'confirmed', author_kind: 'human', author_email: 'ana@x.com' }
const ANNOTATIONS = [
  H1,
  { id: 'r1', kind: 'role', targets: ['a'], value: { role: 'mule' }, status: 'confirmed', author_kind: 'human', author_email: 'ana@x.com' },
  { id: 'r2', kind: 'role', targets: ['b'], value: { role: 'mule' }, status: 'confirmed', author_kind: 'agent', author_email: 'ana@x.com' },
  { id: 'r3', kind: 'role', targets: ['c'], value: { role: 'victim' }, status: 'suggested', author_kind: 'agent', author_email: 'ana@x.com' },
  { id: 'grp', kind: 'group', targets: ['a', 'b'], value: { name: 'Cluster sintético', color: 2 }, status: 'confirmed', author_kind: 'human', author_email: 'ana@x.com' },
]
const CASE = {
  id: 'inv-1', title: 'Golpe Pix · falsa central', status: 'analysis', case_type: 'fraud_ring', fields: {}, description: 'Pix de R$ 4.870',
  tags: ['MED'], has_write_access: true, created_at: new Date().toISOString(), settings: {}, state: {}, shared_with: [],
}
const stubs = { RouterLink: { template: '<a><slot /></a>' } }
const FRAUD_RING = vi.hoisted(() => ({
  slug: 'fraud_ring', label: 'Fraud ring', builtin: false, stages: [], fields: [], notice: 'Never tell the account holder.', report_templates: ['ring-memo'],
  outcomes: [
    { id: 'escalate', label: 'Escalate as a ring', closes_case: true, requires_review: true },
    { id: 'monitor', label: 'Monitor', closes_case: false, requires_review: false },
  ],
  actions: [{ id: 'block_cards', label: 'Block the cards', due_hours: 2 }],
}))
const decision = (over: Record<string, unknown>) => ({
  id: 'd1', outcome: 'monitor', outcome_label: 'Monitor', closes_case: false, targets: ['a'], task_ids: [], rationale: 'Conta de passagem (E1).',
  evidence: [{ item_id: 'e1', version: 1, sha256: 'x' }], reviewer_email: null, review: null, decided_by: 'ana@x.com', decided_at: '2026-10-09T15:00:00',
  hash: 'a'.repeat(4) + '0'.repeat(56) + 'cafe', closed_at: null, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  vi.mocked(api.getInvestigation).mockResolvedValue(structuredClone(CASE) as any)
  vi.mocked(api.getInvestigationItems).mockResolvedValue(structuredClone(ITEMS) as any)
  vi.mocked(api.getInvestigationAnnotations).mockResolvedValue(structuredClone(ANNOTATIONS) as any)
})

describe('CaseDossier (mode=dossier)', () => {
  it('shows summary, brief, groups, indicators, hypotheses with evidence, pinned evidence, flagged tables and journal', async () => {
    const { getByTestId } = render(CaseDossier, { props: { id: 'inv-1' }, global: { stubs } })
    await flushPromises()
    const summary = getByTestId('dossier-summary').textContent!
    expect(summary).toContain('Pix de R$ 4.870')
    expect(summary).toContain('Resumo do agente')
    expect(summary).toContain('Fraud ring') // the type's label from the org's case types
    expect(summary).toContain('2 mule')
    expect(getByTestId('dossier-group-grp').textContent).toContain('Cluster sintético · 2')
    const ind = getByTestId('dossier-indicators').textContent!
    expect(ind).toMatch(/2\s*Graphs\s*1 restricted/)
    expect(ind).toMatch(/2\s*Evidence/)
    expect(ind).toContain('1 supported · 0 open · 0 refuted')
    expect(ind).toMatch(/1\s*Suggestions/)

    expect(getByTestId('hypothesis-evidence_for-H1').textContent).toContain('E1 Rastreio FIFO, 2 camadas')
    expect(getByTestId('hypothesis-evidence_against-H1').textContent).toContain('none')
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

  it('records decisions from the type catalog: a partial one on entities, then a closing one a second person approves', async () => {
    const d1 = decision({})
    const d2 = decision({ id: 'd2', outcome: 'escalate', outcome_label: 'Escalate as a ring', closes_case: true, targets: [], review: 'pending', reviewer_email: 'rev@x.com', hash: 'f'.repeat(4) + '0'.repeat(56) + 'beef' })
    vi.mocked(api.recordInvestigationDecision)
      .mockResolvedValueOnce({ ...CASE, decisions: [d1] } as any)
      .mockResolvedValueOnce({ ...CASE, decisions: [d1, d2] } as any)
    vi.mocked(api.reviewInvestigationDecision).mockResolvedValue({
      ...CASE, status: 'closed', frozen_hash: d2.hash, decisions: [d1, { ...d2, review: 'approved', reviewed_by: 'rev@x.com', closed_at: '2026-10-09T16:00:00' }],
    } as any)
    const { getByTestId, queryByTestId } = render(CaseDossier, { props: { id: 'inv-1' }, global: { stubs } })
    await flushPromises()

    const rationale = getByTestId('decision-rationale') as HTMLTextAreaElement
    expect(rationale.value).toContain('H1 4471-0 é conta de passagem')
    expect(rationale.value).toContain('E1 Rastreio FIFO, 2 camadas')
    expect(getByTestId('decision-notice').textContent).toContain('Never tell')
    expect(getByTestId('decision-effect').textContent).toContain('Closing freezes the case') // the first outcome closes
    expect(getByTestId('decision-four-eyes')).toBeTruthy()
    await fireEvent.click(getByTestId('decision-outcome-monitor'))
    expect(getByTestId('decision-effect').textContent).toContain('The case stays open')
    expect(queryByTestId('decision-target-c')).toBeNull() // only confirmed roles (and the selection) are candidates
    await fireEvent.click(getByTestId('decision-target-a'))
    await fireEvent.click(getByTestId('decision-action-block_cards'))
    await fireEvent.update(rationale, ' Conta de passagem (E1). ')
    await fireEvent.click(getByTestId('decision-record'))
    await flushPromises()
    expect(api.recordInvestigationDecision).toHaveBeenLastCalledWith('inv-1', {
      outcome: 'monitor', rationale: 'Conta de passagem (E1).', targets: ['a'], tasks: [{ action: 'block_cards' }],
    })
    expect(queryByTestId('decision-form')).toBeNull()
    expect(getByTestId('decision-D1').textContent).toContain('D1 · Monitor')
    expect(getByTestId('decision-D1').textContent).toContain('09/10/2026 15:00')
    expect(getByTestId('decision-targets').textContent).toContain('About')

    await fireEvent.click(getByTestId('decision-new'))
    await fireEvent.update(getByTestId('decision-reviewer'), 'rev@x.com')
    expect(getByTestId('decision-four-eyes').textContent).toContain('rev@x.com')
    await fireEvent.click(getByTestId('decision-record'))
    await flushPromises()
    expect(api.recordInvestigationDecision).toHaveBeenLastCalledWith('inv-1', expect.objectContaining({ outcome: 'escalate', reviewer_email: 'rev@x.com' }))
    expect(getByTestId('decision-D2').textContent).toContain('waiting for review')
    expect(queryByTestId('decision-new')).toBeNull() // nothing else is decided while a review is pending
    expect(queryByTestId('decision-approve')).toBeNull() // only the named reviewer approves
    expect(queryByTestId('decision-withdraw')).toBeNull() // not the author either (decided by ana@x.com)

    useAuthStore().email = 'rev@x.com'
    await flushPromises()
    await fireEvent.update(getByTestId('decision-review-note'), 'agreed')
    await fireEvent.click(getByTestId('decision-approve'))
    await flushPromises()
    expect(api.reviewInvestigationDecision).toHaveBeenCalledWith('inv-1', 'd2', { approve: true, note: 'agreed' })
    expect(getByTestId('decision-closed').textContent).toContain('Closed by D2')
    expect(getByTestId('decision-D2').querySelector('[data-testid="decision-hash"]')!.textContent).toContain('ffff…beef')
    expect(queryByTestId('decision-new')).toBeNull()
    expect(queryByTestId('hypothesis-input')).toBeNull()
  })

  it('a type without catalog names the decision and says whether it closes the case', async () => {
    vi.mocked(api.getInvestigation).mockResolvedValue({ ...structuredClone(CASE), case_type: 'general' } as any)
    vi.mocked(api.recordInvestigationDecision).mockResolvedValue({ ...CASE, status: 'closed', decisions: [decision({ outcome: null, outcome_label: 'False positive', closes_case: true, closed_at: '2026-10-09T15:00:00' })] } as any)
    const { getByTestId } = render(CaseDossier, { props: { id: 'inv-1' }, global: { stubs } })
    await flushPromises()
    const record = getByTestId('decision-record') as HTMLButtonElement
    expect(record.disabled).toBe(true) // the outcome needs a name
    await fireEvent.update(getByTestId('decision-outcome-label'), ' False positive ')
    await fireEvent.click(getByTestId('decision-closes'))
    expect(getByTestId('decision-effect').textContent).toContain('Closing freezes the case')
    await fireEvent.click(record)
    await flushPromises()
    expect(api.recordInvestigationDecision).toHaveBeenCalledWith('inv-1', expect.objectContaining({ outcome_label: 'False positive', closes_case: true }))
    expect(getByTestId('decision-closed').textContent).toContain('Closed by D1')
  })

  it("drafts a report from an org template, the type's first", async () => {
    const { getByTestId } = render(CaseDossier, { props: { id: 'inv-1' }, global: { stubs } })
    await flushPromises()
    const select = getByTestId('report-template') as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual(['Ring memo · for this type', 'Generic memo'])
    await fireEvent.click(getByTestId('report-draft'))
    await flushPromises()
    expect(api.renderInvestigationReport).toHaveBeenCalledWith('inv-1', 'ring-memo')
    expect(getByTestId('report-drafted').textContent).toContain('Ring memo · #inv1')
  })

  it('exports download from the server; laudo prints the page', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    const { getByTestId } = render(CaseDossier, { props: { id: 'inv-1' }, global: { stubs } })
    await flushPromises()
    await fireEvent.click(getByTestId('export-json'))
    await flushPromises()
    expect(api.exportInvestigation).toHaveBeenCalledWith('inv-1', 'json')
    expect(URL.createObjectURL).toHaveBeenCalled()
    await fireEvent.click(getByTestId('export-laudo'))
    await flushPromises()
    expect(print).toHaveBeenCalled()
  })
})

describe('CaseDossier notes and documents (UX-1)', () => {
  const WRITINGS = [
    { ...base, id: 'n1', kind: 'note', subkind: 'anchored', title: 'Same phone', description: 'Same **phone** as the mule', anchor: { entity_ids: ['a'] }, current_version: 1, created_at: '2026-10-09T10:00:00' },
    { ...base, id: 'n2', kind: 'note', subkind: 'free', title: 'Agent note', description: null, author_kind: 'agent', current_version: 1, status: 'suggested', created_at: '2026-10-09T10:01:00' },
    { ...base, id: 'd1', kind: 'document', subkind: 'markdown', title: 'Ring memo', current_version: 1, created_at: '2026-10-09T10:02:00' },
    { ...base, id: 'd2', kind: 'document', subkind: 'link', title: 'Bank notice', provenance: { url: 'https://example.com/notice' }, current_version: 1, created_at: '2026-10-09T10:03:00' },
    { ...base, id: 'd3', kind: 'document', subkind: 'upload', title: 'statement.pdf', provenance: { filename: 'statement.pdf' }, current_version: 1, latest: { version: 1, sha256: 'f'.repeat(64), content_type: 'application/pdf', size_bytes: 2048 }, created_at: '2026-10-09T10:04:00' },
    { ...base, id: 'd4', kind: 'document', subkind: 'markdown', title: 'Rejected draft', status: 'rejected', current_version: 1, created_at: '2026-10-09T10:05:00' },
    { ...base, id: 'd5', kind: 'document', subkind: 'markdown', title: 'Flagged but not a table', tags: ['dossier'], current_version: 1, created_at: '2026-10-09T10:06:00' },
  ]

  it('shows every note and document, rendered, with links, files and anchors; tables stay tables', async () => {
    vi.mocked(api.getInvestigationItems).mockResolvedValue(structuredClone([...ITEMS, ...WRITINGS]) as any)
    vi.mocked(api.getInvestigationItemContent).mockImplementation(async (_i: string, itemId: string) => {
      const text = itemId === 'n2' ? 'Body from the version' : itemId === 'd1' ? '# Memo\n- <script>x</script>' : '{}'
      return new TextEncoder().encode(text).buffer as ArrayBuffer
    })
    const { getByTestId, queryByTestId } = render(CaseDossier, { props: { id: 'inv-1' }, global: { stubs } })
    await flushPromises()

    const section = getByTestId('dossier-documents')
    expect(getByTestId('dossier-writing-body-n1').innerHTML).toContain('<strong>phone</strong>')
    expect(within(getByTestId('dossier-writing-n1')).getByText(/^On /)).toBeTruthy()
    expect(getByTestId('dossier-writing-body-n2').textContent).toContain('Body from the version') // an agent's note has no description
    expect(within(getByTestId('dossier-writing-n2')).getByText('suggested')).toBeTruthy()
    const memo = getByTestId('dossier-writing-body-d1').innerHTML
    expect(memo).toContain('<h3>Memo</h3>')
    expect(memo).not.toContain('<script>')
    expect(getByTestId('dossier-link-d2').getAttribute('href')).toBe('https://example.com/notice')
    expect(getByTestId('dossier-writing-d3').textContent).toContain('application/pdf · 2.0 KB')
    expect(getByTestId('dossier-download-d3')).toBeTruthy()
    expect(within(section).queryByText('Rejected draft')).toBeNull()
    expect(queryByTestId('dossier-table-d5')).toBeNull() // a flagged document is read above, not as an empty table
    expect(getByTestId('dossier-table-q1')).toBeTruthy()
    expect(getByTestId('dossier-brief').innerHTML).toContain('<h3>Brief</h3>')
  })
})
