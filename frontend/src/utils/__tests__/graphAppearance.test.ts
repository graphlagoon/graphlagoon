import { describe, it, expect } from 'vitest';
import {
  hexToRgba,
  getMultiEdgeCurvature3D,
  computeLinkColor,
  computeNodeAppearance,
  computeLinkAppearance,
  type AppearanceContext,
} from '../graphAppearance';

// ---------------------------------------------------------------------------
// Helper to build a minimal AppearanceContext with overrides
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<AppearanceContext> = {}): AppearanceContext {
  const base: AppearanceContext = {
    baseNodeSize: 8,
    nodeOpacity: 1.0,
    edgeOpacity: 0.6,

    nodeTypeFilter: [],
    hasNodeTypeFilter: false,
    nodeTypeFilterSet: new Set<string>(),
    edgeTypeFilter: [],
    hasEdgeTypeFilter: false,
    edgeTypeFilterSet: new Set<string>(),

    searchMode: 'hide',
    searchMatchedIds: null,
    searchHiddenIds: null,
    isHighlightMode: false,

    propFilterHiddenNodeIds: null,
    propFilterHiddenEdgeIds: null,

    focusedNodeIds: null,
    edgeLensMode: 'off',
    edgeLensDimOpacity: 0.08,

    dimmedByDegreeIds: null,
    degreeDimOpacity: 0.2,

    hubNodeIds: null,

    selectedNodeIds: new Set<string>(),

    nodeSizeMetric: null,
    nodeSizeMapping: { minSize: 3, maxSize: 30 },

    getNodeTypeColor: () => '#4488cc',
    getEdgeTypeColor: () => '#888888',

    ...overrides,
  };
  // Auto-derive filter Sets from arrays when not explicitly provided
  if (overrides.nodeTypeFilter && !overrides.nodeTypeFilterSet) {
    base.nodeTypeFilterSet = new Set(base.nodeTypeFilter);
  }
  if (overrides.edgeTypeFilter && !overrides.edgeTypeFilterSet) {
    base.edgeTypeFilterSet = new Set(base.edgeTypeFilter);
  }
  return base;
}

// ---------------------------------------------------------------------------
// hexToRgba
// ---------------------------------------------------------------------------

describe('hexToRgba', () => {
  it('converts hex to rgba with full alpha', () => {
    expect(hexToRgba('#ff0000', 1)).toBe('rgba(255,0,0,1)');
  });

  it('converts hex to rgba with zero alpha', () => {
    expect(hexToRgba('#00ff00', 0)).toBe('rgba(0,255,0,0)');
  });

  it('converts hex to rgba with fractional alpha', () => {
    expect(hexToRgba('#0000ff', 0.5)).toBe('rgba(0,0,255,0.5)');
  });

  it('handles mixed hex values', () => {
    expect(hexToRgba('#1a2b3c', 0.8)).toBe('rgba(26,43,60,0.8)');
  });

  it('handles white', () => {
    expect(hexToRgba('#ffffff', 1)).toBe('rgba(255,255,255,1)');
  });

  it('handles black', () => {
    expect(hexToRgba('#000000', 0.3)).toBe('rgba(0,0,0,0.3)');
  });
});

// ---------------------------------------------------------------------------
// getMultiEdgeCurvature3D
// ---------------------------------------------------------------------------

describe('getMultiEdgeCurvature3D', () => {
  it('returns 0 for single edge', () => {
    expect(getMultiEdgeCurvature3D(0, 1)).toBe(0);
  });

  it('returns 0 for first edge of multi-edge pair', () => {
    expect(getMultiEdgeCurvature3D(0, 3)).toBe(0);
  });

  it('returns +0.15 for second edge', () => {
    expect(getMultiEdgeCurvature3D(1, 3)).toBeCloseTo(0.15);
  });

  it('returns -0.15 for third edge', () => {
    expect(getMultiEdgeCurvature3D(2, 3)).toBeCloseTo(-0.15);
  });

  it('returns +0.3 for fourth edge', () => {
    expect(getMultiEdgeCurvature3D(3, 5)).toBeCloseTo(0.3);
  });

  it('returns -0.3 for fifth edge', () => {
    expect(getMultiEdgeCurvature3D(4, 5)).toBeCloseTo(-0.3);
  });

  it('caps curvature at -0.6', () => {
    // index 8 → ceil(8/2) * 0.15 = 4 * 0.15 = 0.6, sign = 8%2===0 → -1
    expect(getMultiEdgeCurvature3D(8, 20)).toBeCloseTo(-0.6);
  });

  it('caps curvature at +0.6', () => {
    // index 9 → ceil(9/2) * 0.15 = 5 * 0.15 = 0.75 → capped to 0.6, sign = 9%2===1 → +1
    expect(getMultiEdgeCurvature3D(9, 20)).toBeCloseTo(0.6);
  });

  it('handles large indices without exceeding cap', () => {
    const c = getMultiEdgeCurvature3D(15, 20);
    expect(Math.abs(c)).toBeLessThanOrEqual(0.6);
  });
});

// ---------------------------------------------------------------------------
// computeLinkColor
// ---------------------------------------------------------------------------

describe('computeLinkColor', () => {
  it('returns base color when no dimming applies', () => {
    const color = computeLinkColor('#ff0000', 'a', 'b', null, null, 'off', 0.08, 0.2, 0.6);
    expect(color).toBe('#ff0000');
  });

  it('returns rgba when graph lens dims the edge', () => {
    const focusFilter = new Set(['a']); // 'b' is outside focus
    const color = computeLinkColor('#ff0000', 'a', 'b', focusFilter, null, 'dim', 0.08, 0.2, 0.6);
    expect(color).toMatch(/^rgba\(/);
  });

  it('returns base color when both endpoints are in focus', () => {
    const focusFilter = new Set(['a', 'b']);
    const color = computeLinkColor('#ff0000', 'a', 'b', focusFilter, null, 'dim', 0.08, 0.2, 0.6);
    expect(color).toBe('#ff0000');
  });

  it('returns rgba when degree dimming applies (hub-to-non-hub)', () => {
    const hubs = new Set(['a']); // 'a' is hub, 'b' is not
    const color = computeLinkColor('#ff0000', 'a', 'b', null, hubs, 'off', 0.08, 0.2, 0.6);
    expect(color).toMatch(/^rgba\(/);
  });

  it('returns base color when both endpoints are hubs', () => {
    const hubs = new Set(['a', 'b']);
    const color = computeLinkColor('#ff0000', 'a', 'b', null, hubs, 'off', 0.08, 0.2, 0.6);
    expect(color).toBe('#ff0000');
  });

  it('returns base color when neither endpoint is a hub', () => {
    const hubs = new Set(['c']); // 'a' and 'b' are not hubs
    const color = computeLinkColor('#ff0000', 'a', 'b', null, hubs, 'off', 0.08, 0.2, 0.6);
    expect(color).toBe('#ff0000');
  });

  it('uses minimum opacity when both lens and degree dimming apply', () => {
    const focusFilter = new Set(['a']);
    const hubs = new Set(['a']);
    const color = computeLinkColor('#ff0000', 'a', 'b', focusFilter, hubs, 'dim', 0.08, 0.2, 0.6);
    // Both apply: lens = 0.08, degree = 0.2 → min is 0.08
    expect(color).toMatch(/^rgba\(/);
  });

  it('compensates for edgeOpacity in alpha calculation', () => {
    const hubs = new Set(['a']);
    // desiredOpacity = 0.2, edgeOpacity = 0.6 → colorAlpha = 0.2/0.6 ≈ 0.333
    const color = computeLinkColor('#ff0000', 'a', 'b', null, hubs, 'off', 0.08, 0.2, 0.6);
    const match = color.match(/rgba\(255,0,0,([\d.]+)\)/);
    expect(match).not.toBeNull();
    expect(parseFloat(match![1])).toBeCloseTo(0.333, 2);
  });

  it('caps colorAlpha at 1.0', () => {
    const hubs = new Set(['a']);
    // desiredOpacity = 0.2, edgeOpacity = 0.1 → colorAlpha = 0.2/0.1 = 2.0 → capped at 1.0
    const color = computeLinkColor('#ff0000', 'a', 'b', null, hubs, 'off', 0.08, 0.2, 0.1);
    const match = color.match(/rgba\(255,0,0,([\d.]+)\)/);
    expect(match).not.toBeNull();
    expect(parseFloat(match![1])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeNodeAppearance — visibility
// ---------------------------------------------------------------------------

describe('computeNodeAppearance — visibility', () => {
  it('regular node is visible by default', () => {
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, makeCtx());
    expect(r.hidden).toBe(false);
  });

  it('hides node by type filter', () => {
    const ctx = makeCtx({
      nodeTypeFilter: ['Company'],
      hasNodeTypeFilter: true,
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.hidden).toBe(true);
  });

  it('shows node matching type filter', () => {
    const ctx = makeCtx({
      nodeTypeFilter: ['Person'],
      hasNodeTypeFilter: true,
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.hidden).toBe(false);
  });

  it('hides node by search hidden set', () => {
    const ctx = makeCtx({
      searchHiddenIds: new Set(['n1']),
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.hidden).toBe(true);
  });

  it('hides node by property filter', () => {
    const ctx = makeCtx({
      propFilterHiddenNodeIds: new Set(['n1']),
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.hidden).toBe(true);
  });

  it('hides non-focused node in hide mode', () => {
    const ctx = makeCtx({
      edgeLensMode: 'hide',
      focusedNodeIds: new Set(['n2']),
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.hidden).toBe(true);
  });

  it('shows focused node in hide mode', () => {
    const ctx = makeCtx({
      edgeLensMode: 'hide',
      focusedNodeIds: new Set(['n1']),
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.hidden).toBe(false);
  });

  it('does NOT hide non-focused node in dim mode', () => {
    const ctx = makeCtx({
      edgeLensMode: 'dim',
      focusedNodeIds: new Set(['n2']),
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.hidden).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeNodeAppearance — sizing
// ---------------------------------------------------------------------------

describe('computeNodeAppearance — sizing', () => {
  it('uses base node size for regular node', () => {
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, makeCtx());
    expect(r.size).toBe(8);
  });

  it('uses cluster base size for cluster node', () => {
    const r = computeNodeAppearance('c1', '__cluster__', true, 25, '#9333ea', makeCtx());
    expect(r.size).toBe(25);
  });

  it('scales up selected nodes by 1.5x', () => {
    const ctx = makeCtx({
      selectedNodeIds: new Set(['n1']),
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.size).toBe(8 * 1.5);
  });

  it('scales up matched nodes in highlight mode by 1.5x', () => {
    const ctx = makeCtx({
      isHighlightMode: true,
      searchMatchedIds: new Set(['n1']),
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.size).toBe(8 * 1.5);
  });

  it('scales down unmatched nodes in highlight mode by 0.75x', () => {
    const ctx = makeCtx({
      isHighlightMode: true,
      searchMatchedIds: new Set(['n2']),
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.size).toBe(8 * 0.75);
  });

  it('applies degree dimming size reduction (0.6x)', () => {
    const ctx = makeCtx({
      dimmedByDegreeIds: new Set(['n1']),
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.size).toBe(8 * 0.6);
  });

  it('combines selection with degree dimming', () => {
    const ctx = makeCtx({
      dimmedByDegreeIds: new Set(['n1']),
      selectedNodeIds: new Set(['n1']),
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    // degree dim: 8 * 0.6 = 4.8, then selection: 4.8 * 1.5 = 7.2
    expect(r.size).toBeCloseTo(7.2);
  });

  it('applies metric-based sizing', () => {
    const ctx = makeCtx({
      nodeSizeMetric: {
        values: new Map([['n1', 50]]),
        min: 0,
        max: 100,
      },
      nodeSizeMapping: { minSize: 3, maxSize: 30 },
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    // normalized = (50-0)/(100-0) = 0.5
    // desiredRadius = 3 + 0.5 * (30 - 3) = 3 + 13.5 = 16.5
    // relSize = 8 / 2 = 4
    // size = (16.5 / 4) ^ 3 = 4.125^3 = 70.19...
    expect(r.size).toBeCloseTo(70.19, 0);
  });

  it('skips metric sizing for cluster nodes', () => {
    const ctx = makeCtx({
      nodeSizeMetric: {
        values: new Map([['c1', 50]]),
        min: 0,
        max: 100,
      },
    });
    const r = computeNodeAppearance('c1', '__cluster__', true, 25, '#9333ea', ctx);
    expect(r.size).toBe(25);
  });

  it('skips metric sizing when metric value is not present for node', () => {
    const ctx = makeCtx({
      nodeSizeMetric: {
        values: new Map([['other', 50]]),
        min: 0,
        max: 100,
      },
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.size).toBe(8); // base size unchanged
  });
});

// ---------------------------------------------------------------------------
// computeNodeAppearance — coloring
// ---------------------------------------------------------------------------

describe('computeNodeAppearance — coloring', () => {
  it('uses type color for regular node', () => {
    const ctx = makeCtx({
      getNodeTypeColor: () => '#aabbcc',
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.color).toBe('#aabbcc');
  });

  it('uses cluster color for cluster node', () => {
    const r = computeNodeAppearance('c1', '__cluster__', true, 25, '#ff00ff', makeCtx());
    expect(r.color).toBe('#ff00ff');
  });

  it('uses default purple for cluster without color', () => {
    const r = computeNodeAppearance('c1', '__cluster__', true, 25, null, makeCtx());
    expect(r.color).toBe('#9333ea');
  });

  it('grays out unmatched nodes in highlight mode', () => {
    const ctx = makeCtx({
      isHighlightMode: true,
      searchMatchedIds: new Set(['n2']),
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.color).toBe('#cccccc');
  });

  it('keeps type color for matched nodes in highlight mode', () => {
    const ctx = makeCtx({
      isHighlightMode: true,
      searchMatchedIds: new Set(['n1']),
      getNodeTypeColor: () => '#aabbcc',
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.color).toBe('#aabbcc');
  });

  it('applies degree dimming color (gray with alpha)', () => {
    const ctx = makeCtx({
      dimmedByDegreeIds: new Set(['n1']),
      degreeDimOpacity: 0.2,
      nodeOpacity: 1.0,
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.color).toBe('rgba(204,204,204,0.2)');
  });

  it('applies graph lens dim color (base color with alpha)', () => {
    const ctx = makeCtx({
      edgeLensMode: 'dim',
      focusedNodeIds: new Set(['n2']),
      edgeLensDimOpacity: 0.08,
      nodeOpacity: 1.0,
      getNodeTypeColor: () => '#ff0000',
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.color).toBe('rgba(255,0,0,0.08)');
  });

  it('does NOT apply dimming to hidden nodes', () => {
    const ctx = makeCtx({
      edgeLensMode: 'hide',
      focusedNodeIds: new Set(['n2']),
      dimmedByDegreeIds: new Set(['n1']),
      getNodeTypeColor: () => '#ff0000',
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    // Node is hidden (edgeLensMode='hide', not in focus), so dimming skipped
    expect(r.hidden).toBe(true);
    // Color should be the base type color, not dimmed
    expect(r.color).toBe('#ff0000');
  });

  it('degree dimming overrides highlight mode color', () => {
    // Both highlight (unmatched → gray) and degree dim apply
    // Degree dim comes after highlight, so it overrides the gray with its own gray+alpha
    const ctx = makeCtx({
      isHighlightMode: true,
      searchMatchedIds: new Set(['n2']),
      dimmedByDegreeIds: new Set(['n1']),
      degreeDimOpacity: 0.2,
      nodeOpacity: 1.0,
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    expect(r.color).toBe('rgba(204,204,204,0.2)');
  });

  it('graph lens dim overrides degree dim color', () => {
    // Both degree dim and lens dim apply — lens dim comes last
    const ctx = makeCtx({
      dimmedByDegreeIds: new Set(['n1']),
      edgeLensMode: 'dim',
      focusedNodeIds: new Set(['n2']),
      edgeLensDimOpacity: 0.08,
      degreeDimOpacity: 0.2,
      nodeOpacity: 1.0,
      getNodeTypeColor: () => '#ff0000',
    });
    const r = computeNodeAppearance('n1', 'Person', false, 0, null, ctx);
    // Lens dim is applied last, uses base color
    expect(r.color).toBe('rgba(255,0,0,0.08)');
  });
});

// ---------------------------------------------------------------------------
// computeLinkAppearance
// ---------------------------------------------------------------------------

describe('computeLinkAppearance', () => {
  it('visible link with base color', () => {
    const ctx = makeCtx();
    const r = computeLinkAppearance('e1', 'KNOWS', 'a', 'b', new Set(), ctx);
    expect(r.hidden).toBe(false);
    expect(r.color).toBe('#888888');
  });

  it('hides link when edge type filter excludes it', () => {
    const ctx = makeCtx({
      edgeTypeFilter: ['LIKES'],
      hasEdgeTypeFilter: true,
    });
    const r = computeLinkAppearance('e1', 'KNOWS', 'a', 'b', new Set(), ctx);
    expect(r.hidden).toBe(true);
  });

  it('shows link when edge type filter includes it', () => {
    const ctx = makeCtx({
      edgeTypeFilter: ['KNOWS'],
      hasEdgeTypeFilter: true,
    });
    const r = computeLinkAppearance('e1', 'KNOWS', 'a', 'b', new Set(), ctx);
    expect(r.hidden).toBe(false);
  });

  it('hides link when source node is hidden', () => {
    const ctx = makeCtx();
    const r = computeLinkAppearance('e1', 'KNOWS', 'a', 'b', new Set(['a']), ctx);
    expect(r.hidden).toBe(true);
  });

  it('hides link when target node is hidden', () => {
    const ctx = makeCtx();
    const r = computeLinkAppearance('e1', 'KNOWS', 'a', 'b', new Set(['b']), ctx);
    expect(r.hidden).toBe(true);
  });

  it('hides link when edge is property-filter hidden', () => {
    const ctx = makeCtx({
      propFilterHiddenEdgeIds: new Set(['e1']),
    });
    const r = computeLinkAppearance('e1', 'KNOWS', 'a', 'b', new Set(), ctx);
    expect(r.hidden).toBe(true);
  });

  it('applies graph lens dimming to visible link color', () => {
    const ctx = makeCtx({
      edgeLensMode: 'dim',
      focusedNodeIds: new Set(['a']), // 'b' is not in focus
      edgeLensDimOpacity: 0.08,
    });
    const r = computeLinkAppearance('e1', 'KNOWS', 'a', 'b', new Set(), ctx);
    expect(r.hidden).toBe(false);
    expect(r.color).toMatch(/^rgba\(/);
  });

  it('applies degree dimming to visible link color', () => {
    const ctx = makeCtx({
      hubNodeIds: new Set(['a']), // 'a' is hub, 'b' is not
    });
    const r = computeLinkAppearance('e1', 'KNOWS', 'a', 'b', new Set(), ctx);
    expect(r.hidden).toBe(false);
    expect(r.color).toMatch(/^rgba\(/);
  });

  it('uses base color for hidden links (no dimming applied)', () => {
    const ctx = makeCtx({
      edgeTypeFilter: ['LIKES'],
      hasEdgeTypeFilter: true,
      hubNodeIds: new Set(['a']),
    });
    const r = computeLinkAppearance('e1', 'KNOWS', 'a', 'b', new Set(), ctx);
    expect(r.hidden).toBe(true);
    expect(r.color).toBe('#888888'); // base color, not dimmed
  });

  it('no dimming when both endpoints are hubs', () => {
    const ctx = makeCtx({
      hubNodeIds: new Set(['a', 'b']),
    });
    const r = computeLinkAppearance('e1', 'KNOWS', 'a', 'b', new Set(), ctx);
    expect(r.color).toBe('#888888');
  });
});
