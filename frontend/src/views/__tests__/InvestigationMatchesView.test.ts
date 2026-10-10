import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import InvestigationMatchesView from '@/views/InvestigationMatchesView.vue'
import { useInvestigationStore } from '@/stores/investigation'

vi.mock('@/services/api', () => ({
  api: {
    getInvestigation: vi.fn(),
    getInvestigationSources: vi.fn(),
    getInvestigationFiles: vi.fn(async () => []),
    getInvestigationSourceSnapshot: vi.fn(),
    getGraphContext: vi.fn(async () => ({ id: 'c1', title: 'Lojistas', identity_keys: [] })),
    getInvestigationEvents: vi.fn(async () => []),
    getInvestigationMatches: vi.fn(),
    addInvestigationMatches: vi.fn(),
    decideInvestigationMatch: vi.fn(),
  },
}))

import { api } from '@/services/api'

const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, properties })
const edge = (id: string, source: string, target: string) => ({ id, source, target, type: 'SOCIO', properties: {} })
const SNAPSHOT = {
  nodes: [
    node('p1', 'Pessoa', { nome: 'Maria Aparecida Souza', cpf: '123.418.207-90', cep: '04571-020' }),
    node('s1', 'Socio', { nome: 'MARIA A SOUZA', cpf: '***.418.207-**', cep: '04571-010' }),
    node('l1', 'Lojista'), node('l2', 'Lojista'), node('l3', 'Lojista'),
  ],
  edges: [edge('e1', 'p1', 'l1'), edge('e2', 'p1', 'l2'), edge('e3', 's1', 'l3')],
}
const MATCH = {
  id: 'm1', left: { uid: 'p1@c1' }, right: { uid: 's1@c1' }, score: 0.94, status: 'sugerido',
  reasons: [
    { term: 'name', weight: 0.5, value: 0.88, left: 'MARIA A SOUZA', right: 'MARIA APARECIDA SOUZA' },
    { term: 'cpf_middle6', weight: 0.3, value: 1, masked: true },
    { term: 'cep5', weight: 0.2, value: 1 },
  ],
  reason_text: null, decided_by: null, decided_at: null, created_at: '2026-10-10T10:00:00',
}
const stubs = { RouterLink: { template: '<a><slot /></a>' } }

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  vi.mocked(api.getInvestigation).mockResolvedValue({ id: 'inv', title: 'Case', status: 'analise', has_write_access: true, state: {} } as any)
  vi.mocked(api.getInvestigationSources).mockResolvedValue([
    { id: 'src1', kind: 'exploration', accessible: true, context_id: 'c1', title_snapshot: 'Lojistas descredenciados' },
  ] as any)
  vi.mocked(api.getInvestigationSourceSnapshot).mockResolvedValue({ snapshot: SNAPSHOT, exploration: null } as any)
  vi.mocked(api.getInvestigationMatches).mockResolvedValue([MATCH] as any)
})

describe('InvestigationMatchesView (T8)', () => {
  it('shows a masked match side by side and merges only on a reasoned accept', async () => {
    vi.mocked(api.decideInvestigationMatch).mockResolvedValue({ ...MATCH, status: 'aceito', reason_text: 'KYC' } as any)
    const { getByTestId, container } = render(InvestigationMatchesView, { props: { id: 'inv' }, global: { stubs } })
    await flushPromises()
    const store = useInvestigationStore()

    expect(getByTestId('match-masked-note')).toBeTruthy()
    expect([...container.querySelectorAll('mark')].map((m) => m.textContent)).toContain('***.418.207-**')
    expect(getByTestId('match-effect').textContent).toContain('gains 1 connection(s), from 2 to 3')
    // Suggested is not merged: the masked side stays its own entity.
    expect(store.unified.nodes.map((n) => n.node_id)).toContain('s1@c1')

    const accept = getByTestId('match-accept') as HTMLButtonElement
    expect(accept.disabled).toBe(true)
    await fireEvent.update(getByTestId('match-reason'), 'KYC')
    await fireEvent.click(accept)
    await flushPromises()
    expect(api.decideInvestigationMatch).toHaveBeenCalledWith('inv', 'm1', 'aceito', 'KYC')

    // Accepted: the two entities are one, and the ring around it grew.
    const ids = store.unified.nodes.map((n) => n.node_id)
    expect(ids).not.toContain('s1@c1')
    const ring = store.unified.edges.filter((e) => e.src === 'p1@c1').map((e) => e.dst)
    expect(ring.sort()).toEqual(['l1@c1', 'l2@c1', 'l3@c1'])
    expect(getByTestId('matches-queue').textContent).toContain('Nothing to review')
  })
})
