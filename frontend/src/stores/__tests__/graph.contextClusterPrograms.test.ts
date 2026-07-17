import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'
import { useClusterStore } from '@/stores/cluster'
import { api } from '@/services/api'
import type { GraphContext } from '@/types/graph'
import type { ClusterProgram } from '@/types/cluster'

function makeContext(overrides: Partial<GraphContext> = {}): GraphContext {
  return {
    id: 'ctx-1',
    title: 'Test context',
    tags: [],
    edge_table_name: 'edges',
    node_table_name: 'nodes',
    edge_structure: {
      edge_id_col: 'edge_id',
      src_col: 'src',
      dst_col: 'dst',
      relationship_type_col: 'relationship_type',
    },
    node_structure: { node_id_col: 'node_id', node_type_col: 'node_type' },
    edge_properties: [],
    node_properties: [],
    node_types: [],
    relationship_types: [],
    owner_email: 'a@b.com',
    shared_with: [],
    has_write_access: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as GraphContext
}

function makeContextProgram(id: string): ClusterProgram {
  return {
    program_id: id,
    program_name: `Program ${id}`,
    code: 'return []',
    scope: 'context',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('context-level cluster programs via loadContext', () => {
  it('loadContext hydrates the cluster store with the context programs', async () => {
    vi.spyOn(api, 'getGraphContext').mockResolvedValue(
      makeContext({ cluster_programs: [makeContextProgram('cp-1')] })
    )
    const graphStore = useGraphStore()
    const clusterStore = useClusterStore()

    await graphStore.loadContext('ctx-1')

    // 3 built-in defaults + the context program
    expect(clusterStore.programs).toHaveLength(4)
    expect(clusterStore.getProgram('cp-1')?.scope).toBe('context')
  })

  it('switching context replaces the previous context programs (no leakage)', async () => {
    const graphStore = useGraphStore()
    const clusterStore = useClusterStore()

    vi.spyOn(api, 'getGraphContext').mockResolvedValue(
      makeContext({ id: 'ctx-1', cluster_programs: [makeContextProgram('cp-1')] })
    )
    await graphStore.loadContext('ctx-1')
    expect(clusterStore.getProgram('cp-1')).toBeDefined()

    vi.spyOn(api, 'getGraphContext').mockResolvedValue(
      makeContext({ id: 'ctx-2', cluster_programs: [makeContextProgram('cp-2')] })
    )
    await graphStore.loadContext('ctx-2')

    expect(clusterStore.getProgram('cp-1')).toBeUndefined()
    expect(clusterStore.getProgram('cp-2')).toBeDefined()
  })

  it('a context without programs yields only the built-in defaults', async () => {
    vi.spyOn(api, 'getGraphContext').mockResolvedValue(makeContext())
    const graphStore = useGraphStore()
    const clusterStore = useClusterStore()

    await graphStore.loadContext('ctx-1')

    expect(clusterStore.programs).toHaveLength(3)
  })

  it('the bug scenario: a program created after an exploration was saved survives loading it', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'updateGraphContext').mockImplementation(async (_id, data) =>
      makeContext({ cluster_programs: data.cluster_programs as ClusterProgram[] })
    )
    const graphStore = useGraphStore()
    const clusterStore = useClusterStore()
    graphStore.currentContext = makeContext()

    // User creates a program (context-scoped by default), then opens an
    // exploration saved BEFORE the program existed (empty programs list).
    const prog = clusterStore.createProgram({ program_name: 'New program', code: 'return []' })
    clusterStore.loadState({ programs: [], clusters: [], executions: [] })

    expect(clusterStore.getProgram(prog.program_id)).toBeDefined()

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })
})
