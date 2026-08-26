import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCommunityStore } from '@/stores/community'

/**
 * Tests for the "Community column in Data Table" toggle (tableColumnEnabled):
 * default, exploration persistence via getState/loadState, and legacy states.
 */

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('tableColumnEnabled', () => {
  it('defaults to false', () => {
    const community = useCommunityStore()
    expect(community.tableColumnEnabled).toBe(false)
  })

  it('getState includes the flag', () => {
    const community = useCommunityStore()
    community.communityMap = new Map([['n1', 0]])
    community.tableColumnEnabled = true

    const state = community.getState()
    expect(state).toBeDefined()
    expect(state!.tableColumnEnabled).toBe(true)
  })

  it('getState / loadState round-trips the flag', () => {
    const community = useCommunityStore()
    community.communityMap = new Map([['n1', 0], ['n2', 1]])
    community.tableColumnEnabled = true

    const state = community.getState()

    setActivePinia(createPinia())
    const restored = useCommunityStore()
    restored.loadState(state)
    expect(restored.tableColumnEnabled).toBe(true)
  })

  it('loadState defaults to false for legacy states without the key', () => {
    const community = useCommunityStore()
    community.tableColumnEnabled = true

    community.loadState({ communityMap: { n1: 0 } })
    expect(community.tableColumnEnabled).toBe(false)
  })

  it('clearCommunities keeps the flag (preference survives re-detect)', () => {
    const community = useCommunityStore()
    community.communityMap = new Map([['n1', 0]])
    community.tableColumnEnabled = true

    community.clearCommunities()
    expect(community.hasResults).toBe(false)
    expect(community.tableColumnEnabled).toBe(true)
  })
})
