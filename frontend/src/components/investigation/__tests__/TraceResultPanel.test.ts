import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { createPinia, setActivePinia } from 'pinia'
import fixture from '@/__tests__/fixtures/trace/flow-chain.json'
import TraceResultPanel from '@/components/investigation/TraceResultPanel.vue'
import { useInvestigationStore } from '@/stores/investigation'
import { useCaseAnalyses, ALLOCATIONS, type TraceContent } from '@/composables/useCaseAnalyses'

const api = vi.hoisted(() => ({
  createInvestigationItem: vi.fn(async (_id: string, body: any) => ({ id: 'it-1', pinned: [], current_version: 1, tags: [], accessible: true, position: 0, status: 'confirmed', author_kind: 'human', author_email: 'me', ...body })),
  addInvestigationItemVersion: vi.fn(async (_id: string, itemId: string, body: any) => ({ id: itemId, pinned: [], current_version: 2, tags: [], accessible: true, position: 0, status: 'confirmed', author_kind: 'human', author_email: 'me', kind: 'table', subkind: 'result', provenance: { tool: 'trace' }, title: 't', ...body })),
  getInvestigationEvents: vi.fn(async () => []),
}))
vi.mock('@/services/api', () => ({ api }))

const amount = (v: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v)
const t = (hhmm: string) => Date.parse(`2026-09-09T${hhmm}:00-03:00`)

let pinia: ReturnType<typeof createPinia>
beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  vi.clearAllMocks()
  const inv = useInvestigationStore()
  inv.current = { id: 'inv-1', status: 'analysis', has_write_access: true, settings: {}, state: {} } as any
  inv.contexts = { ctx: { id: 'ctx', identity_keys: [], edge_semantics: fixture.edge_semantics } } as any
  inv.items = [{ id: 'src', kind: 'graph', subkind: 'exploration_ref', title: 'src', tags: [], status: 'confirmed', accessible: true, current_version: 0, pinned: [], provenance: {} }] as any
  inv.sourceGraphs = [{ id: 'src', contextId: 'ctx', nodes: fixture.nodes, edges: fixture.edges, state: null, error: null }] as any
})

async function traced() {
  const analyses = useCaseAnalyses()
  const params = analyses.defaultTraceParams({ type: 'node', id: '0001-9@ctx' }, 'forward')!
  const item = await analyses.runTrace(params)
  return { analyses, params, item: item!, content: useInvestigationStore().contents['it-1:1'] as TraceContent }
}

describe('trace as an item (05 §3) and its renderer', () => {
  it('defaults from the seed; the run is a table/result item with the method as provenance', async () => {
    const { params, content } = await traced()
    expect(params).toMatchObject({ maxHops: 3, dwellHours: 24, minAmount: 0, allocation: 'fifo', seedEdgeIds: ['src:e2'] })
    // The default stops are the types where value only ends: no domain word anywhere.
    expect(params.stopTypes).toEqual(['Betting', 'CashWithdrawal', 'Exchange'])
    const [id, body] = api.createInvestigationItem.mock.calls[0]
    expect(id).toBe('inv-1')
    expect(body).toMatchObject({ kind: 'table', subkind: 'result', provenance: { tool: 'trace', engine: 'browser', params: { allocation: 'fifo', maxHops: 3, seedEdgeIds: ['src:e2'] } } })
    expect(body.content_json.result.exits['atm-cash@ctx']).toBe(2000)
    expect(content.stamp).toContain('FIFO')
    expect(content.proportionalExits).toBeTruthy()
  })

  it('exits with the value per rule, retained balances, the method stamp and coverage; pin emits', async () => {
    const { analyses, content } = await traced()
    const { getByTestId, emitted } = render(TraceResultPanel, {
      props: { content, nameOf: analyses.nameOf, view: 'layers', focus: null, canEdit: true, pinned: false },
      global: { plugins: [pinia] },
    })
    expect(getByTestId('trace-exit-atm-cash@ctx').textContent).toContain(amount(2000))
    const exchange = getByTestId('trace-exit-exchange-gama@ctx').textContent!
    expect(exchange).toContain(amount(1550))
    expect(exchange).toContain(`proportional would give ${amount(1597.73)}`)
    expect(exchange).toContain('8812-7')
    expect(getByTestId('trace-exit-bet-delta@ctx').textContent).toContain(amount(880))
    const retained = getByTestId('trace-retained').textContent!
    for (const [id, v] of [['4471-0', 70], ['8812-7', 350], ['3090-1', 20]] as const) {
      expect(retained).toContain(id)
      expect(retained).toContain(amount(v))
    }
    expect(getByTestId('trace-method').textContent).toMatch(/forward · 3 layers · Δ 24 h · min .* · FIFO · stop: .*CashWithdrawal.* · window .* · seed: src:e2/)
    expect(getByTestId('trace-coverage').textContent).toContain('(91%)')
    await fireEvent.click(getByTestId('trace-save-evidence'))
    expect(emitted('pin')).toBeTruthy()
  })

  it('sankey: a band per traced pair, a bar per node; the time window narrows the flows', async () => {
    const { analyses, content } = await traced()
    const all = render(TraceResultPanel, { props: { content, nameOf: analyses.nameOf, view: 'sankey', focus: null, canEdit: false, pinned: false }, global: { plugins: [pinia] } })
    expect(all.getAllByTestId('sankey-band')).toHaveLength(7)
    expect(all.getAllByTestId('sankey-node')).toHaveLength(8)
    all.unmount()
    const windowed = render(TraceResultPanel, { props: { content, nameOf: analyses.nameOf, view: 'sankey', focus: [t('14:05'), t('14:20')], canEdit: false, pinned: false }, global: { plugins: [pinia] } })
    expect(windowed.getAllByTestId('sankey-band')).toHaveLength(3)
  })

  it('backward offers LIFO; re-running into the item adds a version instead of a new item', async () => {
    const { analyses, item } = await traced()
    const back = analyses.defaultTraceParams({ type: 'node', id: 'atm-cash@ctx' }, 'backward')!
    expect(back.allocation).toBe('lifo')
    expect(ALLOCATIONS.backward.map((a) => a.id)).not.toContain('fifo')
    await analyses.runTrace(back, item.id)
    expect(api.addInvestigationItemVersion).toHaveBeenCalledWith('inv-1', 'it-1', expect.objectContaining({ content_json: expect.objectContaining({ tool: 'trace' }) }))
    expect(api.createInvestigationItem).toHaveBeenCalledTimes(1)
  })
})
