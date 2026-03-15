import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useContextMenu, type ContextMenuTarget } from '@/composables/useContextMenu'

const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
Object.defineProperty(navigator, 'clipboard', { value: mockClipboard, writable: true })

describe('useContextMenu', () => {
  let ctx: ReturnType<typeof useContextMenu>

  beforeEach(() => {
    vi.clearAllMocks()
    ctx = useContextMenu()
    ctx.hide()
    ctx.resetActions()
  })

  it('starts hidden', () => {
    expect(ctx.visible.value).toBe(false)
    expect(ctx.target.value).toBeNull()
  })

  it('show() sets position, target, and visible', () => {
    const event = new MouseEvent('contextmenu', { clientX: 100, clientY: 200 })
    vi.spyOn(event, 'preventDefault')
    vi.spyOn(event, 'stopPropagation')

    ctx.show(event, { type: 'node', id: 'n1', label: 'n1' })

    expect(ctx.visible.value).toBe(true)
    expect(ctx.x.value).toBe(100)
    expect(ctx.y.value).toBe(200)
    expect(ctx.target.value?.id).toBe('n1')
    expect(ctx.target.value?.type).toBe('node')
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()
  })

  it('hide() clears state', () => {
    const event = new MouseEvent('contextmenu', { clientX: 10, clientY: 20 })
    ctx.show(event, { type: 'edge', id: 'e1', label: 'e1' })

    ctx.hide()

    expect(ctx.visible.value).toBe(false)
    expect(ctx.target.value).toBeNull()
  })

  it('has copy-id as built-in action', () => {
    expect(ctx.actions.value.some(a => a.id === 'copy-id')).toBe(true)
  })

  it('copy-id action calls clipboard.writeText', async () => {
    const copyAction = ctx.actions.value.find(a => a.id === 'copy-id')!
    await copyAction.handler({ type: 'node', id: 'test-node-123', label: 'test' })
    expect(mockClipboard.writeText).toHaveBeenCalledWith('test-node-123')
  })

  it('copy-id works for edges too', async () => {
    const copyAction = ctx.actions.value.find(a => a.id === 'copy-id')!
    await copyAction.handler({ type: 'edge', id: 'edge-456', label: 'edge' })
    expect(mockClipboard.writeText).toHaveBeenCalledWith('edge-456')
  })

  it('addAction adds a custom action', () => {
    ctx.addAction({
      id: 'custom',
      label: 'Custom Action',
      handler: vi.fn(),
    })
    expect(ctx.actions.value.some(a => a.id === 'custom')).toBe(true)
  })

  it('removeAction removes an action', () => {
    ctx.removeAction('copy-id')
    expect(ctx.actions.value.some(a => a.id === 'copy-id')).toBe(false)
  })

  it('getVisibleActions returns all actions when no visibility filter', () => {
    const event = new MouseEvent('contextmenu', { clientX: 0, clientY: 0 })
    ctx.show(event, { type: 'node', id: 'n1', label: 'n1' })

    const visible = ctx.getVisibleActions()
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.some(a => a.id === 'copy-id')).toBe(true)
  })

  it('getVisibleActions filters by visibility callback', () => {
    const event = new MouseEvent('contextmenu', { clientX: 0, clientY: 0 })
    ctx.show(event, { type: 'edge', id: 'e1', label: 'e1' })

    ctx.addAction({
      id: 'node-only',
      label: 'Node Only',
      handler: vi.fn(),
      visible: (t: ContextMenuTarget) => t.type === 'node',
    })

    const visible = ctx.getVisibleActions()
    expect(visible.some(a => a.id === 'node-only')).toBe(false)
    expect(visible.some(a => a.id === 'copy-id')).toBe(true)
  })

  it('getVisibleActions returns empty when no target', () => {
    expect(ctx.getVisibleActions()).toEqual([])
  })
})
