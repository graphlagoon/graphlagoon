import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'
import { useMetricsStore } from '@/stores/metrics'
import { useCommunityStore } from '@/stores/community'
import { useSimilarityStore } from '@/stores/similarity'
import type { Edge } from '@/types/graph'

/**
 * Regression: rendering a large graph (150k+ edges, many nodes) used to crash
 * with `RangeError: Maximum call stack size exceeded` BEFORE the user could see
 * the graph.
 *
 * Root cause: `Math.min/max(...arr)` and `arr.push(...arr)` spread every element
 * into a function call, overflowing V8's argument limit. The default visual
 * mapping sizes nodes by the built-in degree metric, so on graph load
 * `GraphCanvas3D` reads `metricsStore.nodeSizeMetric` (during setup and again in
 * initGraph -> buildGraphData -> collectAppearanceContext), which evaluates
 * `builtInDegreeMetric` -> `calculateStats(Array.from(nodeDegrees.values()))`
 * over a per-node array. Above the threshold, `Math.max(...)` threw.
 *
 * These tests drive the REAL stores above the overflow threshold and assert the
 * pre-paint code path no longer throws — reproducing the exact crash path
 * deterministically without needing a WebGL context.
 *
 * NOTE on sizing: V8's spread-into-call limit is stack-dependent — ~130k in a
 * browser tab (where the real crash happened) but higher inside Vitest's worker
 * thread (~250k–500k, measured). We size well above the Vitest limit so these
 * tests actually reproduce the overflow here; a smaller graph would pass even
 * with the buggy spread and give a false sense of safety.
 */

const OVERFLOW_THRESHOLD = 500_000
const SIZE = 600_000

// Long test timeout: building 600k reactive objects in the store is inherently
// heavy (deep reactivity), well over Vitest's 5s default.
const TIMEOUT = 60_000

/** Build `count` edges over `count` distinct node ids (so nodeDegrees exceeds the threshold). */
function buildLargeEdges(count: number): Edge[] {
  const edges: Edge[] = new Array(count)
  for (let i = 0; i < count; i++) {
    edges[i] = {
      edge_id: `e${i}`,
      src: `n${i}`,
      dst: `n${(i + 1) % count}`,
      relationship_type: 'KNOWS',
    }
  }
  return edges
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('large graph render path (150k+ edges) does not overflow the stack', () => {
  it('metricsStore.nodeSizeMetric (default degree sizing, read before first paint) does not throw', () => {
    const graphStore = useGraphStore()
    // builtInDegreeMetric reads nodeDegrees, which is built from edges only, so
    // we skip building a nodes array — the degree stats still cover every node.
    graphStore.edges = buildLargeEdges(SIZE)
    expect(graphStore.nodeDegrees.size).toBeGreaterThan(OVERFLOW_THRESHOLD)

    const metricsStore = useMetricsStore()
    // Default visual mapping sizes nodes by '__builtin_degree' — the exact getter
    // GraphCanvas3D evaluates at setup and in buildGraphData, before first paint.
    expect(metricsStore.visualMapping.nodeSize.metricId).toBe('__builtin_degree')

    let metric
    expect(() => {
      metric = metricsStore.nodeSizeMetric
    }).not.toThrow()

    expect(metric).not.toBeNull()
    // Degree stats over the whole graph must be correct, not just non-throwing.
    expect(metric!.values.size).toBeGreaterThan(OVERFLOW_THRESHOLD)
    expect(metric!.min).toBeGreaterThanOrEqual(1)
    expect(metric!.max).toBeGreaterThanOrEqual(metric!.min)
    expect(Number.isFinite(metric!.mean)).toBe(true)
  }, TIMEOUT)

  it('community stats above the overflow threshold do not throw', () => {
    const communityStore = useCommunityStore()
    // Singleton communities (one node each) => one community size per node, the
    // array community.ts used to spread into Math.max/min.
    const map = new Map<string, number>()
    for (let i = 0; i < SIZE; i++) map.set(`n${i}`, i)
    communityStore.communityMap = map

    let stats
    expect(() => {
      stats = communityStore.communityStats
    }).not.toThrow()
    expect(stats!.count).toBeGreaterThan(OVERFLOW_THRESHOLD)
    expect(stats!.maxSize).toBe(1)
    expect(stats!.minSize).toBe(1)
  }, TIMEOUT)

  it('injecting similarity edges above the overflow threshold does not throw', () => {
    const graphStore = useGraphStore()
    graphStore.edges = []

    const simStore = useSimilarityStore()
    simStore.selectedEndpoint = 'emb'
    simStore.scoreThreshold = 0
    // Above the threshold => the array similarity.ts used to `push(...newEdges)`
    // into graphStore.edges.
    const simEdges = new Array(SIZE)
    for (let i = 0; i < SIZE; i++) {
      simEdges[i] = { source: `a${i}`, target: `b${i}`, score: 0.9 }
    }
    simStore.similarityEdges = simEdges

    expect(() => simStore.injectEdges()).not.toThrow()
    expect(graphStore.edges.length).toBe(SIZE)
  }, TIMEOUT)
})
