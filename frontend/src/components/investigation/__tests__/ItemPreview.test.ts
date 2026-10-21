import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ItemPreview from '@/components/investigation/ItemPreview.vue'
import { useInvestigationStore } from '@/stores/investigation'

const TABLE = { columns: ['day', 'tpv', 'cb'], rows: [['2026-10-01', 1000, 10], ['2026-10-02', 1500, 20]] }
const api = vi.hoisted(() => ({
  getInvestigationItemContent: vi.fn(async () => new TextEncoder().encode(JSON.stringify(TABLE)).buffer),
  updateInvestigationItem: vi.fn(async (_c: string, id: string, patch: any) => ({ ...ITEM, id, ...patch })),
  getInvestigationEvents: vi.fn(async () => []),
}))
vi.mock('@/services/api', () => ({ api }))
const ITEM = vi.hoisted(() => ({ id: 't1', kind: 'table', subkind: 'result', title: 'By day', tags: [], current_version: 1, latest: { version: 1, content_type: 'application/json', size_bytes: 10 }, state: null }))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  useInvestigationStore().current = { id: 'inv-1', status: 'analysis', has_write_access: true } as any
})

describe('ItemPreview · a table as a chart (06 P5)', () => {
  it('switches to a chart of the numeric columns and saves it as the item view', async () => {
    const { getByTestId, queryByTestId } = render(ItemPreview, { props: { item: ITEM as any, investigationId: 'inv-1' } })
    await fireEvent.click(getByTestId('item-preview-open'))
    await flushPromises()
    expect(queryByTestId('table-chart')).toBeNull() // a table by default
    await fireEvent.click(getByTestId('item-view-chart'))
    expect(getByTestId('table-chart').dataset.type).toBe('line')
    expect(getByTestId('chart-series-tpv')).toBeTruthy()
    await fireEvent.update(getByTestId('chart-type'), 'bar')
    await fireEvent.click(getByTestId('chart-series-toggle-cb')) // off
    await fireEvent.click(getByTestId('chart-save'))
    await flushPromises()
    expect(api.updateInvestigationItem).toHaveBeenCalledWith('inv-1', 't1', { state: { chart: { type: 'bar', x: 'day', series: ['tpv'] } } })
  })

  it('opens as its saved chart; read-only without write access', async () => {
    useInvestigationStore().current = { id: 'inv-1', status: 'closed', has_write_access: true } as any
    const item = { ...ITEM, state: { chart: { type: 'bar', x: 'day', series: ['cb'] } } }
    const { getByTestId, queryByTestId } = render(ItemPreview, { props: { item: item as any, investigationId: 'inv-1' } })
    await fireEvent.click(getByTestId('item-preview-open'))
    await flushPromises()
    expect(getByTestId('table-chart').dataset.type).toBe('bar')
    expect(queryByTestId('chart-series-tpv')).toBeNull()
    expect(queryByTestId('chart-save')).toBeNull() // a closed case keeps its views
  })
})
