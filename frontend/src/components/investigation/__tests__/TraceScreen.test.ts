import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import fixture from '@/__tests__/fixtures/trace/golpe-pix.json'
import TracePanel from '@/components/investigation/TracePanel.vue'
import TraceExits from '@/components/investigation/TraceExits.vue'
import TraceSankey from '@/components/investigation/TraceSankey.vue'
import { useInvestigationStore } from '@/stores/investigation'
import { useTraceStore } from '@/stores/trace'

const api = vi.hoisted(() => ({
  createInvestigationItem: vi.fn(async (_id: string, body: any) => ({ id: 'it-1', pinned: [], current_version: 1, ...body })),
  pinInvestigationItem: vi.fn(async () => ({ version: 1, sha256: 'ab'.repeat(32), pinned_by: 'me' })),
  getInvestigationItems: vi.fn(async () => []),
  getInvestigationEvents: vi.fn(async () => []),
}))
vi.mock('@/services/api', () => ({ api }))

const amount = (v: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'BRL' }).format(v)

let pinia: ReturnType<typeof createPinia>
beforeEach(async () => {
  pinia = createPinia()
  setActivePinia(pinia)
  const inv = useInvestigationStore()
  inv.contexts = { ctx: { id: 'ctx', identity_keys: [], edge_semantics: fixture.edge_semantics } } as any
  inv.sourceGraphs = [{ id: 'src', contextId: 'ctx', nodes: fixture.nodes, edges: fixture.edges, state: null, error: null }] as any
  // Forward from the victim: the seed is its only outgoing edge (the contested Pix).
  expect(await useTraceStore().start({ type: 'node', id: '0001-9@ctx' }, 'forward')).toBe(true)
})

describe('trace screen (T5)', () => {
  it('exits with the value per rule, retained balances and the method stamp', () => {
    const { getByTestId } = render(TraceExits, { global: { plugins: [pinia] } })
    expect(getByTestId('trace-exit-saque-atm@ctx').textContent).toContain(amount(2000))
    const exchange = getByTestId('trace-exit-exchange-gama@ctx').textContent!
    expect(exchange).toContain(amount(1550))
    expect(exchange).toContain(`proportional would give ${amount(1597.73)}`)
    expect(exchange).toContain('via 8812-7')
    expect(getByTestId('trace-exit-bet-delta@ctx').textContent).toContain(amount(880))
    const retained = getByTestId('trace-retained').textContent!
    for (const [id, v] of [['4471-0', 70], ['8812-7', 350], ['3090-1', 20]] as const) expect(retained).toContain(`${id} · ${amount(v)}`)
    expect(getByTestId('trace-method').textContent).toMatch(/forward · 3 layers · Δ 24 h · min .* · FIFO · stop: .*Saque.* · window .* · seed: src:e2/)
  })

  it('panel: README defaults, exit-like types stop, save as evidence with the method, backward offers LIFO', async () => {
    const { getByTestId, queryByTestId } = render(TracePanel, { global: { plugins: [pinia] } })
    expect((getByTestId('trace-max-hops') as HTMLInputElement).value).toBe('3')
    expect((getByTestId('trace-dwell') as HTMLInputElement).value).toBe('24')
    for (const t of ['Saque', 'Exchange', 'Aposta', 'BancoExterno']) expect((getByTestId(`trace-stop-${t}`) as HTMLInputElement).checked).toBe(true)
    expect((getByTestId('trace-stop-Conta') as HTMLInputElement).checked).toBe(false)
    const save = getByTestId('trace-save-evidence') as HTMLButtonElement
    expect(save.disabled).toBe(true) // no write access to the case yet
    const inv = useInvestigationStore()
    inv.current = { id: 'inv-1', status: 'analysis', has_write_access: true, state: {} } as any
    await nextTick()
    await fireEvent.click(save)
    const [id, body] = api.createInvestigationItem.mock.calls[0]
    expect(id).toBe('inv-1')
    expect(body.kind).toBe('table')
    expect(body.provenance).toMatchObject({ tool: 'trace', params: { allocation: 'fifo', maxHops: 3, seedEdgeIds: ['src:e2'], engine: 'browser' } })
    expect(body.content_json.exits['saque-atm@ctx']).toBe(2000)
    expect(body.content_json.stamp).toContain('FIFO')
    await vi.waitFor(() => expect(api.pinInvestigationItem).toHaveBeenCalledWith('inv-1', 'it-1', {}))

    await fireEvent.click(getByTestId('trace-backward'))
    expect((getByTestId('trace-rule-lifo') as HTMLInputElement).checked).toBe(true)
    expect(queryByTestId('trace-rule-fifo')).toBeNull()
  })

  it('sankey: a band per traced pair, a bar per node', () => {
    const trace = useTraceStore()
    const { getAllByTestId } = render(TraceSankey, {
      props: { flows: trace.flows, columns: trace.columns!, nameOf: trace.nameOf, allocation: 'fifo' },
    })
    expect(getAllByTestId('sankey-band')).toHaveLength(7)
    expect(getAllByTestId('sankey-node')).toHaveLength(8)
  })
})
