import { describe, it, expect, beforeEach } from 'vitest'
import { effectScope } from 'vue'
import { useDrawerResize } from '@/composables/useDrawerResize'

const run = <T>(fn: () => T): T => effectScope().run(fn)!

beforeEach(() => localStorage.clear())

describe('useDrawerResize', () => {
  it('never opens taller than its share of the window by default', () => {
    Object.defineProperty(window, 'innerHeight', { value: 700, configurable: true })
    const { height } = run(() => useDrawerResize({ initialHeight: 440, minHeight: 240, maxHeightRatio: 0.8, defaultRatio: 0.5 }))
    expect(height.value).toBe(350)
  })

  it('reopens at the height the person dragged it to', () => {
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })
    const { height, onMouseDown } = run(() => useDrawerResize({ initialHeight: 280, storageKey: 'k' }))
    onMouseDown(new MouseEvent('mousedown', { clientY: 500 }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 400 }))
    document.dispatchEvent(new MouseEvent('mouseup'))
    expect(height.value).toBe(380)
    const again = run(() => useDrawerResize({ initialHeight: 280, storageKey: 'k' }))
    expect(again.height.value).toBe(380)
  })
})
