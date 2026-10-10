import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { createPinia, setActivePinia } from 'pinia'
import fixture from '@/__tests__/fixtures/trace/golpe-pix.json'
import SwimlaneTimeline from '@/components/investigation/SwimlaneTimeline.vue'
import { useInvestigationStore } from '@/stores/investigation'
import { useCaseAnalyses, type TraceContent } from '@/composables/useCaseAnalyses'
import { traceFlows } from '@/utils/traceView'

const api = vi.hoisted(() => ({
  createInvestigationItem: vi.fn(async (_id: string, body: any) => ({ id: 'it-1', pinned: [], current_version: 1, tags: [], accessible: true, position: 0, status: 'confirmed', author_kind: 'human', author_email: 'me', ...body })),
  getInvestigationEvents: vi.fn(async () => []),
}))
vi.mock('@/services/api', () => ({ api }))

let content: TraceContent
let nameOf: (id: string) => string

beforeEach(async () => {
  setActivePinia(createPinia())
  const inv = useInvestigationStore()
  inv.current = { id: 'inv-1', status: 'analysis', has_write_access: true, settings: {}, state: {} } as any
  inv.contexts = { ctx: { id: 'ctx', identity_keys: [], edge_semantics: fixture.edge_semantics } } as any
  inv.sourceGraphs = [{ id: 'src', contextId: 'ctx', nodes: fixture.nodes, edges: fixture.edges, state: null, error: null }] as any
  const analyses = useCaseAnalyses()
  nameOf = analyses.nameOf
  // Forward from the victim: the seed is its only outgoing edge (the contested Pix).
  await analyses.runTrace(analyses.defaultTraceParams({ type: 'node', id: '0001-9@ctx' }, 'forward')!)
  content = inv.contents['it-1:1'] as TraceContent
})

function mount(focus: [number, number] | null = null) {
  return render(SwimlaneTimeline, {
    props: { result: content.result, flows: traceFlows(content.result, content.walked), nameOf, focus },
  })
}

describe('swimlane timeline (F3.5, F4)', () => {
  it('a lane per account plus the exits, an arrow per transfer, a dwell band per account the money crossed', () => {
    const { getAllByTestId } = mount()
    const lanes = getAllByTestId('swimlane-lane').map((l) => l.textContent!.trim())
    expect(lanes).toHaveLength(6)
    expect(lanes[0]).toContain('0001-9')
    expect(lanes[5]).toBe('Exits')
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

  it('without a trace result it lays the busiest entities of the case timeline', () => {
    const flows = traceFlows(content.result, content.walked)
    const { getAllByTestId, queryByText } = render(SwimlaneTimeline, { props: { flows, nameOf, focus: null, maxLanes: 3 } })
    expect(getAllByTestId('swimlane-lane')).toHaveLength(3)
    expect(queryByText('Exits')).toBeNull()
  })
})
