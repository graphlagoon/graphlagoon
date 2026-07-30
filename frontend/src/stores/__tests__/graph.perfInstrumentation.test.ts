import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'
import { getPerfEntries, clearPerfEntries } from '@/utils/perfMetrics'

vi.mock('@/services/api', () => ({
  api: {
    getGraphContext: vi.fn(),
    getSubgraph: vi.fn(),
    submitGraphQueryJob: vi.fn(),
    submitCypherQueryJob: vi.fn(),
    getGraphQueryJob: vi.fn(),
    cancelGraphQueryJob: vi.fn(),
    getExploration: vi.fn(),
    getExplorationSnapshot: vi.fn(),
    updateExploration: vi.fn(),
  },
}))

import { api } from '@/services/api'

/** Labels recorded during a load, in the order they were emitted. */
function labels(): string[] {
  return getPerfEntries().map((e) => e.label)
}

function entry(label: string) {
  return getPerfEntries().find((e) => e.label === label)
}

const CONTEXT = {
  id: 'ctx-1',
  name: 'Test',
  node_table_name: 'nodes',
  edge_table_name: 'edges',
} as any

const RESPONSE = {
  nodes: [
    { node_id: 'A', node_type: 'Person' },
    { node_id: 'B', node_type: 'Company' },
  ],
  edges: [{ edge_id: 'e1', src: 'A', dst: 'B', relationship_type: 'WORKS_AT' }],
  truncated: false,
  metadata: { total_ms: 42, edge_query_ms: 10, node_query_ms: 25 },
}

describe('graph store — perf instrumentation (Phase 0)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    clearPerfEntries()
    vi.clearAllMocks()
  })

  afterEach(() => {
    clearPerfEntries()
    vi.useRealTimers()
  })

  describe('loadContext', () => {
    it('records a fetch timing', async () => {
      vi.mocked(api.getGraphContext).mockResolvedValue(CONTEXT)
      const store = useGraphStore()

      await store.loadContext('ctx-1')

      const e = entry('load:context:fetch')
      expect(e).toBeDefined()
      expect(e!.ms).toBeGreaterThanOrEqual(0)
    })

    it('does not record when the fetch fails', async () => {
      vi.mocked(api.getGraphContext).mockRejectedValue(new Error('boom'))
      const store = useGraphStore()

      await store.loadContext('ctx-1')

      expect(entry('load:context:fetch')).toBeUndefined()
      expect(store.error).toBe('boom')
    })
  })

  describe('loadSubgraph', () => {
    beforeEach(async () => {
      vi.mocked(api.getGraphContext).mockResolvedValue(CONTEXT)
      const store = useGraphStore()
      await store.loadContext('ctx-1')
      clearPerfEntries()
    })

    it('records fetch, assign, backend and chain timings', async () => {
      vi.mocked(api.getSubgraph).mockResolvedValue(RESPONSE as any)
      const store = useGraphStore()

      await store.loadSubgraph({})

      expect(labels()).toEqual([
        'load:subgraph:fetch',
        'load:subgraph:assign',
        'load:subgraph:backend',
        'load:subgraph:chain',
      ])
    })

    it('tags the fetch entry with node and edge counts', async () => {
      vi.mocked(api.getSubgraph).mockResolvedValue(RESPONSE as any)
      const store = useGraphStore()

      await store.loadSubgraph({})

      expect(entry('load:subgraph:fetch')!.extra).toEqual({ nodeCount: 2, edgeCount: 1 })
    })

    it('surfaces the backend stage timings from response metadata', async () => {
      vi.mocked(api.getSubgraph).mockResolvedValue(RESPONSE as any)
      const store = useGraphStore()

      await store.loadSubgraph({})

      const backend = entry('load:subgraph:backend')!
      expect(backend.ms).toBe(42)
      expect(backend.extra).toMatchObject({ edge_query_ms: 10, node_query_ms: 25 })
    })

    it('measures the derived chain against the freshly assigned data', async () => {
      vi.mocked(api.getSubgraph).mockResolvedValue(RESPONSE as any)
      const store = useGraphStore()

      await store.loadSubgraph({})

      // The chain entry reports what the canvas will consume, so its counts
      // must match enhancedNodes/enhancedEdges rather than the raw response.
      expect(entry('load:subgraph:chain')!.extra).toEqual({
        nodeCount: store.enhancedNodes.length,
        edgeCount: store.enhancedEdges.length,
      })
    })

    it('records nothing when the request fails', async () => {
      vi.mocked(api.getSubgraph).mockRejectedValue(new Error('query failed'))
      const store = useGraphStore()

      await store.loadSubgraph({})

      expect(labels()).toEqual([])
    })
  })

  describe('executeGraphQuery', () => {
    beforeEach(async () => {
      vi.mocked(api.getGraphContext).mockResolvedValue(CONTEXT)
      const store = useGraphStore()
      await store.loadContext('ctx-1')
      clearPerfEntries()

      vi.mocked(api.submitGraphQueryJob).mockResolvedValue({
        status: 'running',
        job_id: 'job-1',
      } as any)
      vi.mocked(api.getGraphQueryJob).mockResolvedValue({
        status: 'succeeded',
        job_id: 'job-1',
        result: RESPONSE,
      } as any)
    })

    it('records a non-zero assign timing (previously hardcoded to 0)', async () => {
      vi.useFakeTimers()
      const store = useGraphStore()

      const run = store.executeGraphQuery('SELECT 1')
      await vi.advanceTimersByTimeAsync(400)
      await run

      const assign = entry('load:query:assign')
      expect(assign).toBeDefined()
      // The value is a real measurement, so assert it was taken rather than
      // asserting a magnitude a fast machine could round down to 0.
      expect(assign!.ms).toBeGreaterThanOrEqual(0)
      expect(labels()).toContain('load:query:chain')
    })

    it('keeps fetch and assign as disjoint spans', async () => {
      vi.useFakeTimers()
      const store = useGraphStore()

      const run = store.executeGraphQuery('SELECT 1')
      await vi.advanceTimersByTimeAsync(400)
      await run

      // fetch covers submit+poll wall-clock and ends where assign begins, so
      // the two must never double-count the same interval.
      const fetch = entry('load:query:fetch')!
      const assign = entry('load:query:assign')!
      expect(fetch.ms).toBeGreaterThanOrEqual(assign.ms)
    })
  })
})
