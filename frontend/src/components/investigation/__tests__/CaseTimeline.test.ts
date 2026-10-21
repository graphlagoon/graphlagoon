import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import CaseTimeline from '@/components/investigation/CaseTimeline.vue'
import { useInvestigationStore } from '@/stores/investigation'

vi.mock('@/services/api', () => ({ api: {} }))
vi.mock('@/composables/useCaseAnalyses', () => ({ useCaseAnalyses: () => ({ nameOf: (id: string) => id }) }))

const CASE_ID = 'inv-1'
const T = (h: number) => new Date(2026, 9, 9, h, 0).toISOString()
const EVENTS = [
  { id: 'e1', at: T(8), actor_email: 'ana@x.com', actor_kind: 'human', kind: 'case.created', payload: { title: 'Golpe Pix' } },
  { id: 'e2', at: T(9), actor_email: 'ana@x.com', actor_kind: 'agent', agent_name: 'claude', kind: 'role.suggested', payload: { targets: ['a'], value: { role: 'mula' } } },
  { id: 'e3', at: T(10), actor_email: 'ana@x.com', actor_kind: 'human', kind: 'trace.run', payload: { allocation: 'fifo', maxHops: 3, coverage: 0.9 } },
  { id: 'e4', at: T(11), actor_email: 'bob@x.com', actor_kind: 'human', kind: 'item.pinned', payload: { title: 'KYC', version: 1, sha256: 'abc' } },
]

const stubs = { SwimlaneTimeline: true, AnalysisResultPanel: true }
const props = { tab: 'activity', activeItem: null, canEdit: true, traceView: 'exits', collapsed: false } as any

function mount() {
  const store = useInvestigationStore()
  store.current = { id: CASE_ID, title: 'Golpe Pix', status: 'analysis', settings: {}, tags: [] } as any
  store.events = EVENTS as any
  return render(CaseTimeline, { props, global: { stubs } })
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('CaseTimeline · Activity', () => {
  it('filters the journal by actor and by event kind, with pt-BR dates', async () => {
    const { getByTestId, getAllByTestId, queryByTestId } = mount()
    const rows = () => getAllByTestId('journal-event').map((r) => r.textContent!)
    expect(rows()).toHaveLength(4)
    expect(rows()[0]).toContain('09/10/2026 11:00')
    expect(getByTestId('journal-agent').textContent).toContain('agent claude for ana@x.com')
    expect(queryByTestId('activity-since-visit')).toBeNull() // first visit: nothing to compare with

    await fireEvent.click(getByTestId('activity-agent'))
    expect(rows()).toHaveLength(1)
    await fireEvent.click(getByTestId('activity-system'))
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toContain('followed the money')
    await fireEvent.click(getByTestId('activity-all'))

    const kind = getByTestId('activity-kind') as HTMLSelectElement
    expect([...kind.options].map((o) => o.textContent)).toEqual(['All kinds', 'case', 'item', 'role', 'trace'])
    await fireEvent.update(kind, 'item')
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toContain('KYC')
    expect(localStorage.getItem(`gl:case:${CASE_ID}:lastVisit`)).not.toBeNull()
  })

  it('marks what happened since the previous visit (per case, in localStorage)', async () => {
    localStorage.setItem(`gl:case:${CASE_ID}:lastVisit`, new Date(2026, 9, 9, 9, 30).toISOString())
    const { getByTestId, getAllByTestId } = mount()
    await nextTick() // lastVisit is read in onMounted
    const since = getByTestId('activity-since-visit')
    expect(since.textContent).toContain('Since my last visit · 2')
    const rows = getAllByTestId('journal-event')
    expect(rows[0].classList).toContain('new')
    expect(rows[1].classList).toContain('new')
    expect(rows[2].classList).not.toContain('new')
    expect(getByTestId('journal-last-visit').textContent).toContain('09/10/2026 09:30')

    await fireEvent.click(since)
    expect(getAllByTestId('journal-event')).toHaveLength(2)
    // The visit is stamped now, so the next load compares with this one.
    expect(new Date(localStorage.getItem(`gl:case:${CASE_ID}:lastVisit`)!).getTime()).toBeGreaterThan(new Date(2026, 9, 9, 9, 30).getTime())
  })
})
