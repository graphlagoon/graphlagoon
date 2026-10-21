import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useCurrentCaseStore, STORAGE_KEY, RECENT_KEY } from '@/stores/currentCase'

vi.mock('@/services/api', () => ({ api: { getInvestigation: vi.fn() } }))
import { api } from '@/services/api'

const inv = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  ({ id, title, status: 'analysis', has_write_access: true, tags: [], settings: {}, state: {}, shared_with: [], can_manage: true, owner_email: 'me', kind_preset: 'livre', ...extra }) as any

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('currentCase store', () => {
  it('persists the current case and keeps the five most recent', () => {
    const store = useCurrentCaseStore()
    expect(store.hasCase).toBe(false)
    for (let i = 1; i <= 6; i++) store.setCurrentCase(inv(`c${i}`, `Caso ${i}`))
    expect(store.caseId).toBe('c6')
    expect(store.shortId).toBe('#c6')
    expect(store.canAdd).toBe(true)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ id: 'c6', title: 'Caso 6' })
    expect(store.recentCases.map((r) => r.id)).toEqual(['c6', 'c5', 'c4', 'c3', 'c2'])
    expect(JSON.parse(localStorage.getItem(RECENT_KEY)!)).toHaveLength(5)
    store.setCurrentCase(inv('c3', 'Caso 3'))
    expect(store.recentCases.map((r) => r.id)).toEqual(['c3', 'c6', 'c5', 'c4', 'c2'])
  })

  it('validates the stored id on load: 404/403 clears it, a decided case cannot be added to', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: 'gone', title: 'Antigo' }))
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ id: 'gone', title: 'Antigo' }, { id: 'ok', title: 'Ok' }]))
    vi.mocked(api.getInvestigation).mockRejectedValueOnce({ response: { status: 404 } })
    const store = useCurrentCaseStore()
    expect(store.caseId).toBe('gone')
    expect(store.title).toBe('Antigo')
    await store.ensureLoaded()
    expect(store.caseId).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(store.recentCases.map((r) => r.id)).toEqual(['ok'])

    vi.mocked(api.getInvestigation).mockResolvedValueOnce(inv('ok', 'Ok renomeado', { status: 'closed' }))
    store.setCurrentCase({ id: 'ok', title: 'Ok' })
    await flushPromises()
    expect(store.title).toBe('Ok renomeado')
    expect(store.canAdd).toBe(false)
  })

  it('a network error keeps the chip (the case may still exist)', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: 'c1', title: 'Caso' }))
    vi.mocked(api.getInvestigation).mockRejectedValueOnce(new Error('offline'))
    const store = useCurrentCaseStore()
    await store.ensureLoaded()
    expect(store.caseId).toBe('c1')
  })
})
