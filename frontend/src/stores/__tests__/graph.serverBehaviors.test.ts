import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore, resolveInitialBehaviors } from '@/stores/graph'

/** Set the server-injected config the way the SPA template / /api/config would. */
function setServerConfig(default_behaviors: Record<string, unknown> | undefined) {
  window.__GRAPH_LAGOON_CONFIG__ = default_behaviors === undefined
    ? {}
    : { default_behaviors }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  delete window.__GRAPH_LAGOON_CONFIG__
  vi.restoreAllMocks()
})

describe('server-provided behavior defaults', () => {
  describe('resolveInitialBehaviors', () => {
    it('uses the built-in defaults when the server sends no config at all', () => {
      delete window.__GRAPH_LAGOON_CONFIG__

      const behaviors = resolveInitialBehaviors()

      expect(behaviors.mapStylePan).toBe(true)
      expect(behaviors.viewMode).toBe('2d-proj')
    })

    it('uses the built-in defaults when the server sends no default_behaviors key', () => {
      setServerConfig(undefined)

      expect(resolveInitialBehaviors().mapStylePan).toBe(true)
    })

    it('applies a server override', () => {
      setServerConfig({ mapStylePan: false })

      expect(resolveInitialBehaviors().mapStylePan).toBe(false)
    })

    it('applies overrides of every scalar type the panel uses', () => {
      setServerConfig({
        mapStylePan: false,         // boolean
        viewMode: '3d',             // string union
        labelDensity: 2.5,          // number
      })

      const behaviors = resolveInitialBehaviors()

      expect(behaviors.mapStylePan).toBe(false)
      expect(behaviors.viewMode).toBe('3d')
      expect(behaviors.labelDensity).toBe(2.5)
    })

    it('leaves keys the server did not mention at their built-in defaults', () => {
      setServerConfig({ mapStylePan: false })

      const behaviors = resolveInitialBehaviors()

      expect(behaviors.mapStylePan).toBe(false)
      // Untouched.
      expect(behaviors.viewMode).toBe('2d-proj')
      expect(behaviors.searchMode).toBe('highlight')
      expect(behaviors.labelDensity).toBe(0.5)
    })

    it('drops unknown keys instead of injecting junk into the store', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // A plausible operator typo.
      setServerConfig({ mapStyle: false })

      const behaviors = resolveInitialBehaviors()

      expect('mapStyle' in behaviors).toBe(false)
      // The real setting keeps its default rather than being silently "set".
      expect(behaviors.mapStylePan).toBe(true)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('mapStyle'))
    })

    it('rejects a value of the wrong type rather than corrupting the setting', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // A YAML/env footgun: the string "false" is truthy, not the boolean false.
      setServerConfig({ mapStylePan: 'false' })

      const behaviors = resolveInitialBehaviors()

      expect(behaviors.mapStylePan).toBe(true)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('mapStylePan'))
    })

    it('a bad key does not prevent the good keys in the same object from applying', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      setServerConfig({ nonsense: 1, mapStylePan: false })

      expect(resolveInitialBehaviors().mapStylePan).toBe(false)
    })

    it('returns a fresh object each call (no shared mutable defaults)', () => {
      const a = resolveInitialBehaviors()
      a.mapStylePan = false

      expect(resolveInitialBehaviors().mapStylePan).toBe(true)
    })
  })

  describe('graph store seeding', () => {
    it('seeds the store behaviors from the server config', () => {
      setServerConfig({ mapStylePan: false, viewMode: '3d' })

      const store = useGraphStore()

      expect(store.behaviors.mapStylePan).toBe(false)
      expect(store.behaviors.viewMode).toBe('3d')
    })

    it('the user can still override a server default in the panel', () => {
      setServerConfig({ mapStylePan: false })
      const store = useGraphStore()
      expect(store.behaviors.mapStylePan).toBe(false)

      store.updateBehaviors({ mapStylePan: true })

      expect(store.behaviors.mapStylePan).toBe(true)
    })

    it('a loaded exploration overrides the server default', () => {
      // Server says map-style pan off...
      setServerConfig({ mapStylePan: false })
      const store = useGraphStore()
      expect(store.behaviors.mapStylePan).toBe(false)

      // ...but the saved exploration says on. Exploration wins: loadExploration merges
      // the saved behaviors over whatever is current (which is now the server default).
      store.updateBehaviors({ mapStylePan: true } as Partial<typeof store.behaviors>)

      expect(store.behaviors.mapStylePan).toBe(true)
    })

    it('server defaults are serialized into new explorations', () => {
      setServerConfig({ mapStylePan: false })
      const store = useGraphStore()

      const state = store.getExplorationState()

      expect(state.behaviors?.mapStylePan).toBe(false)
    })
  })
})
