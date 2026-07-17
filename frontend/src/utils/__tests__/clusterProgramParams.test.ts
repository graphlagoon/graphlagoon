import { describe, it, expect } from 'vitest'
import {
  defaultParamValues,
  missingRequiredParams,
  resolveParamValues,
  resolveNodeBoundValues,
} from '@/utils/clusterProgramParams'
import { createClusterProgramParameter } from '@/__tests__/fixtures/clusters'

describe('defaultParamValues', () => {
  it('returns empty object for undefined/empty declarations', () => {
    expect(defaultParamValues(undefined)).toEqual({})
    expect(defaultParamValues([])).toEqual({})
  })

  it('seeds declared defaults', () => {
    const params = [
      createClusterProgramParameter({ id: 'threshold', type: 'number', default: 5 }),
      createClusterProgramParameter({ id: 'mode', type: 'select', options: ['a', 'b'], default: 'a' }),
    ]
    expect(defaultParamValues(params)).toEqual({ threshold: 5, mode: 'a' })
  })

  it('omits params without a default (except boolean)', () => {
    const params = [
      createClusterProgramParameter({ id: 'name', type: 'text', default: undefined }),
      createClusterProgramParameter({ id: 'flag', type: 'boolean', default: undefined }),
      createClusterProgramParameter({ id: 'on', type: 'boolean', default: true }),
    ]
    expect(defaultParamValues(params)).toEqual({ flag: false, on: true })
  })
})

describe('missingRequiredParams', () => {
  it('flags required params with no value or empty string', () => {
    const params = [
      createClusterProgramParameter({ id: 'a', type: 'text', required: true, default: undefined }),
      createClusterProgramParameter({ id: 'b', type: 'text', required: true, default: undefined }),
      createClusterProgramParameter({ id: 'c', type: 'text', required: false, default: undefined }),
    ]
    const missing = missingRequiredParams(params, { a: '  ', b: 'ok' })
    expect(missing.map(p => p.id)).toEqual(['a'])
  })

  it('never flags boolean params', () => {
    const params = [
      createClusterProgramParameter({ id: 'flag', type: 'boolean', required: true, default: undefined }),
    ]
    expect(missingRequiredParams(params, {})).toEqual([])
  })

  it('accepts number 0 as a value', () => {
    const params = [
      createClusterProgramParameter({ id: 'n', type: 'number', required: true, default: undefined }),
    ]
    expect(missingRequiredParams(params, { n: 0 })).toEqual([])
  })
})

describe('resolveParamValues', () => {
  it('resolves defaults when no values provided', () => {
    const params = [
      createClusterProgramParameter({ id: 'threshold', type: 'number', default: 3 }),
      createClusterProgramParameter({ id: 'flag', type: 'boolean', default: undefined }),
    ]
    const result = resolveParamValues(params)
    expect(result).toEqual({ success: true, params: { threshold: 3, flag: false } })
  })

  it('overlays provided values on top of defaults', () => {
    const params = [
      createClusterProgramParameter({ id: 'threshold', type: 'number', default: 3 }),
      createClusterProgramParameter({ id: 'label', type: 'text', default: 'x', required: false }),
    ]
    const result = resolveParamValues(params, { threshold: 10 })
    expect(result).toEqual({ success: true, params: { threshold: 10, label: 'x' } })
  })

  it('drops keys not present in the declaration (stale persisted values)', () => {
    const params = [createClusterProgramParameter({ id: 'kept', type: 'number', default: 1 })]
    const result = resolveParamValues(params, { kept: 2, stale: 'old' })
    expect(result).toEqual({ success: true, params: { kept: 2 } })
  })

  it('coerces number values and rejects non-numeric input', () => {
    const params = [
      createClusterProgramParameter({ id: 'n', type: 'number', default: undefined }),
    ]
    expect(resolveParamValues(params, { n: '42' })).toEqual({
      success: true,
      params: { n: 42 },
    })

    const bad = resolveParamValues(params, { n: 'abc' })
    expect(bad.success).toBe(false)
    if (!bad.success) expect(bad.error).toContain('"n" must be a number')
  })

  it('coerces boolean values', () => {
    const params = [
      createClusterProgramParameter({ id: 'flag', type: 'boolean', default: undefined }),
    ]
    expect(resolveParamValues(params, { flag: true })).toEqual({
      success: true,
      params: { flag: true },
    })
    expect(resolveParamValues(params, {})).toEqual({
      success: true,
      params: { flag: false },
    })
  })

  it('validates select values against options', () => {
    const params = [
      createClusterProgramParameter({
        id: 'mode',
        type: 'select',
        options: ['a', 'b'],
        default: undefined,
        required: false,
      }),
    ]
    expect(resolveParamValues(params, { mode: 'b' })).toEqual({
      success: true,
      params: { mode: 'b' },
    })

    const bad = resolveParamValues(params, { mode: 'z' })
    expect(bad.success).toBe(false)
    if (!bad.success) expect(bad.error).toContain('must be one of: a, b')
  })

  it('fails on missing required values', () => {
    const params = [
      createClusterProgramParameter({ id: 'req', type: 'text', required: true, default: undefined }),
    ]
    const result = resolveParamValues(params, {})
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toBe('Missing required parameter: req')
  })

  it('omits optional params with no value or default', () => {
    const params = [
      createClusterProgramParameter({ id: 'opt', type: 'text', required: false, default: undefined }),
    ]
    expect(resolveParamValues(params, {})).toEqual({ success: true, params: {} })
  })

  it('empty-string provided value falls back to the default', () => {
    const params = [
      createClusterProgramParameter({ id: 'n', type: 'number', default: 7 }),
    ]
    expect(resolveParamValues(params, { n: '' })).toEqual({
      success: true,
      params: { n: 7 },
    })
  })
})

describe('resolveNodeBoundValues', () => {
  const node = {
    node_id: 'n1',
    node_type: 'Person',
    properties: {
      id_simples: 'abc-123',
      score: 0.5,
      active: false,
      zero: 0,
      empty: '',
      nullProp: null,
      nested: { a: 1 },
    },
  }

  it('resolves node_id and node_type bindings', () => {
    const params = [
      createClusterProgramParameter({ id: 'start', type: 'text', node_binding: 'node_id' }),
      createClusterProgramParameter({ id: 'kind', type: 'text', node_binding: 'node_type' }),
    ]
    const result = resolveNodeBoundValues(params, node)
    expect(result.values).toEqual({ start: 'n1', kind: 'Person' })
    expect(result.missing).toEqual([])
  })

  it('resolves prop: bindings including falsy primitives (false, 0)', () => {
    const params = [
      createClusterProgramParameter({ id: 'simple', type: 'text', node_binding: 'prop:id_simples' }),
      createClusterProgramParameter({ id: 'score', type: 'number', node_binding: 'prop:score' }),
      createClusterProgramParameter({ id: 'flag', type: 'boolean', node_binding: 'prop:active' }),
      createClusterProgramParameter({ id: 'z', type: 'number', node_binding: 'prop:zero' }),
    ]
    const result = resolveNodeBoundValues(params, node)
    expect(result.values).toEqual({ simple: 'abc-123', score: 0.5, flag: false, z: 0 })
    expect(result.missing).toEqual([])
  })

  it('reports missing for absent, null, empty-string and non-primitive properties', () => {
    const params = [
      createClusterProgramParameter({ id: 'a', type: 'text', node_binding: 'prop:does_not_exist' }),
      createClusterProgramParameter({ id: 'b', type: 'text', node_binding: 'prop:nullProp' }),
      createClusterProgramParameter({ id: 'c', type: 'text', node_binding: 'prop:empty' }),
      createClusterProgramParameter({ id: 'd', type: 'text', node_binding: 'prop:nested' }),
    ]
    const result = resolveNodeBoundValues(params, node)
    expect(result.values).toEqual({})
    expect(result.missing).toEqual([
      { paramId: 'a', binding: 'prop:does_not_exist' },
      { paramId: 'b', binding: 'prop:nullProp' },
      { paramId: 'c', binding: 'prop:empty' },
      { paramId: 'd', binding: 'prop:nested' },
    ])
  })

  it('handles nodes without a properties object', () => {
    const params = [
      createClusterProgramParameter({ id: 'a', type: 'text', node_binding: 'prop:x' }),
      createClusterProgramParameter({ id: 'start', type: 'text', node_binding: 'node_id' }),
    ]
    const result = resolveNodeBoundValues(params, { node_id: 'n9', node_type: 'T' })
    expect(result.values).toEqual({ start: 'n9' })
    expect(result.missing).toEqual([{ paramId: 'a', binding: 'prop:x' }])
  })

  it('ignores params without a binding and handles undefined declarations', () => {
    const params = [
      createClusterProgramParameter({ id: 'plain', type: 'number', default: 3 }),
    ]
    expect(resolveNodeBoundValues(params, node)).toEqual({ values: {}, missing: [] })
    expect(resolveNodeBoundValues(undefined, node)).toEqual({ values: {}, missing: [] })
  })
})
