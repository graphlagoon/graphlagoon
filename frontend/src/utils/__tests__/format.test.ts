import { describe, it, expect } from 'vitest'
import { formatDate, formatMoney, formatRelative, plural } from '@/utils/format'

describe('format', () => {
  it('formatDate gives dd/mm/yyyy HH:mm in local time, or the date alone', () => {
    const d = new Date(2026, 9, 9, 15, 4)
    expect(formatDate(d)).toBe('09/10/2026 15:04')
    expect(formatDate(d.toISOString())).toBe('09/10/2026 15:04')
    expect(formatDate(d.getTime(), { time: false })).toBe('09/10/2026')
    expect(formatDate(null)).toBe('')
    expect(formatDate('not a date')).toBe('')
  })

  it('formatMoney groups thousands with commas and uses a dot for cents', () => {
    expect(formatMoney(1234.5)).toBe('$1,234.50')
    expect(formatMoney(4870)).toBe('$4,870.00')
    expect(formatMoney(0.1 + 0.2)).toBe('$0.30')
    expect(formatMoney(-1)).toBe('-$1.00')
    expect(formatMoney('1234567.891', { decimals: 0 })).toBe('$1,234,568')
    expect(formatMoney(null)).toBe('')
    expect(formatMoney(Number.NaN)).toBe('')
  })

  it('formatRelative says just now / N min ago / N h ago / N d ago and falls back to the date', () => {
    const now = new Date(2026, 9, 9, 15, 0)
    const ago = (ms: number) => new Date(now.getTime() - ms)
    expect(formatRelative(ago(10_000), now)).toBe('just now')
    expect(formatRelative(ago(5 * 60_000), now)).toBe('5 min ago')
    expect(formatRelative(ago(2 * 3_600_000), now)).toBe('2 h ago')
    expect(formatRelative(ago(3 * 86_400_000), now)).toBe('3 d ago')
    expect(formatRelative(ago(40 * 86_400_000), now)).toBe('30/08/2026')
    expect(formatRelative(new Date(now.getTime() + 60_000), now)).toBe('09/10/2026 15:01')
    expect(formatRelative(undefined, now)).toBe('')
  })

  it('plural puts the count first', () => {
    expect(plural(1, 'item', 'items')).toBe('1 item')
    expect(plural(3, 'item', 'items')).toBe('3 items')
    expect(plural(0, 'suggestion')).toBe('0 suggestions')
  })
})
