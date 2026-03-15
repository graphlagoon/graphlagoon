import { describe, it, expect, beforeEach } from 'vitest'
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
})
