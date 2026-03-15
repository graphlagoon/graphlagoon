import { describe, it, expect } from 'vitest'
import {
  ALGORITHMS,
  getAlgorithm,
  getAlgorithmsByCategory,
  getAlgorithmsByTarget,
  getNodeAlgorithms,
  getEdgeAlgorithms,
  requiresComponentHandling,
  getDefaultParams,
  validateParams,
} from '@/services/algorithmRegistry'

describe('ALGORITHMS registry', () => {
  it('contains 9 algorithm definitions', () => {
    expect(ALGORITHMS).toHaveLength(9)
  })

  it('each algorithm has required fields', () => {
    for (const algo of ALGORITHMS) {
      expect(algo.id).toBeTruthy()
      expect(algo.name).toBeTruthy()
      expect(algo.category).toBeTruthy()
      expect(algo.target).toBeTruthy()
      expect(algo.paramSchema).toBeDefined()
      expect(Array.isArray(algo.paramSchema)).toBe(true)
    }
  })

  it('all algorithm IDs are unique', () => {
    const ids = ALGORITHMS.map(a => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('all algorithms include the edgeTypeFilter param', () => {
    for (const algo of ALGORITHMS) {
      const hasEdgeTypeFilter = algo.paramSchema.some(p => p.key === 'edgeTypeFilter')
      expect(hasEdgeTypeFilter, `${algo.id} missing edgeTypeFilter`).toBe(true)
    }
  })
})

describe('getAlgorithm', () => {
  it('returns definition for valid ID', () => {
    const algo = getAlgorithm('degree')
    expect(algo).toBeDefined()
    expect(algo!.name).toBe('Degree Centrality')
  })

  it('returns undefined for unknown ID', () => {
    expect(getAlgorithm('nonexistent')).toBeUndefined()
  })
})

describe('getAlgorithmsByCategory', () => {
  it('returns 8 centrality algorithms', () => {
    const centrality = getAlgorithmsByCategory('centrality')
    expect(centrality).toHaveLength(8)
  })

  it('returns 1 edge algorithm', () => {
    const edge = getAlgorithmsByCategory('edge')
    expect(edge).toHaveLength(1)
    expect(edge[0].id).toBe('edge-betweenness')
  })
})

describe('getAlgorithmsByTarget', () => {
  it('node target returns 8 algorithms', () => {
    expect(getAlgorithmsByTarget('node')).toHaveLength(8)
  })

  it('edge target returns 1 algorithm', () => {
    expect(getAlgorithmsByTarget('edge')).toHaveLength(1)
  })
})

describe('getNodeAlgorithms / getEdgeAlgorithms', () => {
  it('getNodeAlgorithms returns only node-targeted', () => {
    const nodes = getNodeAlgorithms()
    expect(nodes.every(a => a.target === 'node')).toBe(true)
    expect(nodes.length).toBe(8)
  })

  it('getEdgeAlgorithms returns only edge-targeted', () => {
    const edges = getEdgeAlgorithms()
    expect(edges.every(a => a.target === 'edge')).toBe(true)
    expect(edges.length).toBe(1)
  })
})

describe('requiresComponentHandling', () => {
  it('returns true for eigenvector (requiresConnectedGraph)', () => {
    expect(requiresComponentHandling('eigenvector')).toBe(true)
  })

  it('returns true for closeness', () => {
    expect(requiresComponentHandling('closeness')).toBe(true)
  })

  it('returns false for degree', () => {
    expect(requiresComponentHandling('degree')).toBe(false)
  })

  it('returns false for unknown algorithm ID', () => {
    expect(requiresComponentHandling('nonexistent')).toBe(false)
  })
})

describe('getDefaultParams', () => {
  it('returns correct defaults for pagerank', () => {
    const params = getDefaultParams('pagerank')
    expect(params.alpha).toBe(0.85)
    expect(params.maxIterations).toBe(100)
    expect(params.tolerance).toBe(1e-6)
  })

  it('returns empty object for unknown algorithm', () => {
    expect(getDefaultParams('nonexistent')).toEqual({})
  })

  it('returns a copy, not same reference', () => {
    const p1 = getDefaultParams('pagerank')
    const p2 = getDefaultParams('pagerank')
    expect(p1).toEqual(p2)
    expect(p1).not.toBe(p2)
  })
})

describe('validateParams', () => {
  it('returns valid for correct params', () => {
    const result = validateParams('pagerank', { alpha: 0.85 })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('returns error for unknown algorithm', () => {
    const result = validateParams('nonexistent', {})
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('Unknown algorithm')
  })

  it('detects number below min', () => {
    const result = validateParams('pagerank', { alpha: 0.01 })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('at least'))).toBe(true)
  })

  it('detects number above max', () => {
    const result = validateParams('pagerank', { alpha: 1.5 })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('at most'))).toBe(true)
  })

  it('valid when no numeric constraint violations', () => {
    const result = validateParams('degree', { direction: 'all' })
    expect(result.valid).toBe(true)
  })
})
