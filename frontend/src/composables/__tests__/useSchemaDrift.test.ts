import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSchemaDrift } from '@/composables/useSchemaDrift'
import { createSchemaDrift } from '@/__tests__/fixtures/schemaDrift'

vi.mock('@/services/api', () => ({
  api: {
    getSchemaDrift: vi.fn(),
  },
}))

import { api } from '@/services/api'

beforeEach(() => {
  vi.clearAllMocks()
  // Module-level cache — clear entries this suite touches so tests don't leak.
  const { clear } = useSchemaDrift()
  clear('ctx-a')
  clear('ctx-b')
})

describe('useSchemaDrift', () => {
  it('starts with a null, non-loading, error-free state', () => {
    const { state } = useSchemaDrift()
    expect(state('ctx-a')).toEqual({ drift: null, loading: false, error: null })
  })

  it('check() populates drift and clears loading', async () => {
    const drift = createSchemaDrift({ context_id: 'ctx-a', status: 'error' })
    vi.mocked(api.getSchemaDrift).mockResolvedValue(drift)

    const { state, check } = useSchemaDrift()
    const promise = check('ctx-a')
    expect(state('ctx-a').loading).toBe(true)
    await promise

    expect(state('ctx-a').loading).toBe(false)
    expect(state('ctx-a').drift).toEqual(drift)
    expect(state('ctx-a').error).toBeNull()
  })

  it('shares state across independent composable instances (per-context cache)', async () => {
    const drift = createSchemaDrift({ context_id: 'ctx-a' })
    vi.mocked(api.getSchemaDrift).mockResolvedValue(drift)

    const first = useSchemaDrift()
    await first.check('ctx-a')

    const second = useSchemaDrift()
    expect(second.state('ctx-a').drift).toEqual(drift)
  })

  it('different contexts do not share state', async () => {
    vi.mocked(api.getSchemaDrift).mockResolvedValue(createSchemaDrift({ context_id: 'ctx-a', status: 'error' }))
    const { state, check } = useSchemaDrift()
    await check('ctx-a')

    expect(state('ctx-b').drift).toBeNull()
  })

  it('checkTypes always re-fetches rather than short-circuiting on a cached result', async () => {
    const { check } = useSchemaDrift()
    vi.mocked(api.getSchemaDrift).mockResolvedValue(createSchemaDrift({ context_id: 'ctx-a' }))

    await check('ctx-a')
    await check('ctx-a', true)

    expect(api.getSchemaDrift).toHaveBeenCalledTimes(2)
    expect(api.getSchemaDrift).toHaveBeenNthCalledWith(2, 'ctx-a', { checkTypes: true })
  })

  it('surfaces an error without throwing', async () => {
    vi.mocked(api.getSchemaDrift).mockRejectedValue(new Error('network down'))

    const { state, check } = useSchemaDrift()
    const result = await check('ctx-a')

    expect(result).toBeNull()
    expect(state('ctx-a').error).toBe('network down')
    expect(state('ctx-a').loading).toBe(false)
  })

  it('clear() resets a context back to its initial state', async () => {
    vi.mocked(api.getSchemaDrift).mockResolvedValue(createSchemaDrift({ context_id: 'ctx-a' }))
    const { state, check, clear } = useSchemaDrift()
    await check('ctx-a')
    expect(state('ctx-a').drift).not.toBeNull()

    clear('ctx-a')
    expect(state('ctx-a')).toEqual({ drift: null, loading: false, error: null })
  })
})
