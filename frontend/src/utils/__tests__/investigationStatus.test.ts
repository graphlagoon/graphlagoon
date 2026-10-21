import { describe, it, expect } from 'vitest'
import {
  ANNOTATION_KIND_LABELS,
  ITEM_KIND_LABELS,
  STATUS_LABELS,
  STATUS_TRANSITIONS,
  caseNumber,
  caseTitle,
  deadlineElapsed,
  deadlineOf,
  deadlineText,
  itemKindLabel,
} from '@/utils/investigationStatus'
import type { Investigation } from '@/types/investigation'

const inv = (deadline: Investigation['deadline']) =>
  ({ id: '0412aaaa-1111-2222-3333-444444444444', title: 'Mule network', deadline }) as Investigation
const deadline = (hours_left: number, total_hours: number, phase: 'open' | 'analysis' = 'open') => ({
  phase, due_at: '2026-02-15T00:00:00', hours_left, days_left: Math.ceil(hours_left / 24), total_hours,
  urgent: hours_left <= total_hours * 0.2, overdue: hours_left < 0,
})

describe('investigationStatus labels', () => {
  it('spells every enum, never the wire value', () => {
    expect(STATUS_LABELS).toEqual({ open: 'Open', analysis: 'In analysis', closed: 'Closed' })
    expect(ITEM_KIND_LABELS).toEqual({ graph: 'Graph', query: 'Query', table: 'Table', document: 'Document', note: 'Note' })
    expect(ANNOTATION_KIND_LABELS.same_as).toBe('same as')
    expect(itemKindLabel('graph')).toBe('Graph')
    expect(itemKindLabel('unknown')).toBe('unknown')
    expect(STATUS_TRANSITIONS).toEqual({ open: ['analysis'], analysis: ['open'], closed: [] }) // only a decision closes
  })

  it('names a case by title and short id, never the raw UUID', () => {
    expect(caseNumber('0412aaaa-1111-2222-3333-444444444444')).toBe('#0412aa')
    expect(caseTitle(inv(null))).toBe('Mule network · #0412aa')
  })

  it('reads the server deadline in hours, with its urgency, and spells it with the phase name', () => {
    const d = deadlineOf(inv(deadline(840, 1080)))!
    expect(d).toEqual({ phase: 'open', hoursLeft: 840, daysLeft: 35, totalHours: 1080, dueAt: '2026-02-15T00:00:00', urgent: false, overdue: false })
    expect(deadlineText(d)).toBe('open · 35 d')
    expect(deadlineElapsed(d)).toBeCloseTo((240 / 1080) * 100)
    const soon = deadlineOf(inv(deadline(14, 24)))!
    expect(deadlineText(soon)).toBe('open · 14 h')
    const late = deadlineOf(inv(deadline(-50, 2160, 'analysis')))!
    expect([late.overdue, late.urgent]).toEqual([true, true])
    expect(deadlineText(late)).toBe('analysis · overdue by 2 d')
    expect(deadlineElapsed(late)).toBe(100)
    expect(deadlineOf(inv(null))).toBeNull()
  })
})
