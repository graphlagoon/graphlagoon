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
      expect(mockClient.delete).toHaveBeenCalledWith('/api/graph-contexts/ctx-1/share/a%40b.com')
    })

    it('shareGraphContext with public sentinel posts email "*"', async () => {
      vi.mocked(mockClient.post).mockResolvedValue({})
      await api.shareGraphContext('ctx-1', { email: '*', permission: 'read' })
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/graph-contexts/ctx-1/share',
        { email: '*', permission: 'read' }
      )
    })

    it('unshareGraphContext keeps "*" intact in the path', async () => {
      vi.mocked(mockClient.delete).mockResolvedValue({})
      await api.unshareGraphContext('ctx-1', '*')
      expect(mockClient.delete).toHaveBeenCalledWith('/api/graph-contexts/ctx-1/share/*')
    })

    it('unshareExploration keeps "*" intact in the path', async () => {
      vi.mocked(mockClient.delete).mockResolvedValue({})
      await api.unshareExploration('exp-1', '*')
      expect(mockClient.delete).toHaveBeenCalledWith('/api/explorations/exp-1/share/*')
    })
  })

  describe('Precomputed graphs', () => {
    it('has no listing method — graphs are addressed by name', () => {
      // Enumerating entries is O(entries) and is the one operation that stops
      // working as the store grows, so the API deliberately does not offer it.
      expect(
        (api as unknown as Record<string, unknown>).listPrecomputedGraphs
      ).toBeUndefined()
    })

    it('getPrecomputedGraph calls GET /api/graph-contexts/:id/precomputed-graphs/:name', async () => {
      vi.mocked(mockClient.get).mockResolvedValue({ data: { name: 'c1' } })
      await api.getPrecomputedGraph('ctx-1', 'fraude-2024')
      expect(mockClient.get).toHaveBeenCalledWith(
        '/api/graph-contexts/ctx-1/precomputed-graphs/fraude-2024',
        undefined
      )
    })

    it('passes provider arguments through axios params, not the path', async () => {
      // A value holding & or # would silently corrupt a hand-built URL.
      vi.mocked(mockClient.get).mockResolvedValue({ data: { name: 'c1' } })
      await api.getPrecomputedGraph('ctx-1', 'vizinhanca', {
        seed: 'a&b#c',
        hops: '3',
      })
      expect(mockClient.get).toHaveBeenCalledWith(
        '/api/graph-contexts/ctx-1/precomputed-graphs/vizinhanca',
        { params: { seed: 'a&b#c', hops: '3' } }
      )
    })

    it('getPrecomputedGraphCapabilities calls GET on the collection URL', async () => {
      vi.mocked(mockClient.get).mockResolvedValue({ data: { can_write: false } })
      await api.getPrecomputedGraphCapabilities('ctx-1')
      expect(mockClient.get).toHaveBeenCalledWith(
        '/api/graph-contexts/ctx-1/precomputed-graphs'
      )
    })

    it('putPrecomputedGraph calls PUT with the graph and its source', async () => {
      vi.mocked(mockClient.put).mockResolvedValue({ data: { name: 'c1', size_bytes: 1 } })
      const body = {
        graph: { nodes: [], edges: [], truncated: false, properties_deferred: false },
        source: { kind: 'cypher' as const, query: 'MATCH (n) RETURN n' },
      }
      await api.putPrecomputedGraph('ctx-1', 'c1', body)
      expect(mockClient.put).toHaveBeenCalledWith(
        '/api/graph-contexts/ctx-1/precomputed-graphs/c1',
        body
      )
    })

    it('deletePrecomputedGraph calls DELETE /api/graph-contexts/:id/precomputed-graphs/:name', async () => {
      vi.mocked(mockClient.delete).mockResolvedValue({ data: null })
      await api.deletePrecomputedGraph('ctx-1', 'c1')
      expect(mockClient.delete).toHaveBeenCalledWith(
        '/api/graph-contexts/ctx-1/precomputed-graphs/c1'
      )
    })

    it('encodes a name with characters that would change the path', async () => {
      // The backend rejects such names anyway; encoding keeps a bad name from
      // silently becoming a different URL on the way there.
      vi.mocked(mockClient.get).mockResolvedValue({ data: {} })
      await api.getPrecomputedGraph('ctx-1', 'a b')
      expect(mockClient.get).toHaveBeenCalledWith(
        '/api/graph-contexts/ctx-1/precomputed-graphs/a%20b',
        undefined
      )
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

    it('executeTableQuery calls POST /api/graph-contexts/:id/query/table', async () => {
      const request = { query: 'MATCH (n) RETURN n.node_id', mode: 'cypher' as const }
      const data = {
        columns: ['node_id'],
        rows: [['a'], ['b']],
        row_count: 2,
        truncated: false,
        transpiled_sql: 'SELECT node_id ...',
      }
      vi.mocked(mockClient.post).mockResolvedValue({ data })
      const result = await api.executeTableQuery('ctx-1', request as any)
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/graph-contexts/ctx-1/query/table',
        request
      )
      expect(result).toEqual(data)
    })
  })
})
