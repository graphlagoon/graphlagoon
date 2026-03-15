import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/services/api', () => ({
  api: {
    devMode: false,
  },
}))

import { usePersistence } from '@/composables/usePersistence'

beforeEach(() => {
  vi.clearAllMocks()
  delete (window as any).__GRAPH_LAGOON_CONFIG__
})

describe('usePersistence', () => {
  it('sharingEnabled is true when database_enabled is true', () => {
    window.__GRAPH_LAGOON_CONFIG__ = { database_enabled: true }
    const { sharingEnabled } = usePersistence()
    expect(sharingEnabled.value).toBe(true)
  })

  it('sharingEnabled is false when database_enabled is false', () => {
    window.__GRAPH_LAGOON_CONFIG__ = { database_enabled: false }
    const { sharingEnabled } = usePersistence()
    expect(sharingEnabled.value).toBe(false)
  })

  it('sharingEnabled is false when config is not set', () => {
    const { sharingEnabled } = usePersistence()
    expect(sharingEnabled.value).toBe(false)
  })

  it('exposes devMode from api', () => {
    const { devMode } = usePersistence()
    expect(devMode.value).toBe(false)
  })
})
