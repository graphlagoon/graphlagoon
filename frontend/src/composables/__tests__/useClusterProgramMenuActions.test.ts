import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import {
  useClusterProgramMenuActions,
  CLUSTER_PROGRAM_ACTION_PREFIX,
} from '@/composables/useClusterProgramMenuActions'
import { useContextMenu } from '@/composables/useContextMenu'
import { useToast } from '@/composables/useToast'
import { useClusterStore } from '@/stores/cluster'
import { useCommunityStore } from '@/stores/community'
import { useGraphStore } from '@/stores/graph'
import type { ContextMenuTarget } from '@/composables/useContextMenu'

const BFS_ID = 'default-bfs-from-node'
const BFS_ACTION_ID = CLUSTER_PROGRAM_ACTION_PREFIX + BFS_ID

function nodeTarget(id: string): ContextMenuTarget {
  return { type: 'node', id, label: id }
}

/** Seed graph nodes/edges and flush the community store's nodes watcher. */
async function setupGraph() {
  const graphStore = useGraphStore()
  useCommunityStore()
  graphStore.nodes = [
    { node_id: 'n1', node_type: 'Person', properties: { id_simples: 'S1' } },
    { node_id: 'n2', node_type: 'Person' },
    { node_id: 'n3', node_type: 'Company' },
    { node_id: 'n4', node_type: 'Company' },
  ]
  graphStore.edges = [
    { edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'KNOWS' },
    { edge_id: 'e2', src: 'n3', dst: 'n4', relationship_type: 'PARTNER' },
  ]
  await nextTick()
  return graphStore
}

function programActions() {
  const contextMenu = useContextMenu()
  return contextMenu.actions.value.filter(a => a.id.startsWith(CLUSTER_PROGRAM_ACTION_PREFIX))
}

beforeEach(() => {
  setActivePinia(createPinia())
  useContextMenu().resetActions()
  useToast().toasts.value.splice(0)
})

describe('useClusterProgramMenuActions', () => {
  describe('registration & reconciliation', () => {
    it('register adds one action per flagged program (BFS default flagged out of the box)', () => {
      const menu = useClusterProgramMenuActions()
      menu.register()

      const actions = programActions()
      expect(actions).toHaveLength(1)
      expect(actions[0].id).toBe(BFS_ACTION_ID)
      expect(actions[0].label).toBe('BFS from Node')
    })

    it('reconciles when a program is flagged or unflagged', async () => {
      const clusterStore = useClusterStore()
      const menu = useClusterProgramMenuActions()
      menu.register()

      const prog = clusterStore.createProgram({
        program_name: 'Custom',
        code: 'return []',
        show_in_context_menu: true,
      })
      await nextTick()
      expect(programActions()).toHaveLength(2)

      clusterStore.updateProgram(prog.program_id, { show_in_context_menu: false })
      await nextTick()
      expect(programActions()).toHaveLength(1)
    })

    it('reconciles on delete and rename', async () => {
      const clusterStore = useClusterStore()
      const menu = useClusterProgramMenuActions()
      menu.register()

      clusterStore.updateProgram(BFS_ID, { program_name: 'Renamed BFS' })
      await nextTick()
      expect(programActions()[0].label).toBe('Renamed BFS')

      // Built-in defaults cannot be deleted — the action stays
      clusterStore.deleteProgram(BFS_ID)
      await nextTick()
      expect(programActions()).toHaveLength(1)

      // A custom flagged program IS removed on delete
      const custom = clusterStore.createProgram({
        program_name: 'Custom',
        code: 'return []',
        show_in_context_menu: true,
      })
      await nextTick()
      expect(programActions()).toHaveLength(2)

      clusterStore.deleteProgram(custom.program_id)
      await nextTick()
      expect(programActions()).toHaveLength(1)
    })

    it('reconciles when loadState merges saved programs in', async () => {
      const clusterStore = useClusterStore()
      const menu = useClusterProgramMenuActions()
      menu.register()
      expect(programActions()).toHaveLength(1)

      clusterStore.loadState({
        programs: [{
          program_id: 'loaded',
          program_name: 'Loaded Program',
          code: 'return []',
          show_in_context_menu: true,
          created_at: '',
          updated_at: '',
        }],
        clusters: [],
        executions: [],
      })
      await nextTick()

      // Programs merge (defaults survive): the flagged BFS default + the loaded one
      const labels = programActions().map(a => a.label)
      expect(labels).toHaveLength(2)
      expect(labels).toContain('Loaded Program')
    })

    it('unregister removes all actions; re-register does not duplicate', () => {
      const menu = useClusterProgramMenuActions()
      menu.register()
      menu.register()
      expect(programActions()).toHaveLength(1)

      menu.unregister()
      expect(programActions()).toHaveLength(0)
    })
  })

  describe('visible / disabled predicates', () => {
    it('visible only for node targets that exist in graphStore.nodes', async () => {
      await setupGraph()
      const menu = useClusterProgramMenuActions()
      menu.register()

      const action = programActions()[0]
      expect(action.visible!(nodeTarget('n1'))).toBe(true)
      expect(action.visible!({ type: 'edge', id: 'e1', label: 'e1' })).toBe(false)
      // Cluster synthetic node ids are not in graphStore.nodes
      expect(action.visible!(nodeTarget('cluster-xyz'))).toBe(false)
    })

    it('disabled while community detection is computing', () => {
      const communityStore = useCommunityStore()
      const menu = useClusterProgramMenuActions()
      menu.register()

      const action = programActions()[0]
      expect(action.disabled!(nodeTarget('n1'))).toBe(false)
      communityStore.computing = true
      expect(action.disabled!(nodeTarget('n1'))).toBe(true)
    })
  })

  describe('runProgramForNode', () => {
    it('runs the program as community algorithm with defaults + node-bound values', async () => {
      await setupGraph()
      const communityStore = useCommunityStore()
      const menu = useClusterProgramMenuActions()
      menu.register()

      await menu.runProgramForNode(BFS_ID, 'n1')

      expect(communityStore.algorithm).toBe(`cluster-program:${BFS_ID}`)
      // Defaults (depth '3', group_by_level false) + bound start_node_id from the clicked node
      expect(communityStore.programParams[BFS_ID]).toEqual({
        start_node_id: 'n1',
        depth: '3',
        group_by_level: false,
      })
      // BFS(n1) = {n1, n2}; n3/n4 → Others
      expect(communityStore.communityCount).toBe(2)
      expect(communityStore.communityMap.get('n1')).toBe(0)
      expect(communityStore.communityMap.get('n4')).toBe(1)

      const { toasts } = useToast()
      const last = toasts.value.at(-1)
      expect(last?.type).toBe('success')
      expect(last?.message).toMatch(/^2 communities: /)
      expect(last?.message).toContain('BFS from n1')
      expect(last?.message).toContain('Others')
    })

    it('errors with a clear toast when a bound property is missing on the node', async () => {
      await setupGraph()
      const clusterStore = useClusterStore()
      const communityStore = useCommunityStore()
      const menu = useClusterProgramMenuActions()
      menu.register()

      const prog = clusterStore.createProgram({
        program_name: 'Prop Bound',
        code: `return [{ cluster_name: params.simple, node_ids: [] }]`,
        show_in_context_menu: true,
        parameters: [
          { id: 'simple', type: 'text', required: true, node_binding: 'prop:id_simples' },
        ],
      })

      // n2 has no properties at all → binding unresolvable
      await menu.runProgramForNode(prog.program_id, 'n2')

      const { toasts } = useToast()
      const last = toasts.value.at(-1)
      expect(last?.type).toBe('error')
      expect(last?.message).toContain('Prop Bound')
      expect(last?.message).toContain('property "id_simples"')
      expect(last?.message).toContain('simple')
      // Detection never ran
      expect(communityStore.hasResults).toBe(false)
    })

    it('errors when the program no longer exists', async () => {
      await setupGraph()
      const menu = useClusterProgramMenuActions()

      await menu.runProgramForNode('deleted-program', 'n1')

      const last = useToast().toasts.value.at(-1)
      expect(last?.type).toBe('error')
      expect(last?.message).toContain('no longer exists')
    })

    it('errors when the node is not in the graph store', async () => {
      await setupGraph()
      const menu = useClusterProgramMenuActions()

      await menu.runProgramForNode(BFS_ID, 'ghost-node')

      const last = useToast().toasts.value.at(-1)
      expect(last?.type).toBe('error')
      expect(last?.message).toContain('ghost-node')
    })

    it('surfaces program execution failures (communityStore.error) as an error toast', async () => {
      await setupGraph()
      const clusterStore = useClusterStore()
      const menu = useClusterProgramMenuActions()

      const prog = clusterStore.createProgram({
        program_name: 'Broken',
        code: 'throw new Error("boom")',
        show_in_context_menu: true,
      })

      await menu.runProgramForNode(prog.program_id, 'n1')

      const last = useToast().toasts.value.at(-1)
      expect(last?.type).toBe('error')
      expect(last?.message).toContain('boom')
    })
  })
})
