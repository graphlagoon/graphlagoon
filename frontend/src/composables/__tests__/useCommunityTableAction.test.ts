import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useContextMenu } from '@/composables/useContextMenu'
import {
  useCommunityTableAction,
  COMMUNITY_TABLE_ACTION_ID,
} from '@/composables/useCommunityTableAction'
import { useCommunityStore } from '@/stores/community'

describe('useCommunityTableAction', () => {
  let ctx: ReturnType<typeof useContextMenu>

  beforeEach(() => {
    setActivePinia(createPinia())
    ctx = useContextMenu()
    ctx.hide()
    ctx.resetActions()
  })

  function findAction() {
    return ctx.actions.value.find(a => a.id === COMMUNITY_TABLE_ACTION_ID)
  }

  it('register() adds the action, unregister() removes it', () => {
    const table = useCommunityTableAction()
    expect(findAction()).toBeUndefined()

    table.register()
    expect(findAction()).toBeDefined()

    table.unregister()
    expect(findAction()).toBeUndefined()
  })

  it('is hidden for edges', () => {
    const table = useCommunityTableAction()
    table.register()

    const communityStore = useCommunityStore()
    communityStore.communityMap = new Map([['n1', 0]])

    expect(findAction()!.visible!({ type: 'edge', id: 'n1', label: 'n1' })).toBe(false)
  })

  it('is hidden for nodes without a detected community', () => {
    const table = useCommunityTableAction()
    table.register()

    const communityStore = useCommunityStore()
    communityStore.communityMap = new Map([['n1', 0]])

    expect(findAction()!.visible!({ type: 'node', id: 'n2', label: 'n2' })).toBe(false)
  })

  it('is hidden when no communities are detected', () => {
    const table = useCommunityTableAction()
    table.register()

    expect(findAction()!.visible!({ type: 'node', id: 'n1', label: 'n1' })).toBe(false)
  })

  it('is visible for nodes with a detected community (louvain or cluster program)', () => {
    const table = useCommunityTableAction()
    table.register()

    const communityStore = useCommunityStore()
    communityStore.communityMap = new Map([['n1', 0], ['n2', 3]])

    expect(findAction()!.visible!({ type: 'node', id: 'n1', label: 'n1' })).toBe(true)
    expect(findAction()!.visible!({ type: 'node', id: 'n2', label: 'n2' })).toBe(true)
  })

  it('handler opens the modal for the node community', async () => {
    const table = useCommunityTableAction()
    table.register()

    const communityStore = useCommunityStore()
    communityStore.communityMap = new Map([['n1', 0], ['n2', 3]])

    await findAction()!.handler({ type: 'node', id: 'n2', label: 'n2' })
    expect(table.selectedCommunityId.value).toBe(3)
  })

  it('handler keeps community 0 (falsy id) working', async () => {
    const table = useCommunityTableAction()
    table.register()

    const communityStore = useCommunityStore()
    communityStore.communityMap = new Map([['n1', 0]])

    await findAction()!.handler({ type: 'node', id: 'n1', label: 'n1' })
    expect(table.selectedCommunityId.value).toBe(0)
  })

  it('handler does nothing for unknown nodes', async () => {
    const table = useCommunityTableAction()
    table.register()

    await findAction()!.handler({ type: 'node', id: 'ghost', label: 'ghost' })
    expect(table.selectedCommunityId.value).toBeNull()
  })

  it('close() clears the selected community', async () => {
    const table = useCommunityTableAction()
    table.register()

    const communityStore = useCommunityStore()
    communityStore.communityMap = new Map([['n1', 2]])

    await findAction()!.handler({ type: 'node', id: 'n1', label: 'n1' })
    expect(table.selectedCommunityId.value).toBe(2)

    table.close()
    expect(table.selectedCommunityId.value).toBeNull()
  })
})
