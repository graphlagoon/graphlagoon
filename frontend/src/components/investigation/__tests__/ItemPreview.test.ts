import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ItemPreview from '@/components/investigation/ItemPreview.vue'
import { useInvestigationStore } from '@/stores/investigation'
import { useItemViewerStore } from '@/stores/itemViewer'

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
    await flushPromises() // the content shows as soon as the item is picked: no Preview click
    expect(getByTestId('item-preview').dataset.kind).toBe('table')
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
    await flushPromises()
    expect(getByTestId('table-chart').dataset.type).toBe('bar')
    expect(queryByTestId('chart-series-tpv')).toBeNull()
    expect(queryByTestId('chart-save')).toBeNull() // a closed case keeps its views
  })
})

describe('ItemPreview · Expand', () => {
  it('opens the reader on the latest, or on the older version it shows', async () => {
    const { getByTestId, unmount } = render(ItemPreview, { props: { item: { ...ITEM, current_version: 3 } as any, investigationId: 'inv-1' } })
    await fireEvent.click(getByTestId('item-expand'))
    expect(useItemViewerStore().target).toEqual({ itemId: 't1', version: null })
    unmount()
    const older = render(ItemPreview, { props: { item: { ...ITEM, current_version: 3 } as any, investigationId: 'inv-1', version: { version: 2 } as any } })
    await fireEvent.click(older.getByTestId('item-expand'))
    expect(useItemViewerStore().target).toEqual({ itemId: 't1', version: 2 })
  })

  it('leaves the read to the reader while it shows this item, and shows the content once it closes', async () => {
    const viewer = useItemViewerStore()
    viewer.open('t1')
    const { queryByTestId, getByTestId } = render(ItemPreview, { props: { item: ITEM as any, investigationId: 'inv-1' } })
    await flushPromises()
    expect(api.getInvestigationItemContent).not.toHaveBeenCalled()
    expect(queryByTestId('item-preview')).toBeNull()
    expect(queryByTestId('item-expand')).toBeNull() // it is already there
    viewer.close()
    await flushPromises()
    expect(getByTestId('item-preview').dataset.kind).toBe('table')
    expect(api.getInvestigationItemContent).toHaveBeenCalledTimes(1)
  })

  it('a file too large for the inspector is not fetched, and can still be opened large or downloaded', async () => {
    const big = { ...ITEM, latest: { ...ITEM.latest, size_bytes: 50 * 1024 * 1024 } }
    const { queryByTestId, getByTestId } = render(ItemPreview, { props: { item: big as any, investigationId: 'inv-1' } })
    await flushPromises()
    expect(api.getInvestigationItemContent).not.toHaveBeenCalled()
    expect(queryByTestId('item-preview')).toBeNull()
    expect(getByTestId('item-expand')).toBeTruthy()
    expect(getByTestId('item-download')).toBeTruthy()
  })
})
