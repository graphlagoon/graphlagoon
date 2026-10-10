import { describe, it, expect } from 'vitest'
import {
  ANNOTATION_KIND_LABELS,
  DECISION_OUTCOME_LABELS,
  ITEM_KIND_LABELS,
  KIND_PRESET_LABELS,
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
  ({ id: '0412aaaa-1111-2222-3333-444444444444', title: 'Golpe Pix', deadline }) as Investigation

describe('investigationStatus labels (pt-BR)', () => {
  it('spells every enum in Portuguese, never the wire value', () => {
    expect(STATUS_LABELS).toEqual({ open: 'Aberto', analysis: 'Em análise', decided: 'Decidido', archived: 'Arquivado' })
    expect(KIND_PRESET_LABELS.pix_med).toBe('Pix com MED')
    expect(DECISION_OUTCOME_LABELS.comunicar).toMatch(/^Comunicar ao COAF/)
    expect(ITEM_KIND_LABELS).toEqual({ graph: 'Grafo', query: 'Consulta', table: 'Tabela', document: 'Documento', note: 'Nota' })
    expect(ANNOTATION_KIND_LABELS.same_as).toBe('mesmo que')
    expect(ANNOTATION_KIND_LABELS.hypothesis_status).toBe('estado da hipótese')
    expect(itemKindLabel('graph')).toBe('Grafo')
    expect(itemKindLabel('unknown')).toBe('unknown')
    expect(Object.keys(STATUS_TRANSITIONS)).toEqual(['open', 'analysis', 'decided', 'archived'])
  })

  it('names a case by title and short id, never the raw UUID', () => {
    expect(caseNumber('0412aaaa-1111-2222-3333-444444444444')).toBe('#0412aa')
    expect(caseTitle(inv(null))).toBe('Golpe Pix · #0412aa')
  })

  it('reads the server deadline with its phases and spells it with the phase name', () => {
    const d = deadlineOf(inv({ phase: 'open', due_at: '2026-02-15T00:00:00', days_left: 35, total_days: 45 }))!
    expect(d).toEqual({ phase: 'open', daysLeft: 35, totalDays: 45, dueAt: '2026-02-15T00:00:00' })
    expect(deadlineText(d)).toBe('seleção · 35 d')
    expect(deadlineElapsed(d)).toBeCloseTo((10 / 45) * 100)
    const late = deadlineOf(inv({ phase: 'analysis', due_at: '2026-02-15T00:00:00', days_left: -2, total_days: 90 }))!
    expect(deadlineText(late)).toBe('análise · vencido há 2 d')
    expect(deadlineElapsed(late)).toBe(100)
    expect(deadlineOf(inv(null))).toBeNull()
    // Older payloads without total_days still render a bar.
    expect(deadlineOf(inv({ phase: 'open', due_at: '', days_left: 5 }))!.totalDays).toBe(5)
  })
})
