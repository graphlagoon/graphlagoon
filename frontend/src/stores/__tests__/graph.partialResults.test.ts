/**
 * Phase 3: partial results on the query path.
 *
 * Running a query used to show nothing until the whole job finished — on a
 * 100-column table that is ~8s of spinner. The backend now publishes a
 * renderable intermediate (edges + nodes with structural columns only) and the
 * poller draws it, measured at ~4.6s instead of ~10.4s.
 *
 * The subtle part is what happens when the FULL result lands afterwards: if it
 * covers the same nodes, replacing the arrays would discard the rendered scene
 * and reheat the layout, making the graph visibly jump for no reason. These
 * tests pin the patch-instead-of-replace behaviour.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'
import { clearPerfEntries } from '@/utils/perfMetrics'

vi.mock('@/services/api', () => ({
  api: {
    getGraphContext: vi.fn(),
    getSubgraph: vi.fn(),
    getNodesBatch: vi.fn(),
    submitGraphQueryJob: vi.fn(),
    submitCypherQueryJob: vi.fn(),
    getGraphQueryJob: vi.fn(),
    cancelGraphQueryJob: vi.fn(),
    getExploration: vi.fn(),
  },
}))

import { api } from '@/services/api'

function typedNodes() {
  return [
    { node_id: 'n1', node_type: 'Person' },
    { node_id: 'n2', node_type: 'Company' },
  ]
}

function fullNodes() {
  return [
    { node_id: 'n1', node_type: 'Person', properties: { name: 'Alice' } },
    { node_id: 'n2', node_type: 'Company', properties: { name: 'Acme' } },
  ]
}

const EDGES = [{ edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'WORKS_AT' }]

/**
 * Drive the job machine through: running (no partial) → running (partial) →
 * succeeded (full result). Mirrors what the poller really sees.
 */
function mockJobWithPartial(finalNodes: any[], partialNodes: any[] = typedNodes()) {
  vi.mocked(api.submitGraphQueryJob).mockResolvedValue({
    status: 'running',
    job_id: 'job-1',
  } as any)
  vi.mocked(api.submitCypherQueryJob).mockResolvedValue({
    status: 'running',
    job_id: 'job-1',
  } as any)

  let call = 0
  vi.mocked(api.getGraphQueryJob).mockImplementation(async () => {
    call += 1
    if (call === 1) return { status: 'running', job_id: 'job-1', partial_seq: 0 } as any
    if (call <= 3) {
      return {
        status: 'running',
        job_id: 'job-1',
        partial: { nodes: partialNodes, edges: EDGES, truncated: false, properties_deferred: true },
        partial_seq: 1,
      } as any
    }
    return {
      status: 'succeeded',
      job_id: 'job-1',
      result: { nodes: finalNodes, edges: EDGES, truncated: false },
      partial_seq: 1,
    } as any
  })
}

async function runQuery(store: ReturnType<typeof useGraphStore>) {
  const p = store.executeGraphQuery('SELECT 1')
  // First poll is 300ms, then 1200ms apart.
  await vi.advanceTimersByTimeAsync(5000)
  await p
}

describe('partial results on the query path', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    clearPerfEntries()
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    clearPerfEntries()
  })

  it('draws the partial before the job finishes', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    mockJobWithPartial(fullNodes())

    const p = store.executeGraphQuery('SELECT 1')
    // Enough polls for the partial, not enough for the final result.
    await vi.advanceTimersByTimeAsync(1600)

    expect(store.nodes).toHaveLength(2)
    expect(store.nodes[0].properties).toBeUndefined()
    expect(store.edges).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(5000)
    await p
  })

  it('patches properties in when the full result covers the same nodes', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    mockJobWithPartial(fullNodes())

    await runQuery(store)

    expect(store.nodes.find((n) => n.node_id === 'n1')!.properties).toEqual({
      name: 'Alice',
    })
  })

  it('does NOT reheat the layout when the final result matches the partial', async () => {
    // This is the whole reason applyGraphResponse exists: re-flagging a fresh
    // layout here would make the already-drawn graph jump.
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    mockJobWithPartial(fullNodes())

    const p = store.executeGraphQuery('SELECT 1')
    await vi.advanceTimersByTimeAsync(1600)
    // The partial legitimately requests a fresh layout — clear it, then check
    // the FINAL apply does not set it again.
    store.freshLayoutRequested = false
    await vi.advanceTimersByTimeAsync(5000)
    await p

    expect(store.freshLayoutRequested).toBe(false)
  })

  it('preserves node array identity across the final apply', async () => {
    // Identity is what keeps the community/similarity watchers from wiping
    // their state, and the canvas from rebuilding the scene.
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    mockJobWithPartial(fullNodes())

    const p = store.executeGraphQuery('SELECT 1')
    await vi.advanceTimersByTimeAsync(1600)
    const afterPartial = store.nodes
    await vi.advanceTimersByTimeAsync(5000)
    await p

    expect(store.nodes).toBe(afterPartial)
  })

  it('replaces wholesale when the final result has different nodes', async () => {
    // A query whose node set changed between partial and final must not be
    // patched — the partial's nodes are simply wrong.
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    mockJobWithPartial([
      { node_id: 'n9', node_type: 'Other', properties: { name: 'New' } },
    ])

    const p = store.executeGraphQuery('SELECT 1')
    await vi.advanceTimersByTimeAsync(1600)
    store.freshLayoutRequested = false
    await vi.advanceTimersByTimeAsync(5000)
    await p

    expect(store.nodes.map((n) => n.node_id)).toEqual(['n9'])
    expect(store.freshLayoutRequested).toBe(true)
  })

  it('applies a partial only once even though it rides on every poll', async () => {
    // The same partial is echoed by each subsequent poll; re-applying it would
    // redo the graph rebuild for nothing.
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    mockJobWithPartial(fullNodes())

    const p = store.executeGraphQuery('SELECT 1')
    await vi.advanceTimersByTimeAsync(1600)
    const versionAfterFirstPartial = store.nodePatchVersion
    await vi.advanceTimersByTimeAsync(1300) // another poll, same partial_seq
    // A re-applied partial would replace the arrays, not patch — so the patch
    // counter must not move for the repeated partial.
    expect(store.nodePatchVersion).toBe(versionAfterFirstPartial)

    await vi.advanceTimersByTimeAsync(5000)
    await p
  })

  it('works the same on the Cypher path', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    mockJobWithPartial(fullNodes())

    const p = store.executeCypherQuery('MATCH (a)-[r]->(b) RETURN r')
    await vi.advanceTimersByTimeAsync(1600)
    expect(store.nodes).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(5000)
    await p
    expect(store.nodes.find((n) => n.node_id === 'n1')!.properties).toEqual({
      name: 'Alice',
    })
  })

  describe('truncation reporting', () => {
    // A truncated graph looks exactly like a complete one, so the flag is the
    // only thing telling the user their conclusions rest on a partial view.

    it('surfaces truncated from the query result', async () => {
      const store = useGraphStore()
      store.currentContext = { id: 'ctx-1' } as any
      vi.mocked(api.submitGraphQueryJob).mockResolvedValue({
        status: 'running',
        job_id: 'job-1',
      } as any)
      vi.mocked(api.getGraphQueryJob).mockResolvedValue({
        status: 'succeeded',
        job_id: 'job-1',
        result: { nodes: fullNodes(), edges: EDGES, truncated: true },
      } as any)

      await runQuery(store)

      expect(store.truncated).toBe(true)
    })

    it('clears the flag when a later result is complete', async () => {
      // Stale truncation warnings are worse than none: the user would distrust
      // a graph that is actually whole.
      const store = useGraphStore()
      store.currentContext = { id: 'ctx-1' } as any
      vi.mocked(api.submitGraphQueryJob).mockResolvedValue({
        status: 'running',
        job_id: 'job-1',
      } as any)
      vi.mocked(api.getGraphQueryJob).mockResolvedValue({
        status: 'succeeded',
        job_id: 'job-1',
        result: { nodes: fullNodes(), edges: EDGES, truncated: true },
      } as any)
      await runQuery(store)
      expect(store.truncated).toBe(true)

      vi.mocked(api.getGraphQueryJob).mockResolvedValue({
        status: 'succeeded',
        job_id: 'job-1',
        result: { nodes: fullNodes(), edges: EDGES, truncated: false },
      } as any)
      await runQuery(store)

      expect(store.truncated).toBe(false)
    })

    it('carries truncation through a partial', async () => {
      const store = useGraphStore()
      store.currentContext = { id: 'ctx-1' } as any
      vi.mocked(api.submitGraphQueryJob).mockResolvedValue({
        status: 'running',
        job_id: 'job-1',
      } as any)
      let call = 0
      vi.mocked(api.getGraphQueryJob).mockImplementation(async () => {
        call += 1
        if (call <= 2) {
          return {
            status: 'running',
            job_id: 'job-1',
            partial: {
              nodes: typedNodes(),
              edges: EDGES,
              truncated: true,
              properties_deferred: true,
            },
            partial_seq: 1,
          } as any
        }
        return {
          status: 'succeeded',
          job_id: 'job-1',
          result: { nodes: fullNodes(), edges: EDGES, truncated: true },
          partial_seq: 1,
        } as any
      })

      const p = store.executeGraphQuery('SELECT 1')
      await vi.advanceTimersByTimeAsync(1600)
      // The warning must be up as soon as the partial is drawn, not only at
      // the end — the user is already reading the graph.
      expect(store.truncated).toBe(true)

      await vi.advanceTimersByTimeAsync(5000)
      await p
      expect(store.truncated).toBe(true)
    })

    it('clear() resets the flag', async () => {
      const store = useGraphStore()
      store.currentContext = { id: 'ctx-1' } as any
      vi.mocked(api.submitGraphQueryJob).mockResolvedValue({
        status: 'running',
        job_id: 'job-1',
      } as any)
      vi.mocked(api.getGraphQueryJob).mockResolvedValue({
        status: 'succeeded',
        job_id: 'job-1',
        result: { nodes: fullNodes(), edges: EDGES, truncated: true },
      } as any)
      await runQuery(store)

      store.clear()

      expect(store.truncated).toBe(false)
    })
  })

  it('a job that never publishes a partial still works', async () => {
    // Backwards compatibility: an older backend sends no partial at all.
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    vi.mocked(api.submitGraphQueryJob).mockResolvedValue({
      status: 'running',
      job_id: 'job-1',
    } as any)
    vi.mocked(api.getGraphQueryJob).mockResolvedValue({
      status: 'succeeded',
      job_id: 'job-1',
      result: { nodes: fullNodes(), edges: EDGES, truncated: false },
    } as any)

    await runQuery(store)

    expect(store.nodes).toHaveLength(2)
    expect(store.nodes[0].properties).toEqual({ name: 'Alice' })
    expect(store.freshLayoutRequested).toBe(true)
  })
})
