import { describe, it, expect } from 'vitest'
import { computeNormalizedTextMetrics } from '@/utils/FastLabelRenderer'

describe('computeNormalizedTextMetrics', () => {
  it('returns one line of height 1 for single-line text', () => {
    const m = computeNormalizedTextMetrics('hello')
    expect(m.lineCount).toBe(1)
    expect(m.height).toBe(1)
    expect(m.width).toBeGreaterThan(0)
  })

  it('returns zero width and one line for an empty string', () => {
    expect(computeNormalizedTextMetrics('')).toEqual({ width: 0, height: 1, lineCount: 1 })
  })

  it('counts lines split by \\n and grows height accordingly', () => {
    const m = computeNormalizedTextMetrics('a\nb\nc')
    expect(m.lineCount).toBe(3)
    expect(m.height).toBe(3)
  })

  it('uses the widest line as the block width', () => {
    const wide = computeNormalizedTextMetrics('a very long line').width
    const multi = computeNormalizedTextMetrics('a very long line\nx')
    expect(multi.width).toBe(wide)
  })

  it('a two-line label is narrower than the same text on one line', () => {
    const oneLine = computeNormalizedTextMetrics('Alice score:42')
    const twoLines = computeNormalizedTextMetrics('Alice\nscore:42')
    expect(twoLines.width).toBeLessThan(oneLine.width)
    expect(twoLines.height).toBe(2)
  })

  it('gives \\n itself zero width (no phantom reserved space)', () => {
    expect(computeNormalizedTextMetrics('ab\n').width).toBe(computeNormalizedTextMetrics('ab').width)
  })

  it('measures accented characters as their de-accented base glyph', () => {
    expect(computeNormalizedTextMetrics('José').width).toBe(computeNormalizedTextMetrics('Jose').width)
  })

  it('measures unsupported characters as the ? fallback glyph instead of dropping them', () => {
    const withEllipsis = computeNormalizedTextMetrics('ab…').width
    const withQuestion = computeNormalizedTextMetrics('ab?').width
    expect(withEllipsis).toBe(withQuestion)
    expect(withEllipsis).toBeGreaterThan(computeNormalizedTextMetrics('ab').width)
  })

  it('measures an emoji (surrogate pair) as a single fallback glyph', () => {
    expect(computeNormalizedTextMetrics('🔥').width).toBe(computeNormalizedTextMetrics('?').width)
  })
})
