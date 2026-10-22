import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import CaseItemsPanel from '@/components/investigation/CaseItemsPanel.vue'
import { useToast } from '@/composables/useToast'
import { useInvestigationStore } from '@/stores/investigation'

vi.mock('@/services/api', () => ({
  api: {
    getInvestigationEvents: vi.fn(async () => []),
    getInvestigationItems: vi.fn(async () => []),
    getInvestigationItemVersions: vi.fn(async () => []),
    getInvestigationItemContent: vi.fn(async () => new TextEncoder().encode(JSON.stringify({ columns: ['cpf', 'valor'], rows: [['1', 2]] })).buffer),
    joinInvestigationTables: vi.fn(async () => ({ id: 'joined', title: 'KYC + Exposição by cpf' })),
    compareInvestigationTables: vi.fn(),
    promoteInvestigationTables: vi.fn(async () => []),
    setInvestigationItemStatus: vi.fn(),
    pinInvestigationItem: vi.fn(),
    runInvestigationQuery: vi.fn(),
    putInvestigationBrief: vi.fn(),
    createInvestigationItem: vi.fn(async (_id: string, data: any) => ({ id: 'new', title: data.title, tags: [], pinned: [] })),
    deleteInvestigationItem: vi.fn(async () => {}),
    restoreInvestigationItem: vi.fn(async (_i: string, id: string) => ({ id, kind: 'table', subkind: 'csv', title: 'KYC', tags: [], pinned: [], status: 'confirmed', current_version: 1, position: 0 })),
    reopenInvestigationItem: vi.fn(async (_i: string, id: string) => ({ id, kind: 'note', subkind: 'free', title: 'Achado', tags: [], pinned: [], status: 'suggested', current_version: 1, position: 0 })),
    searchInvestigation: vi.fn(async () => []),
    getInvestigation: vi.fn(),
  },
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), currentRoute: { value: { name: 'investigation' } } }),
  useRoute: () => ({ name: 'investigation', params: {}, query: {} }),
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
  { ...base, id: 't1', kind: 'table', subkind: 'result', title: 'KYC', current_version: 1, latest: { version: 1, sha256: 'e'.repeat(64), content_type: 'application/json' } },
  { ...base, id: 't2', kind: 'table', subkind: 'csv', title: 'Exposição', current_version: 1, latest: { version: 1, sha256: 'f'.repeat(64), content_type: 'text/csv' } },
  { ...base, id: 't3', kind: 'table', subkind: 'result', title: 'Garantias', current_version: 1, latest: { version: 1, sha256: '9'.repeat(64), content_type: 'application/json' } },
]

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, permissions: ['investigation.upload'] } as any
  const store = useInvestigationStore()
  store.current = { id: 'inv', has_write_access: true, status: 'analysis' } as any
  store.items = structuredClone(ITEMS) as any
  vi.mocked(api.getInvestigationItems).mockImplementation(async () => store.items) // adds re-fetch the list
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
    expect(getByTestId('brief-text').innerHTML).toContain('<h3>v2</h3>') // rendered as markdown
  })

  it('F3: two tables selected → Join by the shared key; Compare shows the diff; three → Promote in bulk', async () => {
    vi.mocked(api.compareInvestigationTables).mockResolvedValue({
      key_column: 'cpf', columns: { left: ['cpf', 'valor'], right: ['cpf', 'valor'], shared: ['valor'] },
      counts: { left: 2, right: 2, only_left: 1, only_right: 1, changed: 1, same: 0 },
      only_left: [['1', 2]], only_right: [['3', 4]], changed: [{ key: '2', fields: { valor: { left: 5, right: 6 } } }], truncated: false,
      left: { item_id: 't1', title: 'KYC', version: 1 }, right: { item_id: 't2', title: 'Exposição', version: 1 },
    } as any)
    const { getByTestId, queryByTestId } = render(CaseItemsPanel, { props: { canEdit: true } })
    expect(queryByTestId('table-ops-bar')).toBeNull()
    await fireEvent.click(getByTestId('item-select-t1'))
    await fireEvent.click(getByTestId('item-select-t2'))
    expect(getByTestId('table-ops-bar').textContent).toContain('2 selected')

    await fireEvent.click(getByTestId('table-op-join'))
    await flushPromises()
    expect((getByTestId('ops-key') as HTMLInputElement).value).toBe('cpf') // the shared column
    await fireEvent.click(getByTestId('ops-submit'))
    await flushPromises()
    expect(api.joinInvestigationTables).toHaveBeenCalledWith('inv', { item_ids: ['t1', 't2'], key_column: 'cpf', title: 'KYC + Exposição by cpf' })
    expect(queryByTestId('table-ops-dialog')).toBeNull()

    await fireEvent.click(getByTestId('item-select-t1'))
    await fireEvent.click(getByTestId('item-select-t2'))
    await fireEvent.click(getByTestId('table-op-compare'))
    await flushPromises()
    await fireEvent.click(getByTestId('ops-submit'))
    await flushPromises()
    expect(api.compareInvestigationTables).toHaveBeenCalledWith('inv', { left: { item_id: 't1' }, right: { item_id: 't2' }, key_column: 'cpf' })
    expect(getByTestId('table-diff-summary').textContent).toContain('1 changed')
    expect(getByTestId('table-diff').textContent).toContain('valor')

    await fireEvent.click(getByTestId('table-ops-dialog').querySelector('.modal-close')!)
    await fireEvent.click(getByTestId('item-select-t3'))
    expect(getByTestId('table-ops-bar').textContent).toContain('3 selected')
    await fireEvent.click(getByTestId('table-op-enrichment'))
    await flushPromises()
    await fireEvent.update(getByTestId('ops-node-types'), 'Pessoa')
    await fireEvent.click(getByTestId('ops-submit'))
    await flushPromises()
    expect(api.promoteInvestigationTables).toHaveBeenCalledWith('inv', { item_ids: ['t1', 't2', 't3'], as: 'enrichment', options: { key_column: 'cpf', match_node_types: ['Pessoa'] } })
  })

  it('F3: pasting text adds a note, a URL a link document; the query card lists :params with their source', async () => {
    const { getByTestId } = render(CaseItemsPanel, { props: { canEdit: true } })
    const panel = getByTestId('case-items-panel')
    await fireEvent.paste(panel, { clipboardData: { files: [], getData: () => 'Conta de passagem confirmada' } } as any)
    await flushPromises()
    expect(api.createInvestigationItem).toHaveBeenLastCalledWith('inv', expect.objectContaining({ kind: 'note', subkind: 'free', content: 'Conta de passagem confirmada' }))
    await fireEvent.paste(panel, { clipboardData: { files: [], getData: () => 'https://bcb.gov.br/med' } } as any)
    await flushPromises()
    expect(api.createInvestigationItem).toHaveBeenLastCalledWith('inv', expect.objectContaining({ kind: 'document', subkind: 'link', content: 'https://bcb.gov.br/med' }))

    const store = useInvestigationStore()
    store.items.find((i) => i.id === 'q1')!.query!.text = 'SELECT * FROM t WHERE cpf IN (:cpfs)'
    await fireEvent.click(getByTestId('item-expand-q1'))
    await flushPromises()
    expect(getByTestId('query-params').textContent).toContain(':cpfs')
    const source = getByTestId('query-param-source-cpfs') as HTMLSelectElement
    expect([...source.options].map((o) => o.textContent)).toEqual(['fixed value', 'current selection', 'group', 'property'])
    await fireEvent.update(getByTestId('query-param-value-cpfs'), '1, 2')
    vi.mocked(api.runInvestigationQuery).mockResolvedValue({ ...ITEMS[1], current_version: 2, latest: { version: 2, sha256: 'd'.repeat(64), run: { row_count: 3, duration_ms: 50 } } } as any)
    await fireEvent.click(getByTestId('query-run-q1'))
    await flushPromises()
    expect(api.runInvestigationQuery).toHaveBeenCalledWith('inv', 'q1', { cpfs: ['1', '2'] })
  })

  it('toggling "on canvas" updates the store without touching the API; read-only hides the actions', async () => {
    const store = useInvestigationStore()
    const { getByTestId, queryByTestId, unmount } = render(CaseItemsPanel, { props: { canEdit: true } })
    await fireEvent.click(getByTestId('item-canvas-g1'))
    expect(store.canvasIds.has('g1')).toBe(false)
    expect(store.canvasItems).toEqual([])
    unmount()
    const ro = render(CaseItemsPanel, { props: { canEdit: false } })
    expect(ro.queryByTestId('items-add')).toBeNull()
    expect(ro.queryByTestId('item-remove-g1')).toBeNull()
    expect(queryByTestId('compose-note')).toBeNull()
  })

  it('removing is undone from the toast or from "Removed"; a rejection can be undone too (UX-1)', async () => {
    const store = useInvestigationStore()
    vi.mocked(api.restoreInvestigationItem).mockImplementation(async (_i, id) => ({ ...ITEMS.find((x) => x.id === id), deleted_at: null }) as any)
    vi.mocked(api.reopenInvestigationItem).mockImplementation(async (_i, id) => ({ ...ITEMS.find((x) => x.id === id), status: 'suggested' }) as any)
    const { getByTestId, queryByTestId } = render(CaseItemsPanel, { props: { canEdit: true } })
    await fireEvent.click(getByTestId('item-remove-t1'))
    await flushPromises()
    expect(api.deleteInvestigationItem).toHaveBeenCalledWith('inv', 't1')
    expect(queryByTestId('item-t1')).toBeNull()
    const undo = useToast().toasts.value.find((t) => t.message.startsWith('Removed “KYC”'))
    expect(undo?.action?.label).toBe('Undo')
    await fireEvent.click(getByTestId('items-removed').querySelector('button')!)
    await fireEvent.click(getByTestId('item-restore-t1'))
    await flushPromises()
    expect(api.restoreInvestigationItem).toHaveBeenCalledWith('inv', 't1')
    expect(store.removedItems).toEqual([])
    expect(getByTestId('item-t1')).toBeTruthy()

    vi.mocked(api.setInvestigationItemStatus).mockImplementation(async (_i, id, status) => ({ ...ITEMS.find((x) => x.id === id), status }) as any)
    await fireEvent.click(getByTestId('item-reject-n1'))
    await flushPromises()
    const reopen = useToast().toasts.value.find((t) => t.message === 'Rejected “Achado”')
    reopen!.action!.onClick()
    await flushPromises()
    expect(api.reopenInvestigationItem).toHaveBeenCalledWith('inv', 'n1')
  })

  it('search reaches the text of the files with a snippet, says when nothing matches, and hides rejected items', async () => {
    vi.useFakeTimers()
    vi.mocked(api.searchInvestigation).mockResolvedValue([{ id: 't2', match: 'text', snippet: 'linha com 4471-0' }] as any)
    const store = useInvestigationStore()
    store.items[1] = { ...store.items[1], status: 'rejected' } as any
    const { getByTestId, queryByTestId } = render(CaseItemsPanel, { props: { canEdit: true } })
    await fireEvent.update(getByTestId('items-search'), '4471')
    await vi.advanceTimersByTimeAsync(350)
    await flushPromises()
    expect(api.searchInvestigation).toHaveBeenCalledWith('inv', '4471')
    expect(getByTestId('item-t2')).toBeTruthy()
    expect(getByTestId('item-snippet-t2').textContent).toContain('4471-0')
    vi.mocked(api.searchInvestigation).mockResolvedValue([])
    await fireEvent.update(getByTestId('items-search'), 'zzzz')
    await vi.advanceTimersByTimeAsync(350)
    await flushPromises()
    expect(getByTestId('items-no-match')).toBeTruthy()
    await fireEvent.update(getByTestId('items-search'), '')
    const rejectedId = store.items[1].id
    expect(getByTestId(`item-${rejectedId}`)).toBeTruthy()
    await fireEvent.click(getByTestId('items-hide-rejected'))
    expect(queryByTestId(`item-${rejectedId}`)).toBeNull()
    vi.useRealTimers()
  })

  it('rows are keyboard-selectable and icon buttons are labelled', async () => {
    const { getByTestId, emitted } = render(CaseItemsPanel, { props: { canEdit: true } })
    const row = getByTestId('item-t1')
    expect(row.getAttribute('tabindex')).toBe('0')
    await fireEvent.keyDown(row, { key: 'Enter' })
    expect((emitted().select as unknown[][])[0][0]).toMatchObject({ id: 't1' })
    expect(getByTestId('item-remove-t1').getAttribute('aria-label')).toBe('Remove KYC')
    expect(getByTestId('item-confirm-n1').getAttribute('aria-label')).toBe('Confirm Achado')
  })
})
