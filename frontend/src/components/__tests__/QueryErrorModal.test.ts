import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import QueryErrorModal from '@/components/QueryErrorModal.vue'

// Mock navigator.clipboard
const mockClipboard = {
  writeText: vi.fn(),
}
Object.defineProperty(navigator, 'clipboard', {
  value: mockClipboard,
  writable: true,
})

function renderModal(error: any = null) {
  return render(QueryErrorModal, {
    props: { error },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  // Clean up teleported content from body
  document.body.querySelectorAll('.modal-overlay').forEach(el => el.remove())
})

describe('QueryErrorModal', () => {
  describe('visibility', () => {
    it('not visible when error is null', () => {
      renderModal(null)
      expect(document.body.querySelector('.modal-overlay')).toBeNull()
    })

    it('visible when error is provided', () => {
      renderModal({ message: 'Something failed' })
      expect(document.body.querySelector('.modal-overlay')).not.toBeNull()
    })
  })

  describe('content rendering', () => {
    it('displays error message', () => {
      renderModal({ message: 'SQL syntax error' })
      expect(document.body.textContent).toContain('SQL syntax error')
    })

    it('shows Query Execution Error for non-internal errors', () => {
      renderModal({ message: 'err' })
      expect(document.body.textContent).toContain('Query Execution Error')
    })

    it('shows Server Error for INTERNAL_SERVER_ERROR code', () => {
      renderModal({ message: 'err', code: 'INTERNAL_SERVER_ERROR' })
      expect(document.body.textContent).toContain('Server Error')
    })

    it('shows error code when provided', () => {
      renderModal({ message: 'err', code: 'SYNTAX_ERROR' })
      expect(document.body.textContent).toContain('SYNTAX_ERROR')
    })

    it('shows exception type when provided', () => {
      renderModal({ message: 'err', exceptionType: 'SqlParseException' })
      expect(document.body.textContent).toContain('SqlParseException')
    })

    it('shows query when provided', () => {
      renderModal({ message: 'err', query: 'SELECT * FROM bad' })
      expect(document.body.textContent).toContain('SELECT * FROM bad')
    })

    it('does not show details section when no code/exceptionType/traceback', () => {
      renderModal({ message: 'simple error' })
      expect(document.body.querySelector('.error-details')).toBeNull()
    })

    it('does not show query section when no query', () => {
      renderModal({ message: 'no query' })
      expect(document.body.querySelector('.query-section')).toBeNull()
    })

    it('shows traceback toggle when traceback present', () => {
      renderModal({ message: 'err', traceback: ['line 1', 'line 2'] })
      expect(document.body.textContent).toContain('Stack Trace (2 lines)')
    })
  })

  describe('interactions', () => {
    it('dismiss button emits close', async () => {
      const { emitted } = renderModal({ message: 'err' })
      const dismissBtn = document.body.querySelector('.dismiss-btn') as HTMLElement
      await fireEvent.click(dismissBtn)
      expect(emitted().close).toBeTruthy()
    })

    it('X button emits close', async () => {
      const { emitted } = renderModal({ message: 'err' })
      const closeBtn = document.body.querySelector('.close-btn') as HTMLElement
      await fireEvent.click(closeBtn)
      expect(emitted().close).toBeTruthy()
    })

    it('overlay click emits close', async () => {
      const { emitted } = renderModal({ message: 'err' })
      const overlay = document.body.querySelector('.modal-overlay') as HTMLElement
      await fireEvent.click(overlay)
      expect(emitted().close).toBeTruthy()
    })

    it('traceback toggle expands and collapses', async () => {
      renderModal({ message: 'err', traceback: ['line 1', 'line 2'] })

      // Initially collapsed
      expect(document.body.querySelector('.traceback-content')).toBeNull()

      // Click to expand
      const toggleBtn = document.body.querySelector('.traceback-toggle') as HTMLElement
      await fireEvent.click(toggleBtn)
      expect(document.body.querySelector('.traceback-content')).not.toBeNull()

      // Click to collapse
      await fireEvent.click(toggleBtn)
      expect(document.body.querySelector('.traceback-content')).toBeNull()
    })

    it('copy query button calls clipboard API', async () => {
      renderModal({ message: 'err', query: 'SELECT 1' })

      const copyBtns = document.body.querySelectorAll('.copy-btn')
      await fireEvent.click(copyBtns[0])
      expect(mockClipboard.writeText).toHaveBeenCalledWith('SELECT 1')
    })

    it('Copy Full Error composes all error parts', async () => {
      renderModal({
        message: 'SQL error',
        code: 'SYNTAX_ERROR',
        exceptionType: 'SqlParseException',
        query: 'SELECT *',
        traceback: ['at line 1', 'at line 2'],
      })

      const copyAllBtn = document.body.querySelector('.copy-all-btn') as HTMLElement
      await fireEvent.click(copyAllBtn)

      const copied = mockClipboard.writeText.mock.calls[0][0]
      expect(copied).toContain('Error: SQL error')
      expect(copied).toContain('Code: SYNTAX_ERROR')
      expect(copied).toContain('Exception: SqlParseException')
      expect(copied).toContain('Query:\nSELECT *')
      expect(copied).toContain('at line 1\nat line 2')
    })

    it('Copy Full Error button not shown without detailed info', () => {
      renderModal({ message: 'simple error' })
      expect(document.body.querySelector('.copy-all-btn')).toBeNull()
    })
  })

  describe('stale-schema classification', () => {
    it('shows the actionable title instead of the generic one', () => {
      renderModal({ message: 'raw spark text', code: 'STALE_CONTEXT_SCHEMA' })
      expect(document.body.textContent).toContain('Context schema may be stale')
      expect(document.body.textContent).not.toContain('Query Execution Error')
    })

    it('renders the hint above the raw message', () => {
      renderModal({
        message: 'raw spark text',
        code: 'STALE_CONTEXT_SCHEMA',
        hint: 'This context’s stored schema may be out of date — run a schema check and resync.',
      })
      const hint = document.body.querySelector('[data-testid="stale-schema-hint"]')
      expect(hint).not.toBeNull()
      expect(hint!.textContent).toContain('out of date')
    })

    it('renders the unresolved column name when present', () => {
      renderModal({
        message: 'raw spark text',
        code: 'STALE_CONTEXT_SCHEMA',
        hint: 'stale',
        unresolvedName: 'email',
      })
      expect(document.body.textContent).toContain('email')
    })

    it('does not render the hint block for a non-stale error', () => {
      renderModal({ message: 'err', code: 'QUERY_EXECUTION_ERROR' })
      expect(document.body.querySelector('[data-testid="stale-schema-hint"]')).toBeNull()
    })

    it('shows the CTA only when contextId is present', () => {
      renderModal({
        message: 'err',
        code: 'STALE_CONTEXT_SCHEMA',
        hint: 'stale',
      })
      expect(document.body.querySelector('[data-testid="review-schema-btn"]')).toBeNull()
    })

    it('CTA click emits review-schema with the context id', async () => {
      const { emitted } = renderModal({
        message: 'err',
        code: 'STALE_CONTEXT_SCHEMA',
        hint: 'stale',
        contextId: 'ctx-123',
      })
      const btn = document.body.querySelector('[data-testid="review-schema-btn"]') as HTMLElement
      expect(btn).not.toBeNull()
      await fireEvent.click(btn)
      expect(emitted()['review-schema']).toBeTruthy()
      expect(emitted()['review-schema'][0]).toEqual(['ctx-123'])
    })

    it('CTA not shown for a non-stale error even with a contextId-shaped detail', () => {
      renderModal({ message: 'err', code: 'QUERY_EXECUTION_ERROR', contextId: 'ctx-123' })
      expect(document.body.querySelector('[data-testid="review-schema-btn"]')).toBeNull()
    })
  })
})
