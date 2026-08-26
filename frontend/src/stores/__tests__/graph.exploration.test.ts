import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'
import { useClusterStore } from '@/stores/cluster'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('exploration state serialization', () => {
  describe('behavior persistence', () => {
    it('serializes the default into the exploration state', () => {
      const store = useGraphStore()

      const state = store.getExplorationState()

      expect(state.behaviors?.mapStylePan).toBe(true)
    })

    it('serializes an opt-out into the exploration state', () => {
      const store = useGraphStore()
      store.updateBehaviors({ mapStylePan: false })

      const state = store.getExplorationState()

      expect(state.behaviors?.mapStylePan).toBe(false)
    })

    it('restores a saved behavior when loading an exploration', () => {
      const store = useGraphStore()
      // Save the NON-default value, so a successful restore can't be confused
      // with the default simply leaking through.
      store.updateBehaviors({ mapStylePan: false })
      const saved = store.getExplorationState()

      // Simulate a fresh session, then restore the saved behaviors.
      setActivePinia(createPinia())
      const restored = useGraphStore()
      expect(restored.behaviors.mapStylePan).toBe(true)

      restored.updateBehaviors(saved.behaviors as Partial<typeof restored.behaviors>)

      expect(restored.behaviors.mapStylePan).toBe(false)
    })

    it('explorations saved before a setting existed keep the default for it', () => {
      const store = useGraphStore()

      // An exploration saved before a setting existed has no such key, so the
      // merge-over-defaults restore falls through to the default — no migration needed,
      // and its other saved behaviors are untouched.
      const legacyBehaviors = { edgeLensMode: 'hide' as const, focusDepth: 2 }
      store.updateBehaviors(legacyBehaviors)

      expect(store.behaviors.mapStylePan).toBe(true)
      expect(store.behaviors.edgeLensMode).toBe('hide')
    })

    it('serializes behaviors exactly once, via the style-preset block', () => {
      // The explicit `behaviors:` field was removed from getExplorationState when
      // buildStylePreset grew one — two spellings of the same field is a trap.
      const store = useGraphStore()
      store.updateBehaviors({ focusDepth: 3 })

      const state = store.getExplorationState()
      const preset = store.buildStylePreset()

      expect(state.behaviors).toEqual(preset.behaviors)
    })

    it('restores an old exploration through the validated merge', () => {
      // Old explorations stored behaviors at the top level of state — exactly
      // the object applyStylePreset receives — so a stale or corrupt key must
      // be dropped instead of landing in the store unchecked.
      const store = useGraphStore()

      store.applyStylePreset({
        behaviors: { mapStylePan: false, removedSetting: true, viewMode: 'banana' },
      } as never)

      expect(store.behaviors.mapStylePan).toBe(false)
      expect(store.behaviors).not.toHaveProperty('removedSetting')
      expect(store.behaviors.viewMode).not.toBe('banana')
    })
  })

  describe('property visibility persistence', () => {
    it('serializes the allowlist into the exploration state', () => {
      const store = useGraphStore()
      store.setPropertyVisibility('node', ['name', 'age'])

      const state = store.getExplorationState()

      expect(state.property_visibility).toEqual({
        nodeProperties: ['name', 'age'],
        edgeProperties: null,
      })
    })

    it('explorations saved before the allowlist existed show all properties', () => {
      const store = useGraphStore()
      store.setPropertyVisibility('node', ['name'])

      // An old exploration's state has no property_visibility key.
      store.applyStylePreset({ aesthetics: {} } as never)

      expect(store.propertyVisibility).toEqual({ nodeProperties: null, edgeProperties: null })
    })
  })

  describe('force3DSettings persistence', () => {
    it('serializes the default into the exploration state', () => {
      const store = useGraphStore()

      const state = store.getExplorationState()

      expect(state.force3d_settings?.d3ChargeStrength).toBe(-80)
    })

    it('serializes an updated value into the exploration state', () => {
      const store = useGraphStore()
      store.updateForce3DSettings({ d3ChargeStrength: -200 })

      const state = store.getExplorationState()

      expect(state.force3d_settings?.d3ChargeStrength).toBe(-200)
    })

    it('restores saved force3DSettings when loading an exploration', () => {
      const store = useGraphStore()
      store.updateForce3DSettings({ d3ChargeStrength: -200, d3GravityStrength: 0.1 })
      const saved = store.getExplorationState()

      // Simulate a fresh session, then restore the saved settings the way
      // loadExploration merges them over the current defaults.
      setActivePinia(createPinia())
      const restored = useGraphStore()
      expect(restored.force3DSettings.d3ChargeStrength).toBe(-80)

      restored.updateForce3DSettings(
        saved.force3d_settings as Partial<typeof restored.force3DSettings>
      )

      expect(restored.force3DSettings.d3ChargeStrength).toBe(-200)
      expect(restored.force3DSettings.d3GravityStrength).toBe(0.1)
    })

    it('explorations saved before the field existed keep the defaults', () => {
      const store = useGraphStore()

      expect(store.force3DSettings.d3ChargeStrength).toBe(-80)
      expect(store.force3DSettings.d3LinkDistance).toBe(30)
    })
  })

  describe('getExplorationState', () => {
    it('captures current filters', () => {
      const store = useGraphStore()
      store.applyFilters({ node_types: ['Person'], edge_types: ['KNOWS'] })

      const state = store.getExplorationState()
      expect(state.filters.node_types).toEqual(['Person'])
      expect(state.filters.edge_types).toEqual(['KNOWS'])
    })

    it('captures viewport state', () => {
      const store = useGraphStore()
      store.viewport = { zoom: 2.5, center_x: 100, center_y: -50 }

      const state = store.getExplorationState()
      expect(state.viewport.zoom).toBe(2.5)
      expect(state.viewport.center_x).toBe(100)
      expect(state.viewport.center_y).toBe(-50)
    })

    it('captures layout_algorithm', () => {
      const store = useGraphStore()
      store.setLayoutAlgorithm('circular')

      const state = store.getExplorationState()
      expect(state.layout_algorithm).toBe('circular')
    })

    it('captures the new layout modes (ego, hive)', () => {
      const store = useGraphStore()
      store.setLayoutAlgorithm('ego')

      const state = store.getExplorationState()
      expect(state.layout_algorithm).toBe('ego')
    })

    it('captures layout_mode_config with per-mode settings', () => {
      const store = useGraphStore()
      store.updateLayoutModeConfig({
        ego: { focusNodeId: 'acct-42', direction: 'out', maxHops: 2 },
        hive: { positionKey: 'prop:risk_score', scale: 'log' },
      })

      const state = store.getExplorationState()
      expect(state.layout_mode_config?.ego.focusNodeId).toBe('acct-42')
      expect(state.layout_mode_config?.ego.direction).toBe('out')
      expect(state.layout_mode_config?.ego.maxHops).toBe(2)
      expect(state.layout_mode_config?.hive.positionKey).toBe('prop:risk_score')
      expect(state.layout_mode_config?.hive.scale).toBe('log')
      // Untouched settings keep their defaults
      expect(state.layout_mode_config?.ego.ringSpacing).toBe(60)
      expect(state.layout_mode_config?.hive.axisKey).toBe('node_type')
    })

    it('serializes a snapshot, not the live config object', () => {
      const store = useGraphStore()
      const state = store.getExplorationState()

      store.updateLayoutModeConfig({ ego: { maxHops: 5 } })

      expect(state.layout_mode_config?.ego.maxHops).toBeNull()
    })

    it('captures graph_query when set', () => {
      const store = useGraphStore()
      store.setGraphQuery('SELECT * FROM nodes')

      const state = store.getExplorationState()
      expect(state.graph_query).toBe('SELECT * FROM nodes')
    })

    it('graph_query is undefined when empty', () => {
      const store = useGraphStore()
      const state = store.getExplorationState()
      expect(state.graph_query).toBeUndefined()
    })

    it('captures procedural BFS optimization flags', () => {
      const store = useGraphStore()
      store.vlpRenderingMode = 'procedural'
      store.proceduralOptimizations = {
        ...store.proceduralOptimizations,
        visited_not_exists: false,
        undirected_union_all: true,
        undirected_doubled_adjacency: false,
      }

      const state = store.getExplorationState()
      expect(state.procedural_optimizations?.visited_not_exists).toBe(false)
      expect(state.procedural_optimizations?.undirected_union_all).toBe(true)
      // getExplorationState snapshots a copy, not the live ref
      expect(state.procedural_optimizations).not.toBe(store.proceduralOptimizations)
    })

    it('captures textFormat state', () => {
      const store = useGraphStore()
      store.addTextFormatRule({
        name: 'Test Rule',
        target: 'node',
        types: ['Person'],
        template: '{node_id|upper}',
        priority: 1,
        enabled: true,
        scope: 'exploration',
      })

      const state = store.getExplorationState()
      expect(state.textFormat).toBeDefined()
      expect(state.textFormat!.rules).toHaveLength(1)
      expect(state.textFormat!.rules[0].template).toBe('{node_id|upper}')
    })

    it('captures cluster state', () => {
      const clusterStore = useClusterStore()
      clusterStore.createCluster({
        cluster_id: 'c1',
        cluster_name: 'Test',
        cluster_class: 'x',
        figure: 'circle',
        state: 'closed',
        node_ids: ['n1'],
      })

      const graphStore = useGraphStore()
      const state = graphStore.getExplorationState()
      expect(state.clusters).toBeDefined()
      expect(state.clusters.clusters).toHaveLength(1)
    })

    it('nodes and edges arrays are empty (regenerated from query)', () => {
      const store = useGraphStore()
      store.nodes = [{ node_id: 'n1', node_type: 'T' }]
      store.edges = [{ edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'R' }]

      const state = store.getExplorationState()
      expect(state.nodes).toHaveLength(0)
      expect(state.edges).toHaveLength(0)
    })
  })

  describe('text format state round-trip', () => {
    it('getTextFormatState / loadTextFormatState round-trip', () => {
      const store = useGraphStore()

      // Set up rules
      store.addTextFormatRule({
        name: 'Rule1',
        target: 'node',
        types: [],
        template: '{node_type}: {node_id}',
        priority: 10,
        enabled: true,
        scope: 'global',
      })
      store.updateTextFormatDefaults({ nodeTemplate: '{node_type}' })

      const state = store.getTextFormatState()

      // Reset and reload
      store.loadTextFormatState(undefined)
      expect(store.textFormatRules).toHaveLength(0)
      expect(store.textFormatDefaults.nodeTemplate).toBe('{node_id|truncate:10:...}')

      store.loadTextFormatState(state)
      expect(store.textFormatRules).toHaveLength(1)
      expect(store.textFormatRules[0].template).toBe('{node_type}: {node_id}')
      expect(store.textFormatDefaults.nodeTemplate).toBe('{node_type}')
    })

    it('loadTextFormatState with undefined resets to defaults', () => {
      const store = useGraphStore()
      store.addTextFormatRule({
        name: 'Rule',
        target: 'node',
        types: [],
        template: 'x',
        priority: 1,
        enabled: true,
        scope: 'global',
      })

      store.loadTextFormatState(undefined)
      expect(store.textFormatRules).toHaveLength(0)
      expect(store.textFormatDefaults.nodeTemplate).toBe('{node_id|truncate:10:...}')
      expect(store.textFormatDefaults.edgeTemplate).toBe('{relationship_type}')
    })

    it('getTextFormatState stamps the current syntax version', () => {
      const store = useGraphStore()
      expect(store.getTextFormatState().syntaxVersion).toBe(2)
    })

    it('loads v1 state (no syntaxVersion) without complaint', () => {
      const store = useGraphStore()
      store.loadTextFormatState({
        rules: [],
        defaults: { nodeTemplate: '{node_id}', edgeTemplate: '{relationship_type}' },
      })
      expect(store.textFormatDefaults.nodeTemplate).toBe('{node_id}')
    })

    it('warns when loading state from a newer syntax version', () => {
      const store = useGraphStore()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      store.loadTextFormatState({
        rules: [],
        defaults: { nodeTemplate: '{node_id}', edgeTemplate: '{relationship_type}' },
        syntaxVersion: 99,
      })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('newer syntax version'))
      warnSpy.mockRestore()
    })
  })

  describe('text format rule management', () => {
    it('addTextFormatRule generates an ID', () => {
      const store = useGraphStore()
      const rule = store.addTextFormatRule({
        name: 'New',
        target: 'node',
        types: [],
        template: '{node_id}',
        priority: 1,
        enabled: true,
        scope: 'global',
      })
      expect(rule.id).toBeTruthy()
      expect(store.textFormatRules).toHaveLength(1)
    })

    it('updateTextFormatRule modifies existing', () => {
      const store = useGraphStore()
      const rule = store.addTextFormatRule({
        name: 'Old',
        target: 'node',
        types: [],
        template: 'old',
        priority: 1,
        enabled: true,
        scope: 'global',
      })
      store.updateTextFormatRule(rule.id, { template: 'new' })
      expect(store.textFormatRules[0].template).toBe('new')
    })

    it('removeTextFormatRule removes', () => {
      const store = useGraphStore()
      const rule = store.addTextFormatRule({
        name: 'Del',
        target: 'node',
        types: [],
        template: 'x',
        priority: 1,
        enabled: true,
        scope: 'global',
      })
      store.removeTextFormatRule(rule.id)
      expect(store.textFormatRules).toHaveLength(0)
    })

    it('reorderTextFormatRules updates priorities', () => {
      const store = useGraphStore()
      const r1 = store.addTextFormatRule({ name: 'A', target: 'node', types: [], template: 'a', priority: 1, enabled: true, scope: 'global' })
      const r2 = store.addTextFormatRule({ name: 'B', target: 'node', types: [], template: 'b', priority: 2, enabled: true, scope: 'global' })

      // Reorder: B first, then A
      store.reorderTextFormatRules([r2.id, r1.id])

      // B should now have higher priority (2), A lower (1)
      const ruleB = store.textFormatRules.find(r => r.id === r2.id)
      const ruleA = store.textFormatRules.find(r => r.id === r1.id)
      expect(ruleB!.priority).toBeGreaterThan(ruleA!.priority)
    })
  })

  describe('transpile options reset on clear', () => {
    it('procedural BFS is the default rendering mode for a fresh store', () => {
      const store = useGraphStore()
      expect(store.vlpRenderingMode).toBe('procedural')
    })

    it('clear() restores procedural default after an exploration set cte', () => {
      const store = useGraphStore()
      // Simulate opening an exploration saved with the legacy CTE mode.
      store.vlpRenderingMode = 'cte'

      // Opening a new context runs clear() between explorations.
      store.clear()

      expect(store.vlpRenderingMode).toBe('procedural')
    })

    it('clear() restores default procedural optimization flags', () => {
      const store = useGraphStore()
      store.proceduralOptimizations = {
        ...store.proceduralOptimizations,
        visited_not_exists: false,
        undirected_union_all: true,
      }

      store.clear()

      expect(store.proceduralOptimizations.visited_not_exists).toBe(true)
      expect(store.proceduralOptimizations.undirected_union_all).toBe(false)
    })

    it('resetTranspileOptions() re-enables procedural BFS', () => {
      const store = useGraphStore()
      store.vlpRenderingMode = 'cte'

      store.resetTranspileOptions()

      expect(store.vlpRenderingMode).toBe('procedural')
    })
  })
})
