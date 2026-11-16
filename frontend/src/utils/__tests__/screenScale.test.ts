import { describe, it, expect } from 'vitest'
import { drawAsDot, ICON_BACK_ABOVE_PX, ICON_DOT_BELOW_PX, pixelsPerWorldUnit } from '../screenScale'

describe('screenScale', () => {
  it('pixelsPerWorldUnit: orthographic = height · zoom / frustum', () => {
    const g = { camera: () => ({ isOrthographicCamera: true, zoom: 2 }), renderer: () => ({ domElement: { clientHeight: 1000 } }) }
    expect(pixelsPerWorldUnit(g)).toBe(1)
    expect(pixelsPerWorldUnit(null)).toBe(1)
  })

  it('drawAsDot has hysteresis: no flicker for a node resting between the two thresholds', () => {
    const between = (ICON_DOT_BELOW_PX + ICON_BACK_ABOVE_PX) / 2
    expect(drawAsDot(ICON_DOT_BELOW_PX - 1, false)).toBe(true)
    expect(drawAsDot(between, true)).toBe(true)
    expect(drawAsDot(between, false)).toBe(false)
    expect(drawAsDot(ICON_BACK_ABOVE_PX + 1, true)).toBe(false)
  })
})
