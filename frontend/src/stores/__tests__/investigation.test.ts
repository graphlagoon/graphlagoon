import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useInvestigationStore } from '@/stores/investigation'

vi.mock('@/services/api', () => ({
  api: {
    getInvestigations: vi.fn(),
    getInvestigation: vi.fn(),
    getInvestigationSources: vi.fn(),
    createInvestigation: vi.fn(),
    addInvestigationSource: vi.fn(),
  },
}))

import { api } from '@/services/api'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('investigation store', () => {
  it('adds explorations one by one and reports a partial failure', async () => {
    vi.mocked(api.getInvestigation).mockResolvedValue({ id: 'inv1' } as any)
    vi.mocked(api.getInvestigationSources).mockResolvedValue([])
    vi.mocked(api.getInvestigations).mockResolvedValue([{ id: 'inv1', source_count: 1 }] as any)
    vi.mocked(api.addInvestigationSource)
      .mockResolvedValueOnce({ id: 's1' } as any)
      .mockRejectedValueOnce({ response: { data: { detail: 'No access to context' } } })

    const store = useInvestigationStore()
    await store.fetchInvestigations()
    await store.openInvestigation('inv1')
    const result = await store.addExplorations('inv1', ['e1', 'e2', 'e3'], 'frozen')

    expect(result.added).toBe(1)
    expect(result.error).toContain('No access')
    expect(api.addInvestigationSource).toHaveBeenCalledTimes(2) // stops at the failure
    expect(api.addInvestigationSource).toHaveBeenCalledWith('inv1', 'e1', 'frozen')
    expect(store.sources.map((s) => s.id)).toEqual(['s1'])
    expect(store.investigations[0].source_count).toBe(2)
  })

  it('a failed open clears the case and keeps the error', async () => {
    vi.mocked(api.getInvestigation).mockRejectedValue(new Error('404'))
    vi.mocked(api.getInvestigationSources).mockResolvedValue([])
    const store = useInvestigationStore()
    await store.openInvestigation('missing')
    expect(store.current).toBeNull()
    expect(store.error).toBeTruthy()
  })
})
