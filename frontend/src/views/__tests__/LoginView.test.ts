import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import LoginView from '@/views/LoginView.vue'
import { useAuthStore } from '@/stores/auth'

// Mock vue-router
const pushMock = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // Set dev_mode to true so LoginView doesn't redirect
  window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true }
})

describe('LoginView', () => {
  it('renders login form', () => {
    const { getByText, getByLabelText } = render(LoginView)
    expect(getByText('Graph Lagoon')).toBeDefined()
    expect(getByLabelText('Email')).toBeDefined()
    expect(getByText('Login')).toBeDefined()
  })

  it('shows dev mode notice when dev_mode is true', () => {
    const { getByText } = render(LoginView)
    expect(getByText('Dev Mode: Enter any email to login')).toBeDefined()
  })

  it('shows prod mode notice when dev_mode is false', () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: false }
    const { getByText } = render(LoginView)
    expect(getByText('Production Mode: Authentication is handled by proxy headers')).toBeDefined()
  })

  it('redirects to /contexts when not in dev mode', () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: false }
    render(LoginView)
    expect(pushMock).toHaveBeenCalledWith('/contexts')
  })

  it('does not redirect in dev mode', () => {
    render(LoginView)
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('validates email format before login', async () => {
    const { getByLabelText, getByText } = render(LoginView)

    const emailInput = getByLabelText('Email')
    await fireEvent.update(emailInput, 'invalid-email')

    // Submit form
    const form = emailInput.closest('form')!
    await fireEvent.submit(form)

    expect(getByText('Please enter a valid email')).toBeDefined()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('logs in with valid email and redirects', async () => {
    const authStore = useAuthStore()
    const { getByLabelText } = render(LoginView)

    const emailInput = getByLabelText('Email')
    await fireEvent.update(emailInput, 'user@test.com')

    const form = emailInput.closest('form')!
    await fireEvent.submit(form)

    expect(authStore.email).toBe('user@test.com')
    expect(pushMock).toHaveBeenCalledWith('/contexts')
  })

  describe('workspace-verified sign-in (auth_mode=databricks)', () => {
    beforeEach(() => {
      window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: false, auth_mode: 'databricks', login_url: '/api/auth/login', router_base: '/graphlagoon/' }
    })

    it('offers the Databricks button instead of the e-mail form and does not redirect', () => {
      const { getByTestId, queryByLabelText } = render(LoginView)
      expect(getByTestId('login-databricks')).toBeDefined()
      expect(queryByLabelText('Email')).toBeNull()
      expect(pushMock).not.toHaveBeenCalled()
    })

    it('sends the browser to the backend sign-in with a local next path', async () => {
      const assign = vi.fn()
      const original = window.location
      Object.defineProperty(window, 'location', { value: { ...original, assign }, writable: true })
      try {
        const { getByTestId } = render(LoginView)
        await fireEvent.click(getByTestId('login-databricks'))
        expect(assign).toHaveBeenCalledWith('/api/auth/login?next=%2Fgraphlagoon%2Fcontexts')
      } finally {
        Object.defineProperty(window, 'location', { value: original, writable: true })
      }
    })

    it('goes straight to contexts when the session already exists', () => {
      window.__GRAPH_LAGOON_CONFIG__!.databricks_user_email = 'ana@example.com'
      render(LoginView)
      expect(pushMock).toHaveBeenCalledWith('/contexts')
    })
  })
})
