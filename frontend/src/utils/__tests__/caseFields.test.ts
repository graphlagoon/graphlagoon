import { describe, it, expect } from 'vitest'
import { fieldInput, fieldText } from '@/utils/caseFields'

describe('case fields (06 §1)', () => {
  it('shows money with two decimals, numbers and text as they are, nothing as a dash', () => {
    expect(fieldText({ type: 'money' }, 84000)).toBe(new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(84000))
    expect(fieldText({ type: 'number' }, 3)).toBe('3')
    expect(fieldText({ type: 'enum' }, '5999')).toBe('5999')
    expect(fieldText({ type: 'text' }, null)).toBe('—')
  })

  it('reads an input: numbers as numbers, empty as null (removes the field)', () => {
    expect(fieldInput({ type: 'money' }, ' 1200.5 ')).toBe(1200.5)
    expect(fieldInput({ type: 'text' }, ' M-1 ')).toBe('M-1')
    expect(fieldInput({ type: 'date' }, '')).toBeNull()
  })
})
