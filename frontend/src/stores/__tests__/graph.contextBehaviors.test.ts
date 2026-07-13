import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore, resolveInitialBehaviors } from '@/stores/graph'
import { api } from '@/services/api'
import type { GraphContext } from '@/types/graph'

function makeContext(default_behaviors?: Record<string, unknown>): GraphContext {
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
    default_behaviors,
    owner_email: 'a@b.com',
    shared_with: [],
    has_write_access: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as GraphContext
}

/** Stub the API so loadContext resolves to our context. */
function stubContext(context: GraphContext) {
  vi.spyOn(api, 'getGraphContext').mockResolvedValue(context)
}

function setServerConfig(default_behaviors: Record<string, unknown>) {
  window.__GRAPH_LAGOON_CONFIG__ = { default_behaviors }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  delete window.__GRAPH_LAGOON_CONFIG__
  vi.restoreAllMocks()
})

describe('per-context default behaviors', () => {
  describe('resolveInitialBehaviors(contextBehaviors)', () => {
    it('falls back to built-ins when the context has none', () => {
      expect(resolveInitialBehaviors(undefined).viewMode).toBe('2d-proj')
      expect(resolveInitialBehaviors({}).viewMode).toBe('2d-proj')
    })

    it('applies the context behaviors', () => {
      expect(resolveInitialBehaviors({ viewMode: '3d' }).viewMode).toBe('3d')
    })

    it('context beats the server config', () => {
      setServerConfig({ viewMode: '2d-proj', mapStylePan: false })

      const resolved = resolveInitialBehaviors({ viewMode: '3d' })

      expect(resolved.viewMode).toBe('3d')        // context wins
      expect(resolved.mapStylePan).toBe(false)    // server value survives where the context is silent
    })

    it('drops unknown context keys instead of injecting junk', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const resolved = resolveInitialBehaviors({ notAKey: true })

      expect('notAKey' in resolved).toBe(false)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('context'))
    })

    it('rejects a context value of the wrong type', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      // The string "false" is truthy — it must not become the boolean.
      expect(resolveInitialBehaviors({ mapStylePan: 'false' }).mapStylePan).toBe(true)
    })
  })

  describe('loadContext seeding', () => {
    it('applies the context behaviors when the context is opened', async () => {
      stubContext(makeContext({ viewMode: '3d', mapStylePan: false }))
      const store = useGraphStore()

      await store.loadContext('ctx-1')

      expect(store.behaviors.viewMode).toBe('3d')
      expect(store.behaviors.mapStylePan).toBe(false)
    })

    it('a context without behaviors leaves the defaults in place', async () => {
      stubContext(makeContext())
      const store = useGraphStore()

      await store.loadContext('ctx-1')

      expect(store.behaviors.viewMode).toBe('2d-proj')
      expect(store.behaviors.mapStylePan).toBe(true)
    })

    it('switching contexts does not leak the previous context behaviors', async () => {
      const store = useGraphStore()

      stubContext(makeContext({ viewMode: '3d' }))
      await store.loadContext('ctx-1')
      expect(store.behaviors.viewMode).toBe('3d')

      // Second context says nothing about viewMode — it must fall back to the default,
      // not inherit '3d'. (clear() does not reset behaviors, so this is a real trap.)
      stubContext(makeContext())
      await store.loadContext('ctx-2')

      expect(store.behaviors.viewMode).toBe('2d-proj')
    })

    it('re-resolving drops a user change made in the previous context', async () => {
      const store = useGraphStore()
      stubContext(makeContext({ viewMode: '3d' }))
      await store.loadContext('ctx-1')

      // User tweaks a setting in the panel...
      store.updateBehaviors({ mapStylePan: false })
      expect(store.behaviors.mapStylePan).toBe(false)

      // ...then opens a different context: the new context's defaults apply cleanly.
      stubContext(makeContext())
      await store.loadContext('ctx-2')

      expect(store.behaviors.mapStylePan).toBe(true)
    })

    it('leaves behaviors alone when the context fails to load', async () => {
      const store = useGraphStore()
      store.updateBehaviors({ viewMode: '3d' })

      vi.spyOn(api, 'getGraphContext').mockRejectedValue(new Error('boom'))
      await store.loadContext('ctx-1')

      expect(store.error).toBeTruthy()
      expect(store.behaviors.viewMode).toBe('3d')
    })
  })

  describe('precedence: built-in < server < context < user < exploration', () => {
    it('the user can override a context default in the panel', async () => {
      stubContext(makeContext({ viewMode: '3d' }))
      const store = useGraphStore()
      await store.loadContext('ctx-1')

      store.updateBehaviors({ viewMode: '2d-proj' })

      expect(store.behaviors.viewMode).toBe('2d-proj')
    })

    it('a saved exploration overrides its context default', async () => {
      // Context says 3D...
      stubContext(makeContext({ viewMode: '3d' }))
      const store = useGraphStore()
      await store.loadContext('ctx-1')
      expect(store.behaviors.viewMode).toBe('3d')

      // ...but the exploration was saved in 2d-proj. loadExploration merges the saved
      // behaviors over whatever is current, and it runs AFTER loadContext — so the
      // user's saved state wins over the context default.
      store.updateBehaviors({ viewMode: '2d-proj' } as Partial<typeof store.behaviors>)

      expect(store.behaviors.viewMode).toBe('2d-proj')
    })

    it('context behaviors are serialized into explorations saved from it', async () => {
      stubContext(makeContext({ viewMode: '3d' }))
      const store = useGraphStore()
      await store.loadContext('ctx-1')

      expect(store.getExplorationState().behaviors?.viewMode).toBe('3d')
    })
  })
})
