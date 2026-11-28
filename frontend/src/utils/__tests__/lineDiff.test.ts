import { describe, it, expect } from 'vitest'
import { diffCounts, lineDiff } from '@/utils/lineDiff'

describe('lineDiff', () => {
  it('keeps what stayed and marks the lines an edit removed and added, in order', () => {
    const d = lineDiff('# Brief\nThree accounts.\nUnknown: the owner.\nNext: ask the bank.', '# Brief\nFour accounts.\nUnknown: the owner.\nOwner found: Ana.\nNext: ask the bank.')
    expect(d).toEqual([
      { op: 'same', text: '# Brief' },
      { op: 'del', text: 'Three accounts.' },
      { op: 'add', text: 'Four accounts.' },
      { op: 'same', text: 'Unknown: the owner.' },
      { op: 'add', text: 'Owner found: Ana.' },
      { op: 'same', text: 'Next: ask the bank.' },
    ])
    expect(diffCounts(d)).toEqual({ added: 2, removed: 1 })
  })

  it('an identical text has no change; a first text is all added', () => {
    expect(diffCounts(lineDiff('a\nb', 'a\nb'))).toEqual({ added: 0, removed: 0 })
    expect(lineDiff('', 'a').filter((l) => l.op === 'add').map((l) => l.text)).toEqual(['a'])
  })
})
