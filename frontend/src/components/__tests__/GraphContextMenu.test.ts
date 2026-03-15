import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { render, fireEvent } from '@testing-library/vue'
import GraphContextMenu from '@/components/GraphContextMenu.vue'
import { useContextMenu } from '@/composables/useContextMenu'

const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
}
Object.defineProperty(navigator, 'clipboard', {
  value: mockClipboard,
  writable: true,
})

function renderMenu() {
  return render(GraphContextMenu)
}

async function showMenu(target: { type: 'node' | 'edge'; id: string; label: string }) {
  const ctx = useContextMenu()
  const event = new MouseEvent('contextmenu', { clientX: 10, clientY: 10 })
  ctx.show(event, target)
  await nextTick()
  return ctx
}

beforeEach(() => {
  vi.clearAllMocks()
  const ctx = useContextMenu()
  ctx.hide()
  ctx.resetActions()
})

afterEach(() => {
  document.body.querySelectorAll('[data-testid="graph-context-menu"]').forEach(el => el.remove())
})

describe('GraphContextMenu', () => {
  describe('visibility', () => {
    it('not visible when hidden', () => {
      renderMenu()
      expect(document.body.querySelector('[data-testid="graph-context-menu"]')).toBeNull()
    })

    it('visible when show() is called with a node target', async () => {
      renderMenu()
      await showMenu({ type: 'node', id: 'abc-123', label: 'abc-123' })

      expect(document.body.querySelector('[data-testid="graph-context-menu"]')).not.toBeNull()
    })

    it('visible when show() is called with an edge target', async () => {
      renderMenu()
      await showMenu({ type: 'edge', id: 'e-42', label: 'e-42' })

      expect(document.body.querySelector('[data-testid="graph-context-menu"]')).not.toBeNull()
    })
  })

  describe('content rendering', () => {
    it('displays target type badge', async () => {
      renderMenu()
      await showMenu({ type: 'node', id: 'n1', label: 'n1' })

      const typeBadge = document.body.querySelector('.context-menu-type')
      expect(typeBadge?.textContent).toBe('node')
    })

    it('displays target label', async () => {
      renderMenu()
      await showMenu({ type: 'edge', id: 'my-edge-id', label: 'my-edge-id' })

      const idEl = document.body.querySelector('.context-menu-id')
      expect(idEl?.textContent?.trim()).toBe('my-edge-id')
    })

    it('renders Copy ID action', async () => {
      renderMenu()
      await showMenu({ type: 'node', id: 'n-1', label: 'n-1' })

      const copyBtn = document.body.querySelector('[data-testid="context-menu-action-copy-id"]')
      expect(copyBtn).not.toBeNull()
      expect(copyBtn?.textContent).toContain('Copy ID')
    })
  })

  describe('actions', () => {
    it('clicking Copy ID calls clipboard.writeText with the id', async () => {
      renderMenu()
      await showMenu({ type: 'node', id: 'n-99', label: 'n-99' })

      const copyBtn = document.body.querySelector('[data-testid="context-menu-action-copy-id"]') as HTMLElement
      await fireEvent.click(copyBtn)

      expect(mockClipboard.writeText).toHaveBeenCalledWith('n-99')
    })

    it('clicking an action hides the menu', async () => {
      renderMenu()
      const ctx = await showMenu({ type: 'node', id: 'n-1', label: 'n-1' })

      const copyBtn = document.body.querySelector('[data-testid="context-menu-action-copy-id"]') as HTMLElement
      await fireEvent.click(copyBtn)

      expect(ctx.visible.value).toBe(false)
    })
  })

  describe('dismissal', () => {
    it('hides on Escape key', async () => {
      renderMenu()
      const ctx = await showMenu({ type: 'node', id: 'n-1', label: 'n-1' })

      await fireEvent.keyDown(document, { key: 'Escape' })

      expect(ctx.visible.value).toBe(false)
    })

    it('hides on click outside', async () => {
      renderMenu()
      const ctx = await showMenu({ type: 'node', id: 'n-1', label: 'n-1' })

      // Click on body (outside the menu)
      const clickEvent = new MouseEvent('click', { bubbles: true })
      document.body.dispatchEvent(clickEvent)
      await nextTick()

      expect(ctx.visible.value).toBe(false)
    })
  })
})
