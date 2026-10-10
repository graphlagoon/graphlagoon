import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { createPinia, setActivePinia } from 'pinia'
import fixture from '@/__tests__/fixtures/trace/golpe-pix.json'
import SwimlaneTimeline from '@/components/investigation/SwimlaneTimeline.vue'
import { useInvestigationStore } from '@/stores/investigation'
import { useTraceStore } from '@/stores/trace'
import { sankeyLayout } from '@/utils/traceView'

vi.mock('@/services/api', () => ({ api: {} }))

const t = (hhmm: string) => Date.parse(`2026-09-09T${hhmm}:00-03:00`)

beforeEach(async () => {
  setActivePinia(createPinia())
  const inv = useInvestigationStore()
  inv.contexts = { ctx: { id: 'ctx', identity_keys: [], edge_semantics: fixture.edge_semantics } } as any
  inv.sourceGraphs = [{ id: 'src', contextId: 'ctx', nodes: fixture.nodes, edges: fixture.edges, state: null, error: null }] as any
  await useTraceStore().start({ type: 'node', id: '0001-9@ctx' }, 'forward')
})

function mount() {
  const trace = useTraceStore()
  return render(SwimlaneTimeline, {
    props: { result: trace.result!, flows: trace.allFlows, nameOf: trace.nameOf, focus: trace.focus },
  })
}

describe('swimlane timeline (F3.5)', () => {
  it('a lane per account plus the exits, an arrow per transfer, a dwell band per account the money crossed', () => {
    const { getAllByTestId } = mount()
    expect(getAllByTestId('swimlane-lane').map((l) => l.textContent!.trim())).toEqual([
      'Conta 0001-9 (vítima)', '4471-0', '5520-3', '8812-7', '3090-1', 'Exits',
    ])
    expect(getAllByTestId('swimlane-arrow')).toHaveLength(7)
    expect(getAllByTestId('swimlane-arrow').map((a) => a.textContent).join('|')).toContain('Saque ATM')
    // 4471-0 14:02→14:15, 5520-3 14:09→14:40, 8812-7 14:11→15:05, 3090-1 14:15→14:31; the victim has none.
    expect(getAllByTestId('swimlane-dwell')).toHaveLength(4)
  })

  it('dragging picks a window, a click clears it', async () => {
    const { getByTestId, emitted } = mount()
    const svg = getByTestId('trace-swimlanes').querySelector('svg')!
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 200, right: 900, bottom: 200, x: 0, y: 0, toJSON: () => ({}) })
    const hit = getByTestId('swimlane-hit')
    await fireEvent.pointerDown(hit, { clientX: 300 })
    await fireEvent.pointerMove(hit, { clientX: 500 })
    await fireEvent.pointerUp(hit, { clientX: 500 })
    await fireEvent.pointerDown(hit, { clientX: 400 })
    await fireEvent.pointerUp(hit, { clientX: 401 })
    const events = emitted('update:focus') as unknown[][]
    const [a, b] = events[0][0] as [number, number]
    expect(a).toBeLessThan(b)
    expect(events[1][0]).toBeNull()
  })

  it('the window filters the flows that feed the graph and the Sankey', () => {
    const trace = useTraceStore()
    trace.focus = [t('14:05'), t('14:20')]
    expect(trace.flows.map((f) => f.id)).toEqual(['src:e3', 'src:e4', 'src:e5'])
    expect(sankeyLayout(trace.flows, trace.columns!).links).toHaveLength(3)
    expect(trace.columns!.columns.has('0001-9@ctx')).toBe(false)
    trace.focus = null
    expect(trace.flows).toHaveLength(7)
  })
})
