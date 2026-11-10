import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useContextMenu } from '@/composables/useContextMenu'
import {
  useCommunityMenuActions,
  COMMUNITY_TABLE_ACTION_ID,
  ISOLATE_COMMUNITY_ACTION_ID,
  ISOLATE_CLUSTER_ACTION_ID,
  CLEAR_ISOLATION_ACTION_ID,
} from '@/composables/useCommunityMenuActions'
import { useCommunityStore } from '@/stores/community'
import { useClusterStore } from '@/stores/cluster'
import { useGraphStore } from '@/stores/graph'

describe('useCommunityMenuActions', () => {
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
    const table = useCommunityMenuActions()
    expect(findAction()).toBeUndefined()

    table.register()
    expect(findAction()).toBeDefined()

    table.unregister()
    expect(findAction()).toBeUndefined()
  })

  it('is hidden for edges', () => {
    const table = useCommunityMenuActions()
    table.register()

    const communityStore = useCommunityStore()
    communityStore.communityMap = new Map([['n1', 0]])

    expect(findAction()!.visible!({ type: 'edge', id: 'n1', label: 'n1' })).toBe(false)
  })

  it('is hidden for nodes without a detected community', () => {
    const table = useCommunityMenuActions()
    table.register()

    const communityStore = useCommunityStore()
    communityStore.communityMap = new Map([['n1', 0]])

    expect(findAction()!.visible!({ type: 'node', id: 'n2', label: 'n2' })).toBe(false)
  })

  it('is hidden when no communities are detected', () => {
    const table = useCommunityMenuActions()
    table.register()

    expect(findAction()!.visible!({ type: 'node', id: 'n1', label: 'n1' })).toBe(false)
  })

  it('is visible for nodes with a detected community (louvain or cluster program)', () => {
    const table = useCommunityMenuActions()
    table.register()

    const communityStore = useCommunityStore()
    communityStore.communityMap = new Map([['n1', 0], ['n2', 3]])

    expect(findAction()!.visible!({ type: 'node', id: 'n1', label: 'n1' })).toBe(true)
    expect(findAction()!.visible!({ type: 'node', id: 'n2', label: 'n2' })).toBe(true)
  })

  it('handler opens the modal for the node community', async () => {
    const table = useCommunityMenuActions()
    table.register()

    const communityStore = useCommunityStore()
    communityStore.communityMap = new Map([['n1', 0], ['n2', 3]])

    await findAction()!.handler({ type: 'node', id: 'n2', label: 'n2' })
    expect(table.selectedCommunityId.value).toBe(3)
  })

  it('handler keeps community 0 (falsy id) working', async () => {
    const table = useCommunityMenuActions()
    table.register()

    const communityStore = useCommunityStore()
    communityStore.communityMap = new Map([['n1', 0]])

    await findAction()!.handler({ type: 'node', id: 'n1', label: 'n1' })
    expect(table.selectedCommunityId.value).toBe(0)
  })

  it('handler does nothing for unknown nodes', async () => {
    const table = useCommunityMenuActions()
    table.register()

    await findAction()!.handler({ type: 'node', id: 'ghost', label: 'ghost' })
    expect(table.selectedCommunityId.value).toBeNull()
  })

  it('close() clears the selected community', async () => {
    const table = useCommunityMenuActions()
    table.register()

    const communityStore = useCommunityStore()
    communityStore.communityMap = new Map([['n1', 2]])

    await findAction()!.handler({ type: 'node', id: 'n1', label: 'n1' })
    expect(table.selectedCommunityId.value).toBe(2)

    table.close()
    expect(table.selectedCommunityId.value).toBeNull()
  })

  describe('show only', () => {
    const node = (id: string) => ({ type: 'node' as const, id, label: id })
    const byId = (id: string) => ctx.actions.value.find(a => a.id === id)!

    it('register()/unregister() add and remove all four actions', () => {
      const actions = useCommunityMenuActions()
      actions.register()
      for (const id of [ISOLATE_COMMUNITY_ACTION_ID, ISOLATE_CLUSTER_ACTION_ID, CLEAR_ISOLATION_ACTION_ID]) {
        expect(byId(id)).toBeDefined()
      }
      actions.unregister()
      for (const id of [COMMUNITY_TABLE_ACTION_ID, ISOLATE_COMMUNITY_ACTION_ID, ISOLATE_CLUSTER_ACTION_ID, CLEAR_ISOLATION_ACTION_ID]) {
        expect(ctx.actions.value.find(a => a.id === id)).toBeUndefined()
      }
    })

    it('"Show only this community" isolates the node\'s community, with its label', async () => {
      useCommunityMenuActions().register()
      const communityStore = useCommunityStore()
      communityStore.communityMap = new Map([['n1', 4]])
      communityStore.communityLabels = { 4: 'Ring A' }
      const action = byId(ISOLATE_COMMUNITY_ACTION_ID)
      expect(action.visible!(node('n1'))).toBe(true)
      expect(action.visible!(node('n9'))).toBe(false)
      expect(action.visible!({ type: 'edge', id: 'n1', label: '' })).toBe(false)
      await action.handler(node('n1'))
      expect(useGraphStore().isolation).toEqual({ kind: 'community', ids: [4], label: 'Ring A' })
    })

    it('"Show only this cluster" isolates the first cluster holding the node', async () => {
      useCommunityMenuActions().register()
      useClusterStore().clusters = [
        { cluster_id: 'k1', cluster_name: 'People', cluster_class: 'x', figure: 'circle', state: 'open', node_ids: ['n1'] },
      ]
      const action = byId(ISOLATE_CLUSTER_ACTION_ID)
      expect(action.visible!(node('n1'))).toBe(true)
      expect(action.visible!(node('n2'))).toBe(false)
      await action.handler(node('n1'))
      expect(useGraphStore().isolation).toEqual({ kind: 'cluster', ids: ['k1'], label: 'People' })
    })

    it('"Show all nodes" appears only while something is isolated and clears it', async () => {
      useCommunityMenuActions().register()
      const graph = useGraphStore()
      const action = byId(CLEAR_ISOLATION_ACTION_ID)
      expect(action.visible!(node('n1'))).toBe(false)
      graph.isolate({ kind: 'community', ids: [1], label: 'C1' })
      expect(action.visible!(node('n1'))).toBe(true)
      await action.handler(node('n1'))
      expect(graph.isolation).toBeNull()
    })
  })
})
