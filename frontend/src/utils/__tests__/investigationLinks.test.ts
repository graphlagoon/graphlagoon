import { describe, expect, it } from 'vitest'
import { explorationUrl } from '@/utils/investigationLinks'

describe('explorationUrl (UX-1)', () => {
  it('opens the exploration in its context, with the case for the way back', () => {
    expect(explorationUrl({ context_id: 'c1', exploration_id: 'e1' }, 'inv-1')).toBe('/graph/c1?exploration=e1&case=inv-1')
  })

  it('has no link without the context or the exploration', () => {
    expect(explorationUrl({ context_id: null, exploration_id: 'e1' }, 'inv-1')).toBeNull()
    expect(explorationUrl({ context_id: 'c1', exploration_id: null }, 'inv-1')).toBeNull()
  })
})
