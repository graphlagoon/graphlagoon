import { describe, it, expect } from 'vitest'
import {
  collectPropertyReferences,
  findDanglingReferences,
  findRawQueryReferences,
} from '@/utils/contextReferences'
import { createExplorationState } from '@/__tests__/fixtures/contexts'
import type { ClusterProgram } from '@/types/cluster'

describe('collectPropertyReferences', () => {
  it('detects a label template reference', () => {
    const state = createExplorationState({
      textFormat: {
        rules: [
          { id: 'r1', name: 'VIP', target: 'node', types: [], template: '{prop:tier}', priority: 0, enabled: true, scope: 'exploration' },
        ],
        defaults: { nodeTemplate: '', edgeTemplate: '' },
      },
    })
    const refs = collectPropertyReferences(state)
    expect(refs).toContainEqual(
      expect.objectContaining({ property: 'tier', kind: 'label-template', certain: true }),
    )
  })

  it('detects default node/edge templates', () => {
    const state = createExplorationState({
      textFormat: {
        rules: [],
        defaults: { nodeTemplate: '{prop:name}', edgeTemplate: '{prop:weight}' },
      },
    })
    const refs = collectPropertyReferences(state)
    const props = refs.map((r) => r.property)
    expect(props).toContain('name')
    expect(props).toContain('weight')
  })

  it('nested conditional templates yield every referenced property', () => {
    const state = createExplorationState({
      textFormat: {
        rules: [
          {
            id: 'r1', name: 'r', target: 'node', types: [], priority: 0, enabled: true, scope: 'exploration',
            template: '{if:prop:score>10|{prop:x}|{prop:y}}',
          },
        ],
        defaults: { nodeTemplate: '', edgeTemplate: '' },
      },
    })
    const props = collectPropertyReferences(state).map((r) => r.property).sort()
    expect(props).toEqual(['score', 'x', 'y'])
  })

  it('a {node_id} built-in without prop: is not reported', () => {
    const state = createExplorationState({
      textFormat: {
        rules: [
          { id: 'r1', name: 'r', target: 'node', types: [], priority: 0, enabled: true, scope: 'exploration', template: '{node_id} {node_type}' },
        ],
        defaults: { nodeTemplate: '', edgeTemplate: '' },
      },
    })
    expect(collectPropertyReferences(state)).toEqual([])
  })

  it('detects an icon config reference', () => {
    const state = createExplorationState({
      nodePropertyIconConfigs: { Person: { property: 'role', valueIcons: {} } },
    })
    const refs = collectPropertyReferences(state)
    expect(refs).toContainEqual(expect.objectContaining({ property: 'role', kind: 'icon-config' }))
  })

  it('detects hive axisKey and positionKey (with or without prop: prefix)', () => {
    const state = createExplorationState({
      layout_mode_config: {
        hive: { axisKey: 'prop:department', maxAxes: 6, positionKey: 'salary', scale: 'linear', innerRadius: 10, outerRadius: 100 },
        ego: {
          focusNodeId: null, direction: 'both', edgeTypes: null, maxHops: null, ringSpacing: 10,
          ringOrdering: 'id', ringOrderingKey: null, crossingHeuristic: 'barycenter', crossingSweeps: 4, arcIntraRingEdges: false,
        },
        hierarchical: { direction: 'td', traversal: 'out', edgeTypes: null, levelSpacing: 100, nodeSpacing: 50 },
      },
    })
    const props = collectPropertyReferences(state).map((r) => r.property).sort()
    expect(props).toEqual(['department', 'salary'])
  })

  it('does not report hive sentinels node_type/community/degree', () => {
    const state = createExplorationState({
      layout_mode_config: {
        hive: { axisKey: 'node_type', maxAxes: 6, positionKey: 'degree', scale: 'linear', innerRadius: 10, outerRadius: 100 },
        ego: {
          focusNodeId: null, direction: 'both', edgeTypes: null, maxHops: null, ringSpacing: 10,
          ringOrdering: 'id', ringOrderingKey: null, crossingHeuristic: 'barycenter', crossingSweeps: 4, arcIntraRingEdges: false,
        },
        hierarchical: { direction: 'td', traversal: 'out', edgeTypes: null, levelSpacing: 100, nodeSpacing: 50 },
      },
    })
    expect(collectPropertyReferences(state)).toEqual([])
  })

  it('detects ego ringOrderingKey only when ringOrdering is property', () => {
    const stateNotUsed = createExplorationState({
      layout_mode_config: {
        hive: { axisKey: 'node_type', maxAxes: 6, positionKey: 'degree', scale: 'linear', innerRadius: 10, outerRadius: 100 },
        ego: {
          focusNodeId: null, direction: 'both', edgeTypes: null, maxHops: null, ringSpacing: 10,
          ringOrdering: 'id', ringOrderingKey: 'prop:score', crossingHeuristic: 'barycenter', crossingSweeps: 4, arcIntraRingEdges: false,
        },
        hierarchical: { direction: 'td', traversal: 'out', edgeTypes: null, levelSpacing: 100, nodeSpacing: 50 },
      },
    })
    expect(collectPropertyReferences(stateNotUsed)).toEqual([])

    const stateUsed = createExplorationState({
      layout_mode_config: {
        hive: { axisKey: 'node_type', maxAxes: 6, positionKey: 'degree', scale: 'linear', innerRadius: 10, outerRadius: 100 },
        ego: {
          focusNodeId: null, direction: 'both', edgeTypes: null, maxHops: null, ringSpacing: 10,
          ringOrdering: 'property', ringOrderingKey: 'prop:score', crossingHeuristic: 'barycenter', crossingSweeps: 4, arcIntraRingEdges: false,
        },
        hierarchical: { direction: 'td', traversal: 'out', edgeTypes: null, levelSpacing: 100, nodeSpacing: 50 },
      },
    })
    expect(collectPropertyReferences(stateUsed)).toContainEqual(
      expect.objectContaining({ property: 'score', kind: 'layout-ego' }),
    )
  })

  it('detects node and edge property filters, ignoring metric: filters', () => {
    const state = createExplorationState({
      filters: {
        node_types: [],
        edge_types: [],
        nodePropertyFilters: [
          { id: 'f1', property: 'age', operator: 'greater_than', value: 18, enabled: true },
          { id: 'f2', property: 'metric:degree', operator: 'greater_than', value: 5, enabled: true },
        ],
        edgePropertyFilters: [
          { id: 'f3', property: 'weight', operator: 'greater_than', value: 1, enabled: true },
        ],
      },
    })
    const refs = collectPropertyReferences(state)
    const props = refs.map((r) => r.property)
    expect(props).toContain('age')
    expect(props).toContain('weight')
    expect(props).not.toContain('metric:degree')
  })

  it('detects a similarity keyProperty, ignoring the node_id sentinel', () => {
    const stateWithKey = createExplorationState({ similarity: { keyProperty: 'embedding' } })
    expect(collectPropertyReferences(stateWithKey)).toContainEqual(
      expect.objectContaining({ property: 'embedding', kind: 'similarity' }),
    )

    const stateDefault = createExplorationState({ similarity: { keyProperty: 'node_id' } })
    expect(collectPropertyReferences(stateDefault)).toEqual([])
  })

  it('detects a cluster program prop: node_binding, passed separately from state', () => {
    const programs: ClusterProgram[] = [
      {
        program_id: 'p1',
        program_name: 'By Region',
        code: 'return [];',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        parameters: [
          { id: 'region', type: 'text', required: false, node_binding: 'prop:region' },
          { id: 'label', type: 'text', required: false, node_binding: 'node_type' },
        ],
      },
    ]
    const refs = collectPropertyReferences(createExplorationState(), programs)
    expect(refs).toContainEqual(expect.objectContaining({ property: 'region', kind: 'cluster-binding' }))
    expect(refs.map((r) => r.property)).not.toContain('node_type')
  })
})

describe('findDanglingReferences', () => {
  it('filters to references not present in the known column set', () => {
    const refs = [
      { location: 'a', property: 'name', kind: 'label-template' as const, certain: true },
      { location: 'b', property: 'gone', kind: 'label-template' as const, certain: true },
    ]
    const dangling = findDanglingReferences(refs, new Set(['name']))
    expect(dangling).toHaveLength(1)
    expect(dangling[0].property).toBe('gone')
  })
})

describe('findRawQueryReferences', () => {
  it('matches a removed column as a whole word', () => {
    const refs = findRawQueryReferences(
      ['name'],
      [{ location: 'graph_query', text: 'MATCH (n) WHERE n.name = "x" RETURN n' }],
    )
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ property: 'name', kind: 'raw-query', certain: false })
  })

  it('word boundaries hold — removing "name" does not flag "full_name"', () => {
    const refs = findRawQueryReferences(
      ['name'],
      [{ location: 'graph_query', text: 'MATCH (n) WHERE n.full_name = "x" RETURN n' }],
    )
    expect(refs).toEqual([])
  })

  it('skips null/undefined query text', () => {
    const refs = findRawQueryReferences(['name'], [{ location: 'graph_query', text: undefined }])
    expect(refs).toEqual([])
  })
})
