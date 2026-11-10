import { describe, it, expect } from 'vitest'
import {
  resolveIsolation,
  mergeIsolation,
  subtractIsolation,
  isIsolationRule,
  nodeFieldValue,
  type IsolationRule,
} from '@/utils/isolation'
import type { Node } from '@/types/graph'
import type { MetricResolver } from '@/utils/labelFormatter'

const nodes: Node[] = [
  { node_id: 'a', node_type: 'Person', properties: { branch: 'x' } },
  { node_id: 'b', node_type: 'Person', properties: { branch: 'y' } },
  { node_id: 'c', node_type: 'Company', properties: { branch: 'x' } },
  { node_id: 'd', node_type: 'Company', properties: {} },
]
const communityMap = new Map([['a', 0], ['b', 0], ['c', 1], ['d', 2]])
const clusters = [
  { cluster_id: 'k1', node_ids: ['a', 'd'] },
  { cluster_id: 'k2', node_ids: ['b'] },
]
const metrics: MetricResolver = (_t, id, ref) => (ref === 'degree' ? ({ a: 2, b: 1, c: 2, d: null } as Record<string, number | null>)[id] : undefined)
const src = { nodes, communityMap, clusters, metrics }

const ids = (s: Set<string> | null) => (s ? [...s].sort() : null)

describe('resolveIsolation', () => {
  it('community: the nodes of the named communities', () => {
    expect(ids(resolveIsolation({ kind: 'community', ids: [0, 2], label: '' }, src))).toEqual(['a', 'b', 'd'])
  })

  it('community: null when there are no communities (cleared or not restored yet)', () => {
    expect(resolveIsolation({ kind: 'community', ids: [0], label: '' }, { ...src, communityMap: new Map() })).toBeNull()
  })

  it('cluster: the members of the named clusters', () => {
    expect(ids(resolveIsolation({ kind: 'cluster', ids: ['k1'], label: '' }, src))).toEqual(['a', 'd'])
  })

  it('cluster: null when none of the clusters exists any more', () => {
    expect(resolveIsolation({ kind: 'cluster', ids: ['gone'], label: '' }, src)).toBeNull()
  })

  it('value same: a property equal to the value', () => {
    expect(ids(resolveIsolation({ kind: 'value', field: 'branch', value: 'x', mode: 'same', label: '' }, src))).toEqual(['a', 'c'])
  })

  it('value has: the property is set', () => {
    expect(ids(resolveIsolation({ kind: 'value', field: 'branch', value: null, mode: 'has', label: '' }, src))).toEqual(['a', 'b', 'c'])
  })

  it('value on node_type and on a metric', () => {
    expect(ids(resolveIsolation({ kind: 'value', field: 'node_type', value: 'Company', mode: 'same', label: '' }, src))).toEqual(['c', 'd'])
    expect(ids(resolveIsolation({ kind: 'value', field: 'metric:degree', value: '2', mode: 'same', label: '' }, src))).toEqual(['a', 'c'])
    expect(ids(resolveIsolation({ kind: 'value', field: 'metric:degree', value: null, mode: 'has', label: '' }, src))).toEqual(['a', 'b', 'c'])
  })

  it('nodeFieldValue reads like the labels ("" when missing)', () => {
    expect(nodeFieldValue(nodes[0], 'branch')).toBe('x')
    expect(nodeFieldValue(nodes[3], 'branch')).toBe('')
    expect(nodeFieldValue(nodes[0], 'metric:degree', metrics)).toBe('2')
  })
})

describe('mergeIsolation / subtractIsolation', () => {
  it('unions ids of the same kind', () => {
    const merged = mergeIsolation({ kind: 'community', ids: [0], label: 'C0' }, { kind: 'community', ids: [1, 0], label: 'C1' })
    expect(merged).toEqual({ kind: 'community', ids: [0, 1], label: '2 communities' })
    const clusters2 = mergeIsolation({ kind: 'cluster', ids: ['k1'], label: 'K1' }, { kind: 'cluster', ids: ['k2'], label: 'K2' })
    expect(clusters2).toEqual({ kind: 'cluster', ids: ['k1', 'k2'], label: '2 clusters' })
  })

  it('a different kind (or nothing yet) replaces', () => {
    const next: IsolationRule = { kind: 'value', field: 'branch', value: 'x', mode: 'same', label: 'branch = x' }
    expect(mergeIsolation({ kind: 'community', ids: [0], label: 'C0' }, next)).toBe(next)
    expect(mergeIsolation(null, next)).toBe(next)
  })

  it('subtract removes an id, relabels, and ends at null', () => {
    const labelOf = (id: number | string) => `C${id}`
    const two: IsolationRule = { kind: 'community', ids: [0, 1], label: '2 communities' }
    expect(subtractIsolation(two, 'community', 1, labelOf)).toEqual({ kind: 'community', ids: [0], label: 'C0' })
    expect(subtractIsolation({ kind: 'community', ids: [0], label: 'C0' }, 'community', 0, labelOf)).toBeNull()
    // Another kind is left alone.
    expect(subtractIsolation(two, 'cluster', 'k1', labelOf)).toBe(two)
    expect(subtractIsolation(null, 'community', 0, labelOf)).toBeNull()
  })
})

describe('isIsolationRule', () => {
  it('accepts the three shapes', () => {
    expect(isIsolationRule({ kind: 'community', ids: [1], label: 'x' })).toBe(true)
    expect(isIsolationRule({ kind: 'cluster', ids: ['a'], label: 'x' })).toBe(true)
    expect(isIsolationRule({ kind: 'value', field: 'f', value: null, mode: 'has', label: 'x' })).toBe(true)
  })

  it('rejects anything else (saved states are untrusted)', () => {
    expect(isIsolationRule(null)).toBe(false)
    expect(isIsolationRule('x')).toBe(false)
    expect(isIsolationRule({ kind: 'community', ids: ['1'], label: 'x' })).toBe(false)
    expect(isIsolationRule({ kind: 'cluster', ids: [1], label: 'x' })).toBe(false)
    expect(isIsolationRule({ kind: 'value', field: 'f', value: 1, mode: 'same', label: 'x' })).toBe(false)
    expect(isIsolationRule({ kind: 'value', field: 'f', value: 'v', mode: 'other', label: 'x' })).toBe(false)
    expect(isIsolationRule({ kind: 'community', ids: [1] })).toBe(false)
    expect(isIsolationRule({ kind: 'nope', label: 'x' })).toBe(false)
  })
})
