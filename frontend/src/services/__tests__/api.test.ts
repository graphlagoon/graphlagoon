import { describe, it, expect, beforeEach, vi } from 'vitest'
import axios from 'axios'

vi.mock('axios', () => {
  const mockInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  }
  return {
    default: {
      create: vi.fn(() => mockInstance),
    },
  }
})

import { api } from '@/services/api'

// Get the mock axios instance
const mockClient = vi.mocked(axios.create)()

describe('ApiService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('devMode', () => {
    it('reads from window config when available', () => {
      window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true }
      expect(api.devMode).toBe(true)
      window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: false }
      expect(api.devMode).toBe(false)
    })
  })

  describe('GraphContext CRUD', () => {
    it('getGraphContexts calls GET /api/graph-contexts', async () => {
      const data = [{ id: 'ctx-1', title: 'Test' }]
      vi.mocked(mockClient.get).mockResolvedValue({ data })
      const result = await api.getGraphContexts()
      expect(mockClient.get).toHaveBeenCalledWith('/api/graph-contexts')
      expect(result).toEqual(data)
    })

    it('getGraphContext calls GET /api/graph-contexts/:id', async () => {
      const data = { id: 'ctx-1', title: 'Test' }
      vi.mocked(mockClient.get).mockResolvedValue({ data })
      const result = await api.getGraphContext('ctx-1')
      expect(mockClient.get).toHaveBeenCalledWith('/api/graph-contexts/ctx-1')
      expect(result).toEqual(data)
    })

    it('createGraphContext calls POST /api/graph-contexts', async () => {
      const body = { title: 'New', edge_table_name: 'e', node_table_name: 'n' }
      const data = { id: 'ctx-new', ...body }
      vi.mocked(mockClient.post).mockResolvedValue({ data })
      const result = await api.createGraphContext(body as any)
      expect(mockClient.post).toHaveBeenCalledWith('/api/graph-contexts', body)
      expect(result.id).toBe('ctx-new')
    })

    it('updateGraphContext calls PUT /api/graph-contexts/:id', async () => {
      const body = { title: 'Updated' }
      const data = { id: 'ctx-1', title: 'Updated' }
      vi.mocked(mockClient.put).mockResolvedValue({ data })
      const result = await api.updateGraphContext('ctx-1', body)
      expect(mockClient.put).toHaveBeenCalledWith('/api/graph-contexts/ctx-1', body)
      expect(result.title).toBe('Updated')
    })

    it('deleteGraphContext calls DELETE /api/graph-contexts/:id', async () => {
      vi.mocked(mockClient.delete).mockResolvedValue({})
      await api.deleteGraphContext('ctx-1')
      expect(mockClient.delete).toHaveBeenCalledWith('/api/graph-contexts/ctx-1')
    })
  })

  describe('Sharing', () => {
    it('shareGraphContext calls POST /api/graph-contexts/:id/share', async () => {
      vi.mocked(mockClient.post).mockResolvedValue({})
      await api.shareGraphContext('ctx-1', { email: 'a@b.com', permission: 'read' })
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/graph-contexts/ctx-1/share',
        { email: 'a@b.com', permission: 'read' }
      )
    })

    it('unshareGraphContext calls DELETE /api/graph-contexts/:id/share/:email', async () => {
      vi.mocked(mockClient.delete).mockResolvedValue({})
      await api.unshareGraphContext('ctx-1', 'a@b.com')
      expect(mockClient.delete).toHaveBeenCalledWith('/api/graph-contexts/ctx-1/share/a@b.com')
    })
  })

  describe('Exploration CRUD', () => {
    it('getAllExplorations calls GET /api/explorations', async () => {
      const data = [{ id: 'exp-1' }]
      vi.mocked(mockClient.get).mockResolvedValue({ data })
      const result = await api.getAllExplorations()
      expect(mockClient.get).toHaveBeenCalledWith('/api/explorations')
      expect(result).toEqual(data)
    })

    it('getExplorations calls GET /api/graph-contexts/:id/explorations', async () => {
      const data = [{ id: 'exp-1' }]
      vi.mocked(mockClient.get).mockResolvedValue({ data })
      const result = await api.getExplorations('ctx-1')
      expect(mockClient.get).toHaveBeenCalledWith('/api/graph-contexts/ctx-1/explorations')
      expect(result).toEqual(data)
    })

    it('getExploration calls GET /api/explorations/:id', async () => {
      const data = { id: 'exp-1', title: 'Exp' }
      vi.mocked(mockClient.get).mockResolvedValue({ data })
      const result = await api.getExploration('exp-1')
      expect(mockClient.get).toHaveBeenCalledWith('/api/explorations/exp-1')
      expect(result).toEqual(data)
    })

    it('createExploration calls POST /api/graph-contexts/:id/explorations', async () => {
      const body = { title: 'New Exp', state: {} as any }
      const data = { id: 'exp-new', ...body }
      vi.mocked(mockClient.post).mockResolvedValue({ data })
      const result = await api.createExploration('ctx-1', body)
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/graph-contexts/ctx-1/explorations',
        body
      )
      expect(result.id).toBe('exp-new')
    })

    it('updateExploration calls PUT /api/explorations/:id', async () => {
      const body = { title: 'Updated' }
      const data = { id: 'exp-1', title: 'Updated' }
      vi.mocked(mockClient.put).mockResolvedValue({ data })
      const result = await api.updateExploration('exp-1', body)
      expect(mockClient.put).toHaveBeenCalledWith('/api/explorations/exp-1', body)
      expect(result.title).toBe('Updated')
    })

    it('deleteExploration calls DELETE /api/explorations/:id', async () => {
      vi.mocked(mockClient.delete).mockResolvedValue({})
      await api.deleteExploration('exp-1')
      expect(mockClient.delete).toHaveBeenCalledWith('/api/explorations/exp-1')
    })
  })

  describe('Graph Data', () => {
    it('getSubgraph calls POST /api/graph-contexts/:id/subgraph', async () => {
      const request = { edge_limit: 500 }
      const data = { nodes: [], edges: [], truncated: false }
      vi.mocked(mockClient.post).mockResolvedValue({ data })
      const result = await api.getSubgraph('ctx-1', request as any)
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/graph-contexts/ctx-1/subgraph',
        request
      )
      expect(result).toEqual(data)
    })

    it('expandFromNode calls POST /api/graph-contexts/:id/expand', async () => {
      const request = { node_id: 'n1', depth: 2 }
      const data = { nodes: [], edges: [], truncated: false }
      vi.mocked(mockClient.post).mockResolvedValue({ data })
      const result = await api.expandFromNode('ctx-1', request as any)
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/graph-contexts/ctx-1/expand',
        request
      )
      expect(result).toEqual(data)
    })

    it('executeGraphQuery calls POST /api/graph-contexts/:id/query', async () => {
      const request = { query: 'SELECT * FROM edges' }
      const data = { nodes: [], edges: [], truncated: false }
      vi.mocked(mockClient.post).mockResolvedValue({ data })
      const result = await api.executeGraphQuery('ctx-1', request as any)
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/graph-contexts/ctx-1/query',
        request
      )
      expect(result).toEqual(data)
    })

    it('executeCypherQuery calls POST /api/graph-contexts/:id/cypher', async () => {
      const request = { query: 'MATCH (n) RETURN n' }
      const data = { nodes: [], edges: [], truncated: false, transpiled_sql: 'SELECT...' }
      vi.mocked(mockClient.post).mockResolvedValue({ data })
      const result = await api.executeCypherQuery('ctx-1', request as any)
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/graph-contexts/ctx-1/cypher',
        request
      )
      expect(result).toEqual(data)
    })

    it('transpileCypher calls POST /api/graph-contexts/:id/cypher/transpile', async () => {
      const request = { query: 'MATCH (n) RETURN n' }
      const data = { transpiled_sql: 'SELECT...' }
      vi.mocked(mockClient.post).mockResolvedValue({ data })
      const result = await api.transpileCypher('ctx-1', request as any)
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/graph-contexts/ctx-1/cypher/transpile',
        request
      )
      expect(result).toEqual(data)
    })
  })
})
