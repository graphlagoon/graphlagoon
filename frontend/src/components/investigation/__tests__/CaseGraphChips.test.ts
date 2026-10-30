/**
 * The graphs of the case as chips over the canvas (UX-1): pick, add with
 * Shift, unify, and the fill legend in a popover instead of a box over the nodes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { createPinia, setActivePinia } from 'pinia'
import CaseGraphChips from '@/components/investigation/CaseGraphChips.vue'
import { useInvestigationStore } from '@/stores/investigation'

vi.mock('@/services/api', () => ({ api: { updateInvestigation: vi.fn(async (_id: string, patch: any) => ({ id: 'inv-1', ...patch })) } }))

const node = (id: string, type: string) => ({ node_id: id, node_type: type, properties: {} })

beforeEach(() => {
  setActivePinia(createPinia())
  const inv = useInvestigationStore()
  inv.current = { id: 'inv-1', status: 'analysis', has_write_access: true, settings: {}, state: { canvas_items: ['s1'] }, shared_with: [], tags: [] } as any
  inv.items = [
    { id: 's1', kind: 'graph', subkind: 'exploration_ref', title: 'Pix', tags: [], status: 'confirmed', accessible: true, current_version: 0, pinned: [], provenance: {} },
    { id: 's2', kind: 'graph', subkind: 'exploration_ref', title: 'KYC', tags: [], status: 'confirmed', accessible: true, current_version: 0, pinned: [], provenance: {} },
  ] as any
  inv.contexts = { c1: { id: 'c1', identity_keys: [] }, c2: { id: 'c2', identity_keys: [] } } as any
  inv.sourceGraphs = [
    { id: 's1', contextId: 'c1', nodes: [node('a', 'Pessoa')], edges: [], state: null, look: null, error: null },
    { id: 's2', contextId: 'c2', nodes: [node('c', 'Pessoa')], edges: [], state: null, look: null, error: 'No saved graph: open the exploration and save it' },
  ] as any
  inv.annotations = [{ id: 'r1', kind: 'role', targets: ['a@c1'], value: { role: 'mula' }, status: 'confirmed', author_kind: 'human', author_email: 'me' }] as any
})

describe('CaseGraphChips', () => {
  it('one chip per graph: the shown one is on, a broken one warns, a click picks and Shift adds', async () => {
    const { getByTestId, emitted } = render(CaseGraphChips, { props: { paintByGroup: false } })
    expect(getByTestId('legend-item-s1').getAttribute('aria-pressed')).toBe('true')
    expect(getByTestId('legend-item-s2').getAttribute('aria-pressed')).toBe('false')
    expect(getByTestId('legend-item-s2').getAttribute('title')).toContain('No saved graph')
    expect(getByTestId('legend-error-s2')).toBeTruthy()

    await fireEvent.click(getByTestId('legend-item-s2'))
    expect((emitted('pick') as any[])[0][0]).toBe('s2')
    await fireEvent.click(getByTestId('legend-item-s2'), { shiftKey: true })
    expect(((emitted('pick') as any[])[1][1] as MouseEvent).shiftKey).toBe(true)

    await fireEvent.click(getByTestId('canvas-all'))
    expect(emitted('show-all')).toHaveLength(1)
  })

  it('the fill legend lives in a popover; a unified canvas says what merged', async () => {
    const inv = useInvestigationStore()
    inv.current!.state = { canvas_items: 'all' }
    const { getByTestId, queryByTestId } = render(CaseGraphChips, { props: { paintByGroup: false } })
    expect(getByTestId('canvas-one')).toBeTruthy()
    expect(getByTestId('unification-summary').textContent).toContain('No entity merged')
    expect(queryByTestId('legend-menu')).toBeNull()
    await fireEvent.click(getByTestId('legend-toggle'))
    expect(getByTestId('legend-menu').textContent).toContain('mula')
  })
})
