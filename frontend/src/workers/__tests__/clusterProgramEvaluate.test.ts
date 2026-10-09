/**
 * Pure side of the cluster-program sandbox: the context the user code sees
 * and the `metric(ref, id)` lookup rebuilt from shipped values.
 */
import { describe, it, expect } from 'vitest'
import {
  buildMetricLookup,
  evaluateClusterProgram,
  programUsesMetricLookup,
} from '@/workers/clusterProgramEvaluate'
import type { ClusterProgramSnapshot } from '@/types/cluster'

const snapshot: ClusterProgramSnapshot = {
  nodes: [
    { node_id: 'n1', node_type: 'A' },
    { node_id: 'n2', node_type: 'B' },
  ],
  edges: [{ edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'R' }],
  selectedNodeIds: ['n2'],
  selectedEdgeIds: [],
  params: { k: 3 },
  metrics: [
    { id: 'm-shared-node', name: 'Score', target: 'node', valueType: 'number', values: [['n1', 0.9]] },
    { id: 'm-shared-edge', name: 'Score', target: 'edge', valueType: 'number', values: [['e1', 7]] },
  ],
}

describe('evaluateClusterProgram', () => {
  it('exposes nodes, edges, selection and params', () => {
    const out = evaluateClusterProgram(
      'return [nodes.length, edges.length, selectedNodeIds[0], params.k]',
      snapshot,
    )
    expect(out).toEqual([2, 1, 'n2', 3])
  })

  it('runs in strict mode and propagates user errors', () => {
    expect(() => evaluateClusterProgram('undeclared = 1; return []', snapshot)).toThrow(ReferenceError)
    expect(() => evaluateClusterProgram('throw new Error("boom")', snapshot)).toThrow('boom')
  })

  it('exposes the metric list without values', () => {
    const out = evaluateClusterProgram('return metrics', snapshot) as Array<Record<string, unknown>>
    expect(out[0]).toEqual({ id: 'm-shared-node', name: 'Score', target: 'node', valueType: 'number' })
    expect(out[0]).not.toHaveProperty('values')
  })
})

describe('buildMetricLookup', () => {
  const metric = buildMetricLookup(snapshot.metrics)

  it('resolves names node-first, then edge', () => {
    expect(metric('Score', 'n1')).toBe(0.9)
    expect(metric('Score', 'e1')).toBe(7)
  })

  it('resolves ids regardless of name collisions', () => {
    expect(metric('m-shared-edge', 'e1')).toBe(7)
    expect(metric('m-shared-edge', 'n1')).toBeUndefined()
  })

  it('unknown metrics and items are undefined', () => {
    expect(metric('nope', 'n1')).toBeUndefined()
    expect(metric('Score', 'zzz')).toBeUndefined()
  })
})

describe('programUsesMetricLookup', () => {
  it('detects metric( but not metrics', () => {
    expect(programUsesMetricLookup("metric('x', id)")).toBe(true)
    expect(programUsesMetricLookup('const m = metric; m()')).toBe(true)
    expect(programUsesMetricLookup('return metrics.map(m => m.name)')).toBe(false)
  })
})
