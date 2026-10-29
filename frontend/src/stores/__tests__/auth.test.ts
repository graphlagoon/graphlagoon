import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('auth store', () => {
  it('starts unauthenticated when no email in localStorage', () => {
    const store = useAuthStore()
    expect(store.email).toBeNull()
    expect(store.isAuthenticated).toBe(false)
  })

  it('reads email from localStorage on creation', () => {
    localStorage.setItem('userEmail', 'alice@test.com')
    const store = useAuthStore()
    expect(store.email).toBe('alice@test.com')
    expect(store.isAuthenticated).toBe(true)
  })

  it('login sets email and persists to localStorage', () => {
    const store = useAuthStore()
    store.login('bob@test.com')

    expect(store.email).toBe('bob@test.com')
    expect(store.isAuthenticated).toBe(true)
    expect(localStorage.getItem('userEmail')).toBe('bob@test.com')
  })

  it('logout clears email and removes from localStorage', () => {
    const store = useAuthStore()
    store.login('bob@test.com')
    store.logout()

    expect(store.email).toBeNull()
    expect(store.isAuthenticated).toBe(false)
    expect(localStorage.getItem('userEmail')).toBeNull()
  })

  it('login overwrites previous email', () => {
    const store = useAuthStore()
    store.login('first@test.com')
    store.login('second@test.com')

    expect(store.email).toBe('second@test.com')
    expect(localStorage.getItem('userEmail')).toBe('second@test.com')
  })

  describe('workspace-verified sign-in (auth_mode=databricks)', () => {
    it('ignores a remembered e-mail: the session the backend injected is the identity', () => {
      localStorage.setItem('userEmail', 'stale@example.com')
      window.__GRAPH_LAGOON_CONFIG__ = { auth_mode: 'databricks' }
      expect(useAuthStore().isAuthenticated).toBe(false)
      window.__GRAPH_LAGOON_CONFIG__ = { auth_mode: 'databricks', databricks_user_email: 'ana@example.com' }
      setActivePinia(createPinia())
      expect(useAuthStore().email).toBe('ana@example.com')
    })

    it('logout ends the backend session with the CSRF header', async () => {
      window.__GRAPH_LAGOON_CONFIG__ = { auth_mode: 'databricks', databricks_user_email: 'ana@example.com' }
      const fetchMock = vi.fn().mockResolvedValue({ ok: true })
      vi.stubGlobal('fetch', fetchMock)
      try {
        const store = useAuthStore()
        await store.logout()
        expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', {
          method: 'POST',
          headers: { 'X-Requested-With': 'graphlagoon' },
        })
        expect(store.email).toBeNull()
        expect(window.__GRAPH_LAGOON_CONFIG__?.databricks_user_email).toBeUndefined()
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })
})
