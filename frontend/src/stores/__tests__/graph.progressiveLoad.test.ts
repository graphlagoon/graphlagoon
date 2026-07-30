/**
 * Progressive load (Phase 2): render first, fill properties in afterwards.
 *
 * The safety of this feature rests on two invariants that are asserted here
 * rather than assumed:
 *
 *  1. `nodes.value` keeps its ARRAY IDENTITY across a patch, so the
 *     community/similarity stores (which watch identity) do not wipe state.
 *  2. Node/edge COUNTS never change during a patch, so the canvas data watcher
 *     — which reacts only to counts — does not rebuild the scene or reheat the
 *     layout. Visual refresh goes through `nodePatchVersion` instead.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { watch, nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import {
  useGraphStore,
  resolveInitialBehaviors,
  PROGRESSIVE_LOAD_MIN_PROPERTIES,
} from '@/stores/graph'
import { clearPerfEntries } from '@/utils/perfMetrics'

vi.mock('@/services/api', () => ({
  api: {
    getGraphContext: vi.fn(),
    getSubgraph: vi.fn(),
    getNodesBatch: vi.fn(),
    expandFromNode: vi.fn(),
    submitGraphQueryJob: vi.fn(),
    getGraphQueryJob: vi.fn(),
    cancelGraphQueryJob: vi.fn(),
    getExploration: vi.fn(),
  },
}))

import { api } from '@/services/api'

/**
 * Fresh response per call.
 *
 * The store assigns `response.nodes` directly and patchNodeProperties mutates
 * those node objects in place (that is the whole design). A module-level
 * literal would therefore carry properties written by one test into the next,
 * making later tests see nodes that are already enriched.
 */
function typesResponse() {
  return {
    nodes: [
      { node_id: 'n1', node_type: 'Person' },
      { node_id: 'n2', node_type: 'Company' },
    ],
    edges: [{ edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'WORKS_AT' }],
    truncated: false,
    properties_deferred: true,
  }
}

function storeWithContext() {
  const store = useGraphStore()
  store.currentContext = { id: 'ctx-1' } as any
  return store
}

/** Resolve the enrichment pump's queued microtasks. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await nextTick()
}

describe('progressive load', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    clearPerfEntries()
    vi.clearAllMocks()
    vi.mocked(api.getNodesBatch).mockResolvedValue({ nodes: [] } as any)
  })

  afterEach(() => clearPerfEntries())

  describe('loadSubgraph request shape', () => {
    it("requests nodes_mode 'types' when progressiveLoad is on (default)", async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)

      await store.loadSubgraph({})

      expect(vi.mocked(api.getSubgraph).mock.calls[0][1].nodes_mode).toBe('types')
    })

    it("requests nodes_mode 'full' when progressiveLoad is 'never'", async () => {
      const store = storeWithContext()
      store.behaviors.progressiveLoad = 'never'
      vi.mocked(api.getSubgraph).mockResolvedValue({
        ...typesResponse(),
        properties_deferred: false,
      } as any)

      await store.loadSubgraph({})

      expect(vi.mocked(api.getSubgraph).mock.calls[0][1].nodes_mode).toBe('full')
    })

    it('honours an explicit nodes_mode over the behavior', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)

      await store.loadSubgraph({ nodes_mode: 'full' })

      expect(vi.mocked(api.getSubgraph).mock.calls[0][1].nodes_mode).toBe('full')
    })

    it('seeds pending ids only when the response defers properties', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue({
        ...typesResponse(),
        properties_deferred: false,
      } as any)

      await store.loadSubgraph({})

      expect(store.pendingPropertyNodeIds.size).toBe(0)
      expect(api.getNodesBatch).not.toHaveBeenCalled()
    })
  })

  describe('shouldLoadProgressively (auto threshold)', () => {
    // Progressive load always costs extra round-trips, so 'auto' only turns it
    // on when properties are heavy enough to pay for them. Measured: a
    // 100-column table gained 79% on first paint; a 13-column one gained 15%
    // at 3k nodes and LOST time at 1k.
    function contextWith(propertyCount: number | null) {
      return {
        id: 'ctx-1',
        node_properties:
          propertyCount === null
            ? undefined
            : Array.from({ length: propertyCount }, (_, i) => ({
                name: `p${i}`,
                data_type: 'string',
              })),
      } as any
    }

    it('loads progressively for a wide node table', () => {
      const store = useGraphStore()
      store.currentContext = contextWith(100)

      expect(store.shouldLoadProgressively()).toBe(true)
    })

    it('switches exactly at the configured threshold', () => {
      // The boundary is the whole point of 'auto': one column either side of it
      // must pick opposite strategies, or the setting is decorative.
      const store = useGraphStore()

      store.currentContext = contextWith(PROGRESSIVE_LOAD_MIN_PROPERTIES - 1)
      expect(store.shouldLoadProgressively()).toBe(false)

      store.currentContext = contextWith(PROGRESSIVE_LOAD_MIN_PROPERTIES)
      expect(store.shouldLoadProgressively()).toBe(true)
    })

    it('loads everything at once for a narrow node table', () => {
      const store = useGraphStore()
      store.currentContext = contextWith(5)

      expect(store.shouldLoadProgressively()).toBe(false)
    })

    it('treats an unconfigured context as wide', () => {
      // No node_properties → backend falls back to SELECT n.*, so the payload
      // is the full (unknown, possibly 100-column) table width.
      const store = useGraphStore()
      store.currentContext = contextWith(null)

      expect(store.shouldLoadProgressively()).toBe(true)
    })

    it('treats an empty property list as wide for the same reason', () => {
      const store = useGraphStore()
      store.currentContext = contextWith(0)

      expect(store.shouldLoadProgressively()).toBe(true)
    })

    it("'always' overrides a narrow table", () => {
      const store = useGraphStore()
      store.currentContext = contextWith(3)
      store.behaviors.progressiveLoad = 'always'

      expect(store.shouldLoadProgressively()).toBe(true)
    })

    it("'never' overrides a wide table", () => {
      const store = useGraphStore()
      store.currentContext = contextWith(100)
      store.behaviors.progressiveLoad = 'never'

      expect(store.shouldLoadProgressively()).toBe(false)
    })

    it('drives the nodes_mode actually requested', async () => {
      const store = useGraphStore()
      store.currentContext = contextWith(3)
      vi.mocked(api.getSubgraph).mockResolvedValue({
        ...typesResponse(),
        properties_deferred: false,
      } as any)

      await store.loadSubgraph({})

      expect(vi.mocked(api.getSubgraph).mock.calls[0][1].nodes_mode).toBe('full')
    })
  })

  describe('persistence and validation of the progressiveLoad setting', () => {
    // The setting rides in `default_behaviors`, which contexts and saved
    // explorations both carry opaquely — so it persists, but it also arrives
    // untrusted and has to be validated here.

    it('is restored from a context default_behaviors', () => {
      expect(resolveInitialBehaviors({ progressiveLoad: 'always' }).progressiveLoad)
        .toBe('always')
      expect(resolveInitialBehaviors({ progressiveLoad: 'never' }).progressiveLoad)
        .toBe('never')
    })

    it('rejects a value outside the allowed modes', () => {
      // typeof alone cannot tell 'auto' from 'banana' — both are strings — so
      // without an enum check a typo would silently become the active mode and
      // then ride along into every saved exploration.
      expect(resolveInitialBehaviors({ progressiveLoad: 'banana' }).progressiveLoad)
        .toBe('auto')
    })

    it('rejects the legacy boolean shape', () => {
      // Contexts saved while this setting was still a boolean must fall back to
      // the default rather than coercing to a nonsense mode.
      expect(resolveInitialBehaviors({ progressiveLoad: true }).progressiveLoad)
        .toBe('auto')
      expect(resolveInitialBehaviors({ progressiveLoad: false }).progressiveLoad)
        .toBe('auto')
    })

    it('validates the other enum behaviors too', () => {
      expect(resolveInitialBehaviors({ searchMode: 'nope' }).searchMode).toBe('highlight')
      expect(resolveInitialBehaviors({ viewMode: '4d' }).viewMode).toBe('2d-proj')
      expect(resolveInitialBehaviors({ edgeLensMode: 'sparkle' }).edgeLensMode).toBe('dim')
      // Valid values still pass.
      expect(resolveInitialBehaviors({ viewMode: '3d' }).viewMode).toBe('3d')
    })

    it('survives a round-trip through an exploration merge', () => {
      const store = useGraphStore()
      store.behaviors.progressiveLoad = 'auto'

      // Same merge loadExploration performs on saved state.
      store.behaviors = { ...store.behaviors, progressiveLoad: 'never' } as any

      expect(store.behaviors.progressiveLoad).toBe('never')
      expect(store.shouldLoadProgressively()).toBe(false)
    })
  })

  describe('truncation on the subgraph path', () => {
    it('surfaces truncated from a subgraph response', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue({
        ...typesResponse(),
        truncated: true,
        properties_deferred: false,
      } as any)

      await store.loadSubgraph({})

      expect(store.truncated).toBe(true)
    })

    it('leaves the flag down for a complete subgraph', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue({
        ...typesResponse(),
        truncated: false,
        properties_deferred: false,
      } as any)

      await store.loadSubgraph({})

      expect(store.truncated).toBe(false)
    })
  })

  describe('patchNodeProperties invariants', () => {
    it('preserves the nodes array identity', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)
      await store.loadSubgraph({})

      const before = store.nodes
      store.patchNodeProperties(new Map([['n1', { name: 'Alice' }]]))

      expect(store.nodes).toBe(before)
    })

    it('does not fire identity watchers on the nodes array', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)
      await store.loadSubgraph({})
      await settle()

      // Same shape the community/similarity stores use.
      const spy = vi.fn()
      watch(() => store.nodes, spy)

      store.patchNodeProperties(new Map([['n1', { name: 'Alice' }]]))
      await nextTick()

      expect(spy).not.toHaveBeenCalled()
    })

    it('leaves node and edge counts unchanged', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)
      await store.loadSubgraph({})

      const counts = [store.nodes.length, store.edges.length]
      store.patchNodeProperties(new Map([['n1', { name: 'Alice' }]]))

      expect([store.nodes.length, store.edges.length]).toEqual(counts)
    })

    it('does not request a fresh layout', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)
      await store.loadSubgraph({})
      store.freshLayoutRequested = false

      store.patchNodeProperties(new Map([['n1', { name: 'Alice' }]]))

      expect(store.freshLayoutRequested).toBe(false)
    })

    it('writes the properties and clears the pending id', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)
      await store.loadSubgraph({})

      store.patchNodeProperties(new Map([['n1', { name: 'Alice' }]]))

      expect(store.nodes.find((n) => n.node_id === 'n1')!.properties).toEqual({
        name: 'Alice',
      })
      expect(store.pendingPropertyNodeIds.has('n1')).toBe(false)
    })

    it('bumps nodePatchVersion once per batch, not per node', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)
      await store.loadSubgraph({})
      await settle()

      const before = store.nodePatchVersion
      store.patchNodeProperties(
        new Map([
          ['n1', { name: 'Alice' }],
          ['n2', { name: 'Acme' }],
        ]),
      )

      expect(store.nodePatchVersion).toBe(before + 1)
    })

    it('does not signal when nothing matched', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)
      await store.loadSubgraph({})
      await settle()

      const before = store.nodePatchVersion
      store.patchNodeProperties(new Map([['does-not-exist', { a: 1 }]]))

      expect(store.nodePatchVersion).toBe(before)
    })
  })

  describe('enrichNodeProperties', () => {
    it('fetches pending ids and patches them in', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)
      vi.mocked(api.getNodesBatch).mockResolvedValue({
        nodes: [
          { node_id: 'n1', node_type: 'Person', properties: { name: 'Alice' } },
          { node_id: 'n2', node_type: 'Company', properties: { name: 'Acme' } },
        ],
      } as any)

      await store.loadSubgraph({})
      await settle()

      expect(store.pendingPropertyNodeIds.size).toBe(0)
      expect(store.nodes.find((n) => n.node_id === 'n1')!.properties).toEqual({
        name: 'Alice',
      })
    })

    it('chunks large id sets into multiple batches', async () => {
      const store = storeWithContext()
      const many = Array.from({ length: 5 }, (_, i) => ({
        node_id: `n${i}`,
        node_type: 'T',
      }))
      // progressiveLoad off: loadSubgraph must not start its own pump with the
      // default batch size, which would race the sized run under test.
      store.behaviors.progressiveLoad = 'never'
      vi.mocked(api.getSubgraph).mockResolvedValue({
        nodes: many,
        edges: [],
        truncated: false,
        properties_deferred: false,
      } as any)
      vi.mocked(api.getNodesBatch).mockImplementation(
        async (_ctx: string, ids: string[]) =>
          ({ nodes: ids.map((id) => ({ node_id: id, node_type: 'T', properties: { id } })) }) as any,
      )

      await store.loadSubgraph({})
      for (const n of many) store.pendingPropertyNodeIds.add(n.node_id)

      await store.enrichNodeProperties(2)

      const sizes = vi.mocked(api.getNodesBatch).mock.calls.map((c) => c[1].length)
      expect(sizes).toEqual([2, 2, 1])
      expect(store.pendingPropertyNodeIds.size).toBe(0)
    })

    it('terminates when the warehouse returns nothing for an id', async () => {
      // A deleted row would otherwise keep its id pending forever and spin the
      // enrichment loop.
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)
      vi.mocked(api.getNodesBatch).mockResolvedValue({ nodes: [] } as any)

      await store.loadSubgraph({})
      await settle()

      expect(store.pendingPropertyNodeIds.size).toBe(0)
    })

    it('survives a failing batch without breaking the graph', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)
      vi.mocked(api.getNodesBatch).mockRejectedValue(new Error('warehouse down'))

      await store.loadSubgraph({})
      await settle()

      expect(store.nodes).toHaveLength(2)
      expect(store.queryError).toBeNull()
      expect(store.enriching).toBe(false)
    })

    it('abandons in-flight enrichment when a new load starts', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)

      let release: (v: any) => void = () => {}
      vi.mocked(api.getNodesBatch).mockReturnValue(
        new Promise((resolve) => {
          release = resolve
        }) as any,
      )

      await store.loadSubgraph({})
      // Second load supersedes the first while its batch is still in flight.
      vi.mocked(api.getSubgraph).mockResolvedValue({
        nodes: [{ node_id: 'other', node_type: 'T' }],
        edges: [],
        truncated: false,
        properties_deferred: false,
      } as any)
      await store.loadSubgraph({})

      release({ nodes: [{ node_id: 'n1', node_type: 'Person', properties: { stale: true } }] })
      await settle()

      // The stale patch must not resurrect a node from the previous graph.
      expect(store.nodes.map((n) => n.node_id)).toEqual(['other'])
    })

    it('clear() drops pending ids and stops enriching', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)
      // mockImplementation, not mockReturnValue: the latter reuses one promise
      // instance across tests, so a promise another test resolved would make
      // this batch settle instantly and drain the pending set before we look.
      vi.mocked(api.getNodesBatch).mockImplementation(() => new Promise(() => {}) as any)

      await store.loadSubgraph({})
      expect(store.pendingPropertyNodeIds.size).toBe(2)

      store.clear()

      expect(store.pendingPropertyNodeIds.size).toBe(0)
      expect(store.enriching).toBe(false)
    })
  })

  describe('two-wave enrichment (wide tables)', () => {
    // On a 100-column table, fetching every column for every node costs more
    // than the single request progressive loading replaced. Visual columns
    // (labels, icons) come first so the graph looks right early.
    function widePatchStore() {
      const store = storeWithContext()
      store.textFormatDefaults.nodeTemplate = '{prop:display_name}'
      store.setNodePropertyIconConfig('Person', {
        property: 'status',
        valueIcons: { ok: 'check' },
        fallbackIcon: 'dot',
      } as any)
      return store
    }

    it('fetches label/icon columns before the full set', async () => {
      const store = widePatchStore()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)
      vi.mocked(api.getNodesBatch).mockImplementation(
        async (_c: string, ids: string[], cols?: string[]) =>
          ({
            nodes: ids.map((id) => ({
              node_id: id,
              node_type: 'Person',
              properties: cols ? { display_name: `n-${id}`, status: 'ok' } : { bulk: 1 },
            })),
          }) as any,
      )

      await store.loadSubgraph({})
      await settle()

      const calls = vi.mocked(api.getNodesBatch).mock.calls
      expect(calls[0][2]).toEqual(expect.arrayContaining(['display_name', 'status']))
      // The last wave asks for everything (no column restriction).
      expect(calls[calls.length - 1][2]).toBeUndefined()
    })

    it('keeps first-wave columns when the full wave lands', async () => {
      // The second wave must merge, not replace: otherwise a backend that
      // omits a column would silently erase the label already on screen.
      const store = widePatchStore()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)
      vi.mocked(api.getNodesBatch).mockImplementation(
        async (_c: string, ids: string[], cols?: string[]) =>
          ({
            nodes: ids.map((id) => ({
              node_id: id,
              node_type: 'Person',
              properties: cols ? { display_name: `n-${id}` } : { bulk: 1 },
            })),
          }) as any,
      )

      await store.loadSubgraph({})
      await settle()

      const n1 = store.nodes.find((n) => n.node_id === 'n1')!
      expect(n1.properties).toMatchObject({ display_name: 'n-n1', bulk: 1 })
    })

    it('ids stay pending until the full wave completes', async () => {
      const store = widePatchStore()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)

      let releaseFull: (v: any) => void = () => {}
      vi.mocked(api.getNodesBatch).mockImplementation(
        (_c: string, ids: string[], cols?: string[]) => {
          if (cols) {
            return Promise.resolve({
              nodes: ids.map((id) => ({ node_id: id, node_type: 'Person', properties: { display_name: id } })),
            }) as any
          }
          return new Promise((resolve) => {
            releaseFull = resolve
          }) as any
        },
      )

      await store.loadSubgraph({})
      await settle()

      // First wave done, full wave in flight: nodes still owe their bulk
      // columns, so they must not have been dropped from the pending set.
      expect(store.pendingPropertyNodeIds.size).toBe(2)

      releaseFull({
        nodes: [{ node_id: 'n1', node_type: 'Person', properties: { bulk: 1 } }],
      })
      await settle()
      expect(store.pendingPropertyNodeIds.size).toBe(0)
    })

    it('skips the first wave when no property drives the visuals', async () => {
      const store = storeWithContext() // default template uses node_id only
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)
      vi.mocked(api.getNodesBatch).mockResolvedValue({ nodes: [] } as any)

      await store.loadSubgraph({})
      await settle()

      const calls = vi.mocked(api.getNodesBatch).mock.calls
      expect(calls.every((c) => c[2] === undefined)).toBe(true)
    })
  })

  describe('prioritizeNodeProperties', () => {
    it('fetches a single node on demand', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue(typesResponse() as any)
      vi.mocked(api.getNodesBatch).mockImplementation(() => new Promise(() => {}) as any)
      await store.loadSubgraph({})

      vi.mocked(api.getNodesBatch).mockResolvedValue({
        nodes: [{ node_id: 'n1', node_type: 'Person', properties: { name: 'Alice' } }],
      } as any)
      await store.prioritizeNodeProperties('n1')

      expect(store.nodes.find((n) => n.node_id === 'n1')!.properties).toEqual({
        name: 'Alice',
      })
    })

    it('is a no-op for a node that already has properties', async () => {
      const store = storeWithContext()
      vi.mocked(api.getSubgraph).mockResolvedValue({
        ...typesResponse(),
        properties_deferred: false,
      } as any)
      await store.loadSubgraph({})
      vi.mocked(api.getNodesBatch).mockClear()

      await store.prioritizeNodeProperties('n1')

      expect(api.getNodesBatch).not.toHaveBeenCalled()
    })
  })
})
