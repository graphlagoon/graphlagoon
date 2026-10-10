import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import CaseItemsPanel from '@/components/investigation/CaseItemsPanel.vue'
import { useInvestigationStore } from '@/stores/investigation'

vi.mock('@/services/api', () => ({
  api: {
    getInvestigationEvents: vi.fn(async () => []),
    getInvestigationItems: vi.fn(async () => []),
    setInvestigationItemStatus: vi.fn(),
    pinInvestigationItem: vi.fn(),
    runInvestigationQuery: vi.fn(),
    putInvestigationBrief: vi.fn(),
    createInvestigationItem: vi.fn(),
    deleteInvestigationItem: vi.fn(async () => {}),
  },
}))

import { api } from '@/services/api'

const base = { tags: [], status: 'confirmed', author_kind: 'human', author_email: 'me@x.com', provenance: {}, position: 0, accessible: true, pinned: [] }
const ITEMS = [
  { ...base, id: 'g1', kind: 'graph', subkind: 'exploration_ref', title: 'Pix transfers', context_id: 'c1', current_version: 0 },
  { ...base, id: 'q1', kind: 'query', subkind: 'sql', title: 'Exposição', current_version: 1, query: { text: 'SELECT 1', language: 'sql', parameters: [], output: 'table' },
    latest: { version: 1, sha256: 'a'.repeat(64), run: { row_count: 12, duration_ms: 310, run_by: 'me@x.com', author_kind: 'human' }, created_at: '2026-10-10T10:00:00' } },
  { ...base, id: 'd1', kind: 'document', subkind: 'markdown', title: 'KYC', current_version: 2, author_kind: 'agent',
    latest: { version: 2, sha256: 'b'.repeat(64) }, pinned: [{ version: 1, sha256: 'c'.repeat(64), pinned_at: 'x' }] },
  { ...base, id: 'n1', kind: 'note', subkind: 'free', title: 'Achado', current_version: 1, status: 'suggested', author_kind: 'agent' },
  { ...base, id: 'b1', kind: 'document', subkind: 'brief', title: 'Brief', current_version: 1 },
]

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, permissions: ['investigation.upload'] } as any
  const store = useInvestigationStore()
  store.current = { id: 'inv', has_write_access: true, status: 'analysis' } as any
  store.items = structuredClone(ITEMS) as any
  store.brief = { item: ITEMS[4] as any, text: '# Brief\nConta de passagem' }
})

describe('CaseItemsPanel', () => {
  it('groups the material by kind with short ids, author chips, pins, suggestions and the brief on top', () => {
    const { getByTestId, queryByTestId } = render(CaseItemsPanel, { props: { canEdit: true } })
    expect(getByTestId('brief-text').textContent).toContain('Conta de passagem')
    expect(queryByTestId('item-b1')).toBeNull() // the brief is not a row
    expect(getByTestId('items-group-graph').textContent).toContain('Pix transfers')
    expect(getByTestId('item-g1').textContent).toContain('G1')
    expect(getByTestId('item-q1').textContent).toContain('Q1')
    expect(getByTestId('item-q1').textContent).toContain('12 rows · 310 ms')
    expect(getByTestId('item-author-d1').textContent).toContain('agent')
    expect(getByTestId('item-pinned-d1').textContent).toContain('v1')
    expect(getByTestId('item-suggested-n1')).toBeTruthy()
    expect(getByTestId('item-n1').classList).toContain('suggested')
    expect(getByTestId('suggested-count').textContent).toContain('1 suggested')
    expect(getByTestId('item-canvas-g1')).toBeTruthy()
    expect(queryByTestId('item-canvas-q1')).toBeNull() // a table query is not on the canvas
  })

  it('confirms a suggestion in place, re-runs a query, pins a version, saves a brief version', async () => {
    const store = useInvestigationStore()
    vi.mocked(api.setInvestigationItemStatus).mockImplementation(async (_i, id, status) => ({ ...ITEMS[3], id, status }) as any)
    vi.mocked(api.runInvestigationQuery).mockResolvedValue({ ...ITEMS[1], current_version: 2, latest: { version: 2, sha256: 'd'.repeat(64), run: { row_count: 3, duration_ms: 50 } } } as any)
    vi.mocked(api.pinInvestigationItem).mockResolvedValue({ version: 2, sha256: 'd'.repeat(64) } as any)
    vi.mocked(api.putInvestigationBrief).mockResolvedValue({ item: { ...ITEMS[4], current_version: 2 }, text: '# v2' } as any)
    const { getByTestId } = render(CaseItemsPanel, { props: { canEdit: true } })

    await fireEvent.click(getByTestId('item-confirm-n1'))
    await flushPromises()
    expect(api.setInvestigationItemStatus).toHaveBeenCalledWith('inv', 'n1', 'confirmed')
    expect(store.items.find((i) => i.id === 'n1')?.status).toBe('confirmed')

    await fireEvent.click(getByTestId('item-run-q1'))
    await flushPromises()
    expect(api.runInvestigationQuery).toHaveBeenCalledWith('inv', 'q1', {})
    expect(getByTestId('item-q1').textContent).toContain('2 runs')

    await fireEvent.click(getByTestId('item-pin-q1'))
    await flushPromises()
    expect(api.pinInvestigationItem).toHaveBeenCalledWith('inv', 'q1', {})

    await fireEvent.click(getByTestId('brief-edit'))
    await fireEvent.update(getByTestId('brief-input'), '# v2')
    await fireEvent.click(getByTestId('brief-save'))
    await flushPromises()
    expect(api.putInvestigationBrief).toHaveBeenCalledWith('inv', '# v2')
    expect(getByTestId('brief-text').textContent).toContain('# v2')
  })

  it('toggling "on canvas" updates the store without touching the API; read-only hides the actions', async () => {
    const store = useInvestigationStore()
    const { getByTestId, queryByTestId, unmount } = render(CaseItemsPanel, { props: { canEdit: true } })
    await fireEvent.click(getByTestId('item-canvas-g1'))
    expect(store.offCanvas.has('g1')).toBe(true)
    expect(store.canvasItems).toEqual([])
    unmount()
    const ro = render(CaseItemsPanel, { props: { canEdit: false } })
    expect(ro.queryByTestId('items-add')).toBeNull()
    expect(ro.queryByTestId('item-remove-g1')).toBeNull()
    expect(queryByTestId('compose-note')).toBeNull()
  })
})
