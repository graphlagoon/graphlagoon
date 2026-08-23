import { describe, it, expect, beforeEach } from 'vitest'
import { ScreenAABBFilter } from '@/utils/LabelGrid'

describe('ScreenAABBFilter.tryPlace', () => {
  let filter: ScreenAABBFilter

  beforeEach(() => {
    filter = new ScreenAABBFilter(20)
    filter.reset(800, 600)
  })

  it('places a label on an empty grid', () => {
    expect(filter.tryPlace(400, 300, 100, 20, 'center', 'center', 0.4)).toBe(true)
  })

  it('rejects a second label fully overlapping the first', () => {
    expect(filter.tryPlace(400, 300, 100, 20, 'center', 'center', 0.4)).toBe(true)
    expect(filter.tryPlace(400, 300, 100, 20, 'center', 'center', 0.4)).toBe(false)
  })

  it('places non-overlapping labels', () => {
    expect(filter.tryPlace(100, 100, 80, 20, 'center', 'center', 0.4)).toBe(true)
    expect(filter.tryPlace(600, 500, 80, 20, 'center', 'center', 0.4)).toBe(true)
  })

  it('a bottom-anchored block occupies the space ABOVE its anchor', () => {
    // Bottom-anchored at y=300 with height 80 → occupies y in [220, 300]
    expect(filter.tryPlace(400, 300, 100, 80, 'center', 'bottom', 0.4)).toBe(true)
    // Center-anchored label well below the anchor (y≈360) must not collide
    expect(filter.tryPlace(400, 360, 100, 20, 'center', 'center', 0.0)).toBe(true)
    // Center-anchored label inside [220, 300] must collide
    expect(filter.tryPlace(400, 260, 100, 20, 'center', 'center', 0.4)).toBe(false)
  })

  it('a center-anchored block straddles its anchor vertically', () => {
    // Center-anchored at y=300 with height 80 → occupies y in [260, 340]
    expect(filter.tryPlace(400, 300, 100, 80, 'center', 'center', 0.4)).toBe(true)
    expect(filter.tryPlace(400, 330, 100, 20, 'center', 'center', 0.4)).toBe(false)
    expect(filter.tryPlace(400, 270, 100, 20, 'center', 'center', 0.4)).toBe(false)
  })

  it('a taller (multi-line) label reserves proportionally more vertical space', () => {
    // Two-line block (height 40) at y=100
    expect(filter.tryPlace(200, 100, 100, 40, 'center', 'center', 0.4)).toBe(true)
    // One-line label just outside the two-line box fits
    expect(filter.tryPlace(200, 160, 100, 20, 'center', 'center', 0.0)).toBe(true)
  })

  it('respects horizontal alignment for the AABB', () => {
    // Left-aligned at x=100 → occupies x in [100, 200]
    expect(filter.tryPlace(100, 300, 100, 20, 'left', 'center', 0.4)).toBe(true)
    // Right-aligned ending just before it → occupies x in [0, 80]
    expect(filter.tryPlace(80, 300, 80, 20, 'right', 'center', 0.0)).toBe(true)
    // Overlapping the left-aligned label is rejected
    expect(filter.tryPlace(150, 300, 100, 20, 'left', 'center', 0.4)).toBe(false)
  })
})
