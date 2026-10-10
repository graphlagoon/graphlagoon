/** F3: the console's "Adicionar resultado" / "Salvar como consulta do caso" buttons and the embedded `contextId` mode. */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import QueryConsolePanel from '@/components/QueryConsolePanel.vue'
import { useGraphStore } from '@/stores/graph'
import { useQueryConsoleStore } from '@/stores/queryConsole'
import { useCurrentCaseStore } from '@/stores/currentCase'

vi.mock('@/services/api', () => ({
  api: {
    getInvestigation: vi.fn(),
    getGraphContext: vi.fn(async (id: string) => ({ id, title: `ctx ${id}` })),
    createInvestigationItem: vi.fn(async (_id: string, data: any) => ({ id: 'item-1', title: data.title, tags: [], pinned: [] })),
  },
}))
import { api } from '@/services/api'

const stubs = { CypherEditor: true, QueryErrorModal: true, QueryRunningState: true, TemplateEditorModal: true, TranspileSettingsModal: true, DataGrid: true }

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  vi.clearAllMocks()
  const graph = useGraphStore()
  graph.currentContext = { id: 'ctx-1', title: 'Pix', node_structure: { node_id_col: 'node_id' } } as any
  const consoleStore = useQueryConsoleStore()
  consoleStore.mode = 'sql'
  consoleStore.sqlQuery = 'SELECT cpf, valor FROM pix WHERE uf = :uf'
  consoleStore.hasRun = true
  consoleStore.columns = [{ field: 'col_0', header: 'cpf', type: 'text' }, { field: 'col_1', header: 'valor', type: 'number' }] as any
  consoleStore.rows = [{ col_0: '1', col_1: 10 }]
  consoleStore.rawColumns = ['cpf', 'valor']
  consoleStore.rawRows = [['1', '10']]
})

describe('QueryConsolePanel · adicionar ao caso', () => {
  it('both buttons are disabled without a current case', () => {
    const { getByTestId } = render(QueryConsolePanel, { global: { stubs } })
    expect((getByTestId('query-console-add-result') as HTMLButtonElement).disabled).toBe(true)
    expect((getByTestId('query-console-save-case-query') as HTMLButtonElement).disabled).toBe(true)
  })

  it('"Adicionar resultado" sends rawColumns/rawRows as a table; "Salvar como consulta" sends the text, mode and context', async () => {
    useCurrentCaseStore().setCurrentCase({ id: 'inv-1', title: 'Caso', status: 'analysis', has_write_access: true } as any)
    const { getByTestId } = render(QueryConsolePanel, { global: { stubs } })
    await fireEvent.click(getByTestId('query-console-add-result'))
    await flushPromises()
    expect(api.createInvestigationItem).toHaveBeenCalledWith('inv-1', expect.objectContaining({
      kind: 'table', subkind: 'result', content_json: { columns: ['cpf', 'valor'], rows: [['1', '10']], row_count: 1 },
      provenance: expect.objectContaining({ context_id: 'ctx-1', tool: 'console' }),
    }))
    await fireEvent.click(getByTestId('query-console-save-case-query'))
    await flushPromises()
    expect(vi.mocked(api.createInvestigationItem).mock.calls[1][1]).toMatchObject({
      kind: 'query', subkind: 'sql', context_id: 'ctx-1',
      query: { text: 'SELECT cpf, valor FROM pix WHERE uf = :uf', language: 'sql', output: 'table', parameters: [expect.objectContaining({ id: 'uf' })] },
    })
  })

  it('with contextId the console loads that context and sets the store override (the graph store is left alone)', async () => {
    const consoleStore = useQueryConsoleStore()
    const { unmount } = render(QueryConsolePanel, { props: { contextId: 'ctx-9', caseId: 'inv-2' }, global: { stubs } })
    await flushPromises()
    expect(api.getGraphContext).toHaveBeenCalledWith('ctx-9')
    expect(consoleStore.contextOverride?.id).toBe('ctx-9')
    expect(useGraphStore().currentContext?.id).toBe('ctx-1')
    unmount()
    expect(consoleStore.contextOverride).toBeNull()
  })
})
