/**
 * CTE fallback for failed procedural Cypher queries.
 *
 * The procedural BFS renderer is the default because it is faster, but it is
 * also younger — some queries it cannot yet transpile or that fail at
 * execution time still work fine as WITH RECURSIVE. When a procedural run
 * fails, the store retries it ONCE in CTE mode and warns the user, without
 * touching the saved transpile options. The toggle lives in the transpile
 * settings modal and defaults to ON.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'

const { warningSpy } = vi.hoisted(() => ({ warningSpy: vi.fn() }))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    toasts: { value: [] },
    show: vi.fn(),
    remove: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: warningSpy,
    error: vi.fn(),
  }),
}))

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
    transpileCypher: vi.fn(),
  },
}))

import { api } from '@/services/api'

const NODES = [
  { node_id: 'n1', node_type: 'Person', properties: { name: 'Alice' } },
  { node_id: 'n2', node_type: 'Company', properties: { name: 'Acme' } },
]
const EDGES = [{ edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'WORKS_AT' }]

/** Submits get sequential job ids; per-job poll outcome decides fail/succeed. */
function mockJobs(outcomes: Array<'fail' | 'succeed'>) {
  let submitN = 0
  vi.mocked(api.submitCypherQueryJob).mockImplementation(async () => {
    submitN += 1
    return {
      status: 'running',
      job_id: `job-${submitN}`,
      transpiled_sql: `SQL FOR job-${submitN}`,
    } as any
  })
  vi.mocked(api.getGraphQueryJob).mockImplementation(async (_ctx, jobId) => {
    const outcome = outcomes[Number(String(jobId).split('-')[1]) - 1]
    if (outcome === 'fail') throw new Error(`${jobId} blew up`)
    return {
      status: 'succeeded',
      job_id: jobId,
      result: { nodes: NODES, edges: EDGES, truncated: false },
    } as any
  })
}

async function runCypher(store: ReturnType<typeof useGraphStore>) {
  const p = store.executeCypherQuery('MATCH (a)-[r*1..3]->(b) RETURN r')
  await vi.advanceTimersByTimeAsync(10_000)
  return p
}

describe('CTE fallback on procedural query failure', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('defaults to enabled', () => {
    expect(useGraphStore().cteFallbackEnabled).toBe(true)
  })

  it('is silent by default — the fallback runs without any toasts', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    mockJobs(['fail', 'succeed'])

    await runCypher(store)

    expect(api.submitCypherQueryJob).toHaveBeenCalledTimes(2)
    expect(store.queryError).toBeNull()
    expect(warningSpy).not.toHaveBeenCalled()
  })

  it('retries a failed procedural run in CTE mode and warns (silent off)', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    store.cteFallbackSilent = false
    mockJobs(['fail', 'succeed'])

    const sql = await runCypher(store)

    expect(api.submitCypherQueryJob).toHaveBeenCalledTimes(2)
    const first = vi.mocked(api.submitCypherQueryJob).mock.calls[0][1]
    const second = vi.mocked(api.submitCypherQueryJob).mock.calls[1][1]
    expect(first.vlp_rendering_mode).toBe('procedural')
    expect(first.procedural_optimizations).toBeDefined()
    expect(second.vlp_rendering_mode).toBe('cte')
    // CTE mode takes no procedural flags — sending them would be rejected.
    expect(second.procedural_optimizations).toBeUndefined()

    // The fallback result landed and the failed first attempt left no error.
    expect(store.queryError).toBeNull()
    expect(store.nodes).toHaveLength(2)
    expect(sql).toBe('SQL FOR job-2')
    expect(warningSpy).toHaveBeenCalledTimes(2)
    expect(warningSpy.mock.calls[0][0]).toContain('retrying in CTE')
    expect(warningSpy.mock.calls[1][0]).toContain('CTE fallback')
  })

  it('keeps the stored rendering mode as procedural after a fallback', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    mockJobs(['fail', 'succeed'])

    await runCypher(store)

    expect(store.vlpRenderingMode).toBe('procedural')
  })

  it('surfaces the CTE error when the fallback also fails, retrying only once', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    store.cteFallbackSilent = false
    mockJobs(['fail', 'fail'])

    await runCypher(store)

    expect(api.submitCypherQueryJob).toHaveBeenCalledTimes(2)
    expect(store.queryError).not.toBeNull()
    expect(store.queryError!.message).toContain('job-2')
    // Warned about the retry, but no "result produced by fallback" toast.
    expect(warningSpy).toHaveBeenCalledTimes(1)
  })

  it('does not retry when the toggle is off', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    store.cteFallbackEnabled = false
    mockJobs(['fail', 'succeed'])

    await runCypher(store)

    expect(api.submitCypherQueryJob).toHaveBeenCalledTimes(1)
    expect(store.queryError).not.toBeNull()
    expect(warningSpy).not.toHaveBeenCalled()
  })

  it('does not retry when the query already ran in CTE mode', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    store.vlpRenderingMode = 'cte'
    mockJobs(['fail', 'succeed'])

    await runCypher(store)

    expect(api.submitCypherQueryJob).toHaveBeenCalledTimes(1)
    expect(store.queryError).not.toBeNull()
  })

  it('does not retry a successful procedural run', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    mockJobs(['succeed'])

    await runCypher(store)

    expect(api.submitCypherQueryJob).toHaveBeenCalledTimes(1)
    expect(warningSpy).not.toHaveBeenCalled()
  })

  it('retries when the SUBMIT itself fails (transpile error)', async () => {
    // A procedural transpile error surfaces at submit time, before any job
    // exists — the fallback must cover that path too, not just poll failures.
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    let submitN = 0
    vi.mocked(api.submitCypherQueryJob).mockImplementation(async () => {
      submitN += 1
      if (submitN === 1) throw new Error('procedural transpile failed')
      return { status: 'running', job_id: 'job-2', transpiled_sql: 'CTE SQL' } as any
    })
    vi.mocked(api.getGraphQueryJob).mockResolvedValue({
      status: 'succeeded',
      job_id: 'job-2',
      result: { nodes: NODES, edges: EDGES, truncated: false },
    } as any)

    const sql = await runCypher(store)

    expect(api.submitCypherQueryJob).toHaveBeenCalledTimes(2)
    expect(store.queryError).toBeNull()
    expect(sql).toBe('CTE SQL')
  })

  it('does not retry a cancelled query', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    vi.mocked(api.submitCypherQueryJob).mockResolvedValue({
      status: 'running',
      job_id: 'job-1',
    } as any)
    vi.mocked(api.cancelGraphQueryJob).mockResolvedValue(undefined as any)
    vi.mocked(api.getGraphQueryJob).mockResolvedValue({
      status: 'running',
      job_id: 'job-1',
    } as any)

    const p = store.executeCypherQuery('MATCH (a)-[r]->(b) RETURN r')
    await vi.advanceTimersByTimeAsync(1600)
    await store.cancelGraphQuery()
    await vi.advanceTimersByTimeAsync(2000)
    await p

    expect(api.submitCypherQueryJob).toHaveBeenCalledTimes(1)
    expect(warningSpy).not.toHaveBeenCalled()
  })
})

describe('CTE fallback on transpileCypher (the "Transpile to SQL" review flow)', () => {
  // The sidebar's review flow and template execution call transpileCypher and
  // run the returned SQL themselves — the fallback must cover the transpile
  // step there, or a procedural transpile error dead-ends the whole flow.

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('retries the transpile in CTE mode and returns the fallback SQL', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    store.cteFallbackSilent = false
    vi.mocked(api.transpileCypher)
      .mockRejectedValueOnce(new Error('procedural transpile failed'))
      .mockResolvedValueOnce({ transpiled_sql: 'CTE SQL' } as any)

    const sql = await store.transpileCypher('MATCH (a)-[r*1..3]->(b) RETURN r')

    expect(api.transpileCypher).toHaveBeenCalledTimes(2)
    const first = vi.mocked(api.transpileCypher).mock.calls[0][1]
    const second = vi.mocked(api.transpileCypher).mock.calls[1][1]
    expect(first.vlp_rendering_mode).toBe('procedural')
    expect(second.vlp_rendering_mode).toBe('cte')
    expect(second.procedural_optimizations).toBeUndefined()

    expect(sql).toBe('CTE SQL')
    expect(store.queryError).toBeNull()
    expect(store.lastTranspiledSql).toBe('CTE SQL')
    expect(warningSpy).toHaveBeenCalledTimes(2)
  })

  it('the transpile fallback is silent by default', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    vi.mocked(api.transpileCypher)
      .mockRejectedValueOnce(new Error('procedural transpile failed'))
      .mockResolvedValueOnce({ transpiled_sql: 'CTE SQL' } as any)

    const sql = await store.transpileCypher('MATCH (n) RETURN r')

    expect(sql).toBe('CTE SQL')
    expect(warningSpy).not.toHaveBeenCalled()
  })

  it('surfaces the CTE error when both transpiles fail', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    store.cteFallbackSilent = false
    vi.mocked(api.transpileCypher)
      .mockRejectedValueOnce(new Error('procedural transpile failed'))
      .mockRejectedValueOnce(new Error('cte transpile failed'))

    const sql = await store.transpileCypher('MATCH (n) RETURN r')

    expect(sql).toBeNull()
    expect(store.queryError!.message).toContain('cte transpile failed')
    expect(warningSpy).toHaveBeenCalledTimes(1)
  })

  it('does not retry when the toggle is off', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    store.cteFallbackEnabled = false
    vi.mocked(api.transpileCypher).mockRejectedValue(new Error('boom'))

    const sql = await store.transpileCypher('MATCH (n) RETURN r')

    expect(api.transpileCypher).toHaveBeenCalledTimes(1)
    expect(sql).toBeNull()
    expect(warningSpy).not.toHaveBeenCalled()
  })

  it('does not retry when the transpile already ran in CTE mode', async () => {
    const store = useGraphStore()
    store.currentContext = { id: 'ctx-1' } as any
    store.vlpRenderingMode = 'cte'
    vi.mocked(api.transpileCypher).mockRejectedValue(new Error('boom'))

    await store.transpileCypher('MATCH (n) RETURN r')

    expect(api.transpileCypher).toHaveBeenCalledTimes(1)
  })
})

describe('CTE fallback option persistence', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('serializes into the exploration state', () => {
    const store = useGraphStore()
    store.cteFallbackEnabled = false
    store.cteFallbackSilent = false

    const state = store.getExplorationState()
    expect(state.cte_fallback_enabled).toBe(false)
    expect(state.cte_fallback_silent).toBe(false)
  })

  it('resetTranspileOptions restores the defaults (fallback on, silent on)', () => {
    const store = useGraphStore()
    store.cteFallbackEnabled = false
    store.cteFallbackSilent = false

    store.resetTranspileOptions()

    expect(store.cteFallbackEnabled).toBe(true)
    expect(store.cteFallbackSilent).toBe(true)
  })

  it('silent mode defaults to on', () => {
    expect(useGraphStore().cteFallbackSilent).toBe(true)
  })
})
