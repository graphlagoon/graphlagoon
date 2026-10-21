import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import AddItemsPopover from '@/components/investigation/AddItemsPopover.vue'

const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, currentRoute: { value: { name: 'investigation' } } }),
  useRoute: () => ({ name: 'investigation', params: {}, query: {} }),
}))
vi.mock('@/services/api', () => ({
  api: {
    getAllExplorations: vi.fn(),
    getExploration: vi.fn(),
    getInvestigationItems: vi.fn(async () => []),
    getGraphContexts: vi.fn(async () => []),
    getGraphContext: vi.fn(async () => ({ id: 'c1', title: 'Pix' })),
    createInvestigationItem: vi.fn(async (_id: string, data: any) => ({ id: 'new', title: data.title ?? 'x', latest: null, tags: [], pinned: [] })),
  },
}))
vi.mock('@/stores/contexts', () => ({
  useContextsStore: () => ({
    contexts: [{ id: 'c1', title: 'Pix', identity_keys: [] }, { id: 'c2', title: 'KYC', identity_keys: [] }],
    fetchContexts: vi.fn(async () => {}),
  }),
}))
vi.mock('@/components/QueryConsolePanel.vue', () => ({ default: { props: ['contextId', 'caseId'], template: '<div data-testid="console-stub" :data-context="contextId" :data-case="caseId" />' } }))

import { api } from '@/services/api'

const exp = (id: string, title: string, node_count: number | null, updated_at: string) => ({
  id, title, graph_context_id: 'c1', owner_email: 'me@x.com', shared_with: [], has_write_access: true, state: {},
  created_at: updated_at, updated_at, node_count,
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.useFakeTimers()
  window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true }
  vi.mocked(api.getAllExplorations).mockResolvedValue([
    exp('old', 'Old mules', 12, '2026-09-01T10:00:00Z'),
    exp('empty', 'Nothing saved', 0, '2026-10-01T10:00:00Z'),
    exp('new', 'Fresh trace', 40, '2026-10-09T10:00:00Z'),
  ] as any)
})

describe('AddItemsPopover', () => {
  it('opens on "My recent": newest first, node counts, empty rows disabled, server-side search', async () => {
    const { getByTestId, queryByTestId, container } = render(AddItemsPopover, { props: { open: true, investigationId: 'inv-1' } })
    await flushPromises()
    expect(getByTestId('add-tab-recent').getAttribute('aria-selected')).toBe('true')
    expect(getByTestId('add-tab-panel-recent')).toBeTruthy()
    expect(api.getAllExplorations).toHaveBeenCalledWith({ q: undefined, mine: true, limit: 50 })
    expect(queryByTestId('add-scope-all')).toBeNull() // superusers only
    const rows = [...container.querySelectorAll('[data-testid^="add-exp-"]')].map((r) => r.getAttribute('data-testid'))
    expect(rows).toEqual(['add-exp-new', 'add-exp-empty', 'add-exp-old'])
    expect(getByTestId('add-exp-new').textContent).toContain('40 nodes')
    expect((getByTestId('add-exp-empty').querySelector('input') as HTMLInputElement).disabled).toBe(true)

    await fireEvent.update(getByTestId('add-search'), 'trace')
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(api.getAllExplorations).toHaveBeenLastCalledWith({ q: 'trace', mine: true, limit: 50 })
  })

  it('"New exploration" opens the graph page with ?case=; "Query" embeds the console against the chosen context', async () => {
    const { getByTestId } = render(AddItemsPopover, { props: { open: true, investigationId: 'inv-1' } })
    await flushPromises()
    await fireEvent.click(getByTestId('add-tab-new'))
    await fireEvent.click(getByTestId('add-new-context-c2'))
    expect(push).toHaveBeenCalledWith({ path: '/graph/c2', query: { case: 'inv-1' } })

    await fireEvent.click(getByTestId('add-tab-query'))
    await flushPromises()
    const stub = getByTestId('console-stub')
    expect(stub.getAttribute('data-context')).toBe('c1')
    expect(stub.getAttribute('data-case')).toBe('inv-1')
  })

  it('"Paste / link" detects a URL, a TSV table and a note', async () => {
    const { getByTestId } = render(AddItemsPopover, { props: { open: true, investigationId: 'inv-1' } })
    await flushPromises()
    await fireEvent.click(getByTestId('add-tab-paste'))
    await fireEvent.update(getByTestId('add-paste-input'), 'https://exemplo.gov.br/laudo.pdf')
    expect(getByTestId('add-paste-kind').textContent).toContain('link')
    await fireEvent.update(getByTestId('add-paste-input'), 'cpf\tvalor\n1\t10\n2\t20')
    expect(getByTestId('add-paste-kind').textContent).toContain('table')
    await fireEvent.click(getByTestId('add-paste-submit'))
    await flushPromises()
    expect(api.createInvestigationItem).toHaveBeenCalledWith('inv-1', expect.objectContaining({
      kind: 'table', subkind: 'result', content_json: { columns: ['cpf', 'valor'], rows: [['1', '10'], ['2', '20']], row_count: 2 },
    }))
  })
})
