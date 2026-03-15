import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useToast } from '@/composables/useToast'

describe('useToast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Clear toasts between tests
    const { toasts } = useToast()
    toasts.value = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('show adds a toast with correct properties', () => {
    const { show, toasts } = useToast()
    const id = show('Hello', 'info', 3000)

    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]).toMatchObject({
      id,
      message: 'Hello',
      type: 'info',
      duration: 3000,
    })
  })

  it('info shorthand creates info toast', () => {
    const { info, toasts } = useToast()
    info('Info message')

    expect(toasts.value[0].type).toBe('info')
    expect(toasts.value[0].message).toBe('Info message')
  })

  it('success shorthand creates success toast', () => {
    const { success, toasts } = useToast()
    success('Done!')

    expect(toasts.value[0].type).toBe('success')
  })

  it('warning shorthand creates warning toast', () => {
    const { warning, toasts } = useToast()
    warning('Careful')

    expect(toasts.value[0].type).toBe('warning')
  })

  it('error shorthand creates error toast with 4s default', () => {
    const { error, toasts } = useToast()
    error('Failed')

    expect(toasts.value[0].type).toBe('error')
    expect(toasts.value[0].duration).toBe(4000)
  })

  it('auto-removes toast after duration', () => {
    const { show, toasts } = useToast()
    show('Temp', 'info', 2000)

    expect(toasts.value).toHaveLength(1)
    vi.advanceTimersByTime(2000)
    expect(toasts.value).toHaveLength(0)
  })

  it('duration=0 keeps toast indefinitely', () => {
    const { show, toasts } = useToast()
    show('Permanent', 'info', 0)

    vi.advanceTimersByTime(60000)
    expect(toasts.value).toHaveLength(1)
  })

  it('remove deletes specific toast', () => {
    const { show, remove, toasts } = useToast()
    const id1 = show('First', 'info', 0)
    show('Second', 'info', 0)

    expect(toasts.value).toHaveLength(2)
    remove(id1)
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0].message).toBe('Second')
  })

  it('remove with invalid id does nothing', () => {
    const { show, remove, toasts } = useToast()
    show('Only', 'info', 0)

    remove(99999)
    expect(toasts.value).toHaveLength(1)
  })

  it('multiple toasts accumulate', () => {
    const { info, warning, error, toasts } = useToast()
    info('A', 0)
    warning('B', 0)
    error('C', 0)

    expect(toasts.value).toHaveLength(3)
  })

  it('each toast gets a unique id', () => {
    const { show } = useToast()
    const id1 = show('A', 'info', 0)
    const id2 = show('B', 'info', 0)
    const id3 = show('C', 'info', 0)

    expect(new Set([id1, id2, id3]).size).toBe(3)
  })
})
