import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ItemViewer from '@/components/investigation/ItemViewer.vue'
import { useInvestigationStore } from '@/stores/investigation'
import { useItemViewerStore } from '@/stores/itemViewer'

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer
const CONTENT: Record<string, string> = {
  'rep:': '<html><body><h1>Relatório</h1><script>document.body.append("ran")</script></body></html>',
  'rep:1': '<p>first draft</p>',
  'tab:': 'conta;valor\n109738-0;100\n501677-1;200\n',
  'note:': '# Nota',
}
const api = vi.hoisted(() => ({
  getInvestigationItemContent: vi.fn(async (_c: string, id: string, v?: number) => enc(CONTENT[`${id}:${v ?? ''}`] ?? '')),
  getInvestigationItemVersions: vi.fn(async () => [
    { version: 1, content_type: 'text/html', size_bytes: 20, created_at: '2026-10-01T10:00:00Z' },
    { version: 2, content_type: 'text/html', size_bytes: 90, created_at: '2026-10-02T10:00:00Z' },
  ]),
}))
vi.mock('@/services/api', () => ({ api }))

const base = { tags: [], status: 'confirmed', author_kind: 'agent', author_email: 'ana@x.com', pinned: [], accessible: true, position: 0 }
const ITEMS = [
  { ...base, id: 'note', kind: 'note', subkind: 'free', title: 'Nota', current_version: 1, provenance: {}, latest: { version: 1, content_type: 'text/markdown', size_bytes: 6 } },
  { ...base, id: 'graph', kind: 'graph', subkind: 'exploration_ref', title: 'Grafo', current_version: 0, provenance: {} },
  { ...base, id: 'rep', kind: 'document', subkind: 'file', title: 'Relatório do agente', current_version: 2, provenance: { filename: 'relatorio.html' }, latest: { version: 2, content_type: 'text/html', size_bytes: 90 } },
  { ...base, id: 'tab', kind: 'table', subkind: 'csv', title: 'Extrato', author_kind: 'human', current_version: 1, provenance: {}, latest: { version: 1, content_type: 'text/csv', size_bytes: 40 } },
]

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  const store = useInvestigationStore()
  store.current = { id: 'inv-1', status: 'analysis', has_write_access: true } as any
  store.items = ITEMS as any
  window.__GRAPH_LAGOON_CONFIG__ = { investigation_html_scripts: 'cdn' } as any
})
afterEach(() => {
  document.body.innerHTML = ''
  delete (window as { __GRAPH_LAGOON_CONFIG__?: unknown }).__GRAPH_LAGOON_CONFIG__
})

const q = (testid: string) => document.body.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null
async function mount(itemId: string, version: number | null = null) {
  useItemViewerStore().open(itemId, version)
  const view = render(ItemViewer)
  await flushPromises()
  return view
}

describe('ItemViewer', () => {
  it("opens an agent's HTML large, in an opaque-origin sandbox that may run scripts but never reach the app", async () => {
    await mount('rep')
    expect(q('viewer-title')!.textContent).toBe('Relatório do agente')
    expect(api.getInvestigationItemContent).toHaveBeenCalledTimes(1)
    expect(api.getInvestigationItemContent).toHaveBeenCalledWith('inv-1', 'rep', undefined)
    const frame = q('item-html') as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy')
    expect(frame.getAttribute('srcdoc')).toContain('<h1>Relatório</h1>')
    expect(q('item-preview')!.className).toContain('full')
  })

  it('steps through the material in its order (← →, ◀ ▶), skipping graphs; Esc closes', async () => {
    await mount('tab')
    const viewer = useItemViewerStore()
    expect(q('viewer-position')!.textContent).toBe('1 / 3') // table, document, note
    expect((q('viewer-prev') as HTMLButtonElement).disabled).toBe(true)
    expect(q('item-table-count')!.textContent).toContain('2 rows')

    await fireEvent.keyDown(window, { key: 'ArrowRight' })
    await flushPromises()
    expect(viewer.target).toEqual({ itemId: 'rep', version: null })
    expect(q('viewer-title')!.textContent).toBe('Relatório do agente')

    await fireEvent.click(q('viewer-next')!)
    await flushPromises()
    expect(viewer.target!.itemId).toBe('note')
    expect((q('viewer-next') as HTMLButtonElement).disabled).toBe(true)

    await fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(viewer.target!.itemId).toBe('rep')
    await fireEvent.keyDown(window, { key: 'Escape' })
    expect(viewer.target).toBeNull()
  })

  it('arrows type in the table filter instead of stepping', async () => {
    await mount('tab')
    const filter = q('item-table-filter') as HTMLInputElement
    await fireEvent.update(filter, '5016')
    expect(q('item-table-count')!.textContent).toContain('1 of 2 rows')
    await fireEvent.keyDown(filter, { key: 'ArrowRight' })
    expect(useItemViewerStore().target!.itemId).toBe('tab')
  })

  it('an older version: the list says what it is, then its bytes are read; the selector moves between versions', async () => {
    await mount('rep', 1)
    expect(api.getInvestigationItemVersions).toHaveBeenCalledWith('inv-1', 'rep')
    expect(api.getInvestigationItemContent).toHaveBeenCalledTimes(1)
    expect(api.getInvestigationItemContent).toHaveBeenCalledWith('inv-1', 'rep', 1)
    expect((q('viewer-version') as HTMLSelectElement).value).toBe('1')
    expect(q('item-html')!.getAttribute('srcdoc')).toContain('first draft')

    await fireEvent.update(q('viewer-version')!, '2')
    await flushPromises()
    expect(useItemViewerStore().target).toEqual({ itemId: 'rep', version: null }) // the latest
    expect(q('item-html')!.getAttribute('srcdoc')).toContain('<h1>Relatório</h1>')
  })

  it('downloads under the uploaded name without reading twice; full screen asks the browser', async () => {
    await mount('rep')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    URL.createObjectURL = vi.fn(() => 'blob:x')
    await fireEvent.click(q('viewer-download')!)
    await flushPromises()
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe('relatorio.html')
    expect(api.getInvestigationItemContent).toHaveBeenCalledTimes(1)
    click.mockRestore()

    const fullscreen = vi.fn(async () => {})
    ;(HTMLElement.prototype as any).requestFullscreen = fullscreen
    await fireEvent.click(q('viewer-fullscreen')!)
    expect(fullscreen).toHaveBeenCalledTimes(1)
    expect(fullscreen.mock.instances[0]).toBe(q('item-viewer'))
  })

  it('a link for an item that is not in the case says so', async () => {
    await mount('gone')
    expect(q('viewer-title')!.textContent).toBe('Item not found')
    expect(api.getInvestigationItemContent).not.toHaveBeenCalled()
  })
})
