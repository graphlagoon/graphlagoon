import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useContextsStore } from '@/stores/contexts'

vi.mock('@/services/api', () => ({
  api: {
    getGraphContexts: vi.fn(),
    getDatasets: vi.fn(),
    createGraphContext: vi.fn(),
    updateGraphContext: vi.fn(),
    deleteGraphContext: vi.fn(),
    shareGraphContext: vi.fn(),
    createRandomGraph: vi.fn(),
  },
}))

import { api } from '@/services/api'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('contexts store', () => {
  describe('fetchContexts', () => {
    it('loads contexts from API', async () => {
      const contexts = [
        { id: 'c1', title: 'Graph A', owner_email: 'a@test.com' },
        { id: 'c2', title: 'Graph B', owner_email: 'b@test.com' },
      ]
      vi.mocked(api.getGraphContexts).mockResolvedValue(contexts as any)

      const store = useContextsStore()
      await store.fetchContexts()

      expect(store.contexts).toEqual(contexts)
      expect(store.loading).toBe(false)
      expect(store.error).toBeNull()
    })

    it('sets error on fetch failure', async () => {
      vi.mocked(api.getGraphContexts).mockRejectedValue(new Error('Network error'))

      const store = useContextsStore()
      await store.fetchContexts()

      expect(store.contexts).toEqual([])
      expect(store.error).toBe('Network error')
      expect(store.loading).toBe(false)
    })

    it('sets loading during fetch', async () => {
      let resolvePromise: (v: any) => void
      vi.mocked(api.getGraphContexts).mockReturnValue(
        new Promise(resolve => { resolvePromise = resolve })
      )

      const store = useContextsStore()
      const promise = store.fetchContexts()
      expect(store.loading).toBe(true)

      resolvePromise!([])
      await promise
      expect(store.loading).toBe(false)
    })
  })

  describe('fetchDatasets', () => {
    it('loads datasets from API', async () => {
      const datasets = { edge_tables: ['t1'], node_tables: ['t2'] }
      vi.mocked(api.getDatasets).mockResolvedValue(datasets as any)

      const store = useContextsStore()
      await store.fetchDatasets()

      expect(store.datasets).toEqual(datasets)
    })

    it('sets error on failure', async () => {
      vi.mocked(api.getDatasets).mockRejectedValue(new Error('Failed'))

      const store = useContextsStore()
      await store.fetchDatasets()

      expect(store.error).toBe('Failed')
    })
  })

  describe('createContext', () => {
    it('creates context and adds to front of list', async () => {
      const newCtx = { id: 'new', title: 'New Graph', owner_email: 'me@test.com' }
      vi.mocked(api.createGraphContext).mockResolvedValue(newCtx as any)

      const store = useContextsStore()
      store.contexts = [{ id: 'old', title: 'Old' } as any]

      const result = await store.createContext({ title: 'New Graph' } as any)

      expect(result).toEqual(newCtx)
      expect(store.contexts[0]).toEqual(newCtx)
      expect(store.contexts).toHaveLength(2)
    })

    it('throws and sets error on failure', async () => {
      vi.mocked(api.createGraphContext).mockRejectedValue(new Error('Duplicate'))

      const store = useContextsStore()
      await expect(store.createContext({} as any)).rejects.toThrow('Duplicate')
      expect(store.error).toBe('Duplicate')
    })
  })

  describe('updateContext', () => {
    it('updates context in list', async () => {
      const updated = { id: 'c1', title: 'Updated Title' }
      vi.mocked(api.updateGraphContext).mockResolvedValue(updated as any)

      const store = useContextsStore()
      store.contexts = [{ id: 'c1', title: 'Old Title' } as any]

      await store.updateContext('c1', { title: 'Updated Title' } as any)

      expect(store.contexts[0].title).toBe('Updated Title')
    })

    it('handles update when context not in list', async () => {
      const updated = { id: 'c999', title: 'New' }
      vi.mocked(api.updateGraphContext).mockResolvedValue(updated as any)

      const store = useContextsStore()
      store.contexts = [{ id: 'c1', title: 'Old' } as any]

      await store.updateContext('c999', {} as any)
      // Should not crash; list remains unchanged
      expect(store.contexts).toHaveLength(1)
      expect(store.contexts[0].id).toBe('c1')
    })
  })

  describe('deleteContext', () => {
    it('removes context from list', async () => {
      vi.mocked(api.deleteGraphContext).mockResolvedValue(undefined as any)

      const store = useContextsStore()
      store.contexts = [
        { id: 'c1', title: 'A' } as any,
        { id: 'c2', title: 'B' } as any,
      ]

      await store.deleteContext('c1')

      expect(store.contexts).toHaveLength(1)
      expect(store.contexts[0].id).toBe('c2')
    })

    it('throws on failure', async () => {
      vi.mocked(api.deleteGraphContext).mockRejectedValue(new Error('Not found'))

      const store = useContextsStore()
      await expect(store.deleteContext('bad')).rejects.toThrow('Not found')
      expect(store.error).toBe('Not found')
    })
  })

  describe('shareContext', () => {
    it('calls API and refreshes contexts', async () => {
      vi.mocked(api.shareGraphContext).mockResolvedValue(undefined as any)
      vi.mocked(api.getGraphContexts).mockResolvedValue([])

      const store = useContextsStore()
      await store.shareContext('c1', 'friend@test.com', 'read')

      expect(api.shareGraphContext).toHaveBeenCalledWith('c1', {
        email: 'friend@test.com',
        permission: 'read',
      })
      expect(api.getGraphContexts).toHaveBeenCalled()
    })
  })
})
