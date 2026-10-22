import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ItemDetails from '@/components/investigation/ItemDetails.vue'
import { useInvestigationStore } from '@/stores/investigation'

const api = vi.hoisted(() => ({
  updateInvestigationItem: vi.fn(async (_i: string, id: string, patch: Record<string, unknown>) => ({ ...ITEM, id, ...patch })),
  getInvestigationItemVersions: vi.fn(async () => [
    { version: 1, sha256: 'a'.repeat(64), created_by: 'ana@x.com', author_kind: 'human', content_type: 'text/markdown', size_bytes: 10 },
    { version: 2, sha256: 'b'.repeat(64), created_by: 'ana@x.com', author_kind: 'human', content_type: 'text/markdown', size_bytes: 12, pinned_at: '2026-10-09T12:00:00', pinned_by: 'ana@x.com', pin_label: 'sent' },
  ]),
  pinInvestigationItem: vi.fn(async () => ({ version: 1, sha256: 'a'.repeat(64) })),
  getInvestigationItems: vi.fn(async () => []),
  getInvestigationEvents: vi.fn(async () => []),
  getInvestigationItemContent: vi.fn(async () => new TextEncoder().encode('# Old text').buffer),
  addInvestigationItemVersion: vi.fn(async () => ({ ...ITEM, current_version: 3 })),
  reopenInvestigationItem: vi.fn(async () => ({ ...ITEM, status: 'suggested' })),
}))
vi.mock('@/services/api', () => ({ api }))

const ITEM = vi.hoisted(() => ({
  id: 'd1', kind: 'document', subkind: 'markdown', title: 'Memo', description: 'old', tags: ['dossier', 'ring'], status: 'confirmed',
  author_kind: 'human', author_email: 'ana@x.com', provenance: {}, current_version: 2, position: 0, accessible: true, pinned: [], created_at: '2026-10-01',
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  const store = useInvestigationStore()
  store.current = { id: 'inv', has_write_access: true, status: 'analysis' } as any
  store.items = [structuredClone(ITEM), { ...structuredClone(ITEM), id: 'd2', title: 'Second', position: 1 }] as any
})

describe('ItemDetails (UX-1)', () => {
  it('edits title, description and tags (keeping the dossier flag) and moves the item', async () => {
    const { getByTestId } = render(ItemDetails, { props: { item: useInvestigationStore().items[0], canEdit: true } })
    expect((getByTestId('item-move-up') as HTMLButtonElement).disabled).toBe(true)
    await fireEvent.click(getByTestId('item-edit'))
    expect((getByTestId('item-edit-tags') as HTMLInputElement).value).toBe('ring')
    await fireEvent.update(getByTestId('item-edit-title'), 'Ring memo')
    await fireEvent.update(getByTestId('item-edit-tags'), 'ring, final')
    await fireEvent.click(getByTestId('item-edit-save'))
    await flushPromises()
    expect(api.updateInvestigationItem).toHaveBeenCalledWith('inv', 'd1', { title: 'Ring memo', description: 'old', tags: ['ring', 'final', 'dossier'] })

    await fireEvent.click(getByTestId('item-move-down'))
    await flushPromises()
    expect(api.updateInvestigationItem).toHaveBeenCalledWith('inv', 'd1', { position: 1 })
    expect(api.updateInvestigationItem).toHaveBeenCalledWith('inv', 'd2', { position: 0 })
  })

  it('lists the versions, pins an older one with a label, and saves edited text as a new version', async () => {
    const { getByTestId, queryByTestId } = render(ItemDetails, { props: { item: useInvestigationStore().items[0], canEdit: true } })
    await fireEvent.click(getByTestId('item-versions-toggle'))
    await flushPromises()
    expect(getByTestId('item-version-2').textContent).toContain('sent')
    expect(queryByTestId('item-version-pin-2')).toBeNull() // already pinned
    await fireEvent.click(getByTestId('item-version-pin-1'))
    await fireEvent.update(getByTestId('item-version-pin-label-1'), 'first draft')
    await fireEvent.click(getByTestId('item-version-pin-save-1'))
    await flushPromises()
    expect(api.pinInvestigationItem).toHaveBeenCalledWith('inv', 'd1', { version: 1, label: 'first draft' })

    await fireEvent.click(getByTestId('item-edit-text'))
    await flushPromises()
    expect((getByTestId('item-text-input') as HTMLTextAreaElement).value).toBe('# Old text')
    await fireEvent.update(getByTestId('item-text-input'), '# New text')
    await fireEvent.click(getByTestId('item-text-save'))
    await flushPromises()
    expect(api.addInvestigationItemVersion).toHaveBeenCalledWith('inv', 'd1', { content: '# New text' })
  })

  it('a rejected suggestion can be reopened; a reader sees no edit', async () => {
    const store = useInvestigationStore()
    store.items[0] = { ...store.items[0], status: 'rejected' } as any
    const writer = render(ItemDetails, { props: { item: store.items[0], canEdit: true } })
    await fireEvent.click(writer.getByTestId('item-reopen'))
    await flushPromises()
    expect(api.reopenInvestigationItem).toHaveBeenCalledWith('inv', 'd1')
    writer.unmount()
    const reader = render(ItemDetails, { props: { item: store.items[0], canEdit: false } })
    expect(reader.queryByTestId('item-edit')).toBeNull()
    expect(reader.queryByTestId('item-reopen')).toBeNull()
  })
})
