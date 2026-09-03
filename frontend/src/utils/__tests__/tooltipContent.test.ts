import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildNodeTooltip,
  buildEdgeTooltip,
  EDGE_TYPE_CHIP,
  MAX_TOOLTIP_CHARS,
} from '@/utils/tooltipContent'
import { clearTemplateCache, type MetricResolver } from '@/utils/labelFormatter'
import type { Edge, Node, TextFormatDefaults, TextFormatRule } from '@/types/graph'

function makeNode(overrides: Partial<Node> = {}): Node {
  return { node_id: 'alice', node_type: 'Person', ...overrides }
}

function makeEdge(overrides: Partial<Edge> = {}): Edge {
  return {
    edge_id: 'e1',
    src: 'alice',
    dst: 'bob',
    relationship_type: 'KNOWS',
    ...overrides,
  }
}

function makeDefaults(overrides: Partial<TextFormatDefaults> = {}): TextFormatDefaults {
  return {
    nodeTemplate: '{node_id}',
    edgeTemplate: '{relationship_type}',
    nodeTooltipTemplate: '',
    edgeTooltipTemplate: '',
    ...overrides,
  }
}

function makeRule(overrides: Partial<TextFormatRule> = {}): TextFormatRule {
  return {
    id: 'rule-1',
    name: 'Test Rule',
    target: 'node',
    types: [],
    template: '{node_id}',
    priority: 10,
    enabled: true,
    scope: 'exploration',
    ...overrides,
  }
}

describe('tooltipContent', () => {
  beforeEach(() => {
    clearTemplateCache()
  })

  describe('unconfigured (empty template) — the pre-feature tooltip', () => {
    it('shows the node label', () => {
      const result = buildNodeTooltip(makeNode(), [], makeDefaults())
      expect(result).toEqual({ body: 'alice', typeChip: 'Person' })
    })

    it('honours custom label rules, so it matches what the canvas draws', () => {
      const rules = [makeRule({ types: ['Person'], template: '{prop:name}' })]
      const node = makeNode({ properties: { name: 'Alice Martins' } })

      expect(buildNodeTooltip(node, rules, makeDefaults()).body).toBe('Alice Martins')
    })

    it('shows the raw relationship_type for edges, not the edge label template', () => {
      const defaults = makeDefaults({ edgeTemplate: 'label-template-should-be-ignored' })

      expect(buildEdgeTooltip(makeEdge(), [], defaults)).toEqual({
        body: 'KNOWS',
        typeChip: EDGE_TYPE_CHIP,
      })
    })

    it('treats an absent template key (pre-feature saved state) as empty', () => {
      const defaults = { nodeTemplate: '{node_id}', edgeTemplate: '{relationship_type}' }

      expect(buildNodeTooltip(makeNode(), [], defaults).body).toBe('alice')
      expect(buildEdgeTooltip(makeEdge(), [], defaults).body).toBe('KNOWS')
    })

    it('treats a whitespace-only template as empty', () => {
      const defaults = makeDefaults({ nodeTooltipTemplate: '   ' })

      expect(buildNodeTooltip(makeNode(), [], defaults).body).toBe('alice')
    })
  })

  describe('configured template', () => {
    it('renders the template as the body', () => {
      const defaults = makeDefaults({ nodeTooltipTemplate: '{prop:email}' })
      const node = makeNode({ properties: { email: 'alice@empresa.com' } })

      expect(buildNodeTooltip(node, [], defaults).body).toBe('alice@empresa.com')
    })

    it('keeps the type chip — the template owns the body only', () => {
      const defaults = makeDefaults({ nodeTooltipTemplate: 'no type mentioned here' })

      expect(buildNodeTooltip(makeNode(), [], defaults).typeChip).toBe('Person')
    })

    it('ignores label rules, so per-type tooltips go through {if:}', () => {
      const rules = [makeRule({ types: ['Person'], template: 'FROM RULE' })]
      const defaults = makeDefaults({ nodeTooltipTemplate: 'FROM TOOLTIP' })

      expect(buildNodeTooltip(makeNode(), rules, defaults).body).toBe('FROM TOOLTIP')
    })

    it('supports per-type bodies via {if:node_type==...}', () => {
      const defaults = makeDefaults({
        nodeTooltipTemplate: '{if:prop:node_type==Person|human|other}',
      })
      const person = makeNode({ properties: { node_type: 'Person' } })
      const company = makeNode({ node_type: 'Company', properties: { node_type: 'Company' } })

      expect(buildNodeTooltip(person, [], defaults).body).toBe('human')
      expect(buildNodeTooltip(company, [], defaults).body).toBe('other')
    })

    it('renders {br} as a newline so the tooltip can be multi-line', () => {
      const defaults = makeDefaults({ nodeTooltipTemplate: '{node_id}{br}{node_type}' })

      expect(buildNodeTooltip(makeNode(), [], defaults).body).toBe('alice\nPerson')
    })

    it('shows the missing-property sentinel', () => {
      const defaults = makeDefaults({ nodeTooltipTemplate: '{prop:nickname}' })

      expect(buildNodeTooltip(makeNode(), [], defaults).body).toBe('[nickname]')
    })

    it('resolves {metric:...} through the injected resolver', () => {
      const metrics: MetricResolver = (target, itemId, ref) =>
        target === 'node' && itemId === 'alice' && ref === 'PageRank' ? 0.42 : undefined
      const defaults = makeDefaults({ nodeTooltipTemplate: 'PR {metric:PageRank}' })

      expect(buildNodeTooltip(makeNode(), [], defaults, { metrics }).body).toBe('PR 0.42')
    })

    it('templates edge tooltips too, with {src}/{dst}', () => {
      const defaults = makeDefaults({ edgeTooltipTemplate: '{src} -> {dst}' })

      expect(buildEdgeTooltip(makeEdge(), [], defaults)).toEqual({
        body: 'alice -> bob',
        typeChip: EDGE_TYPE_CHIP,
      })
    })

    it('accepts accents and emoji — the tooltip is DOM, not the canvas font', () => {
      const defaults = makeDefaults({ nodeTooltipTemplate: 'José 🚀 → fim' })

      expect(buildNodeTooltip(makeNode(), [], defaults).body).toBe('José 🚀 → fim')
    })
  })

  describe('truncation', () => {
    it('clamps a runaway property at MAX_TOOLTIP_CHARS', () => {
      const defaults = makeDefaults({ nodeTooltipTemplate: '{prop:bio}' })
      const node = makeNode({ properties: { bio: 'x'.repeat(MAX_TOOLTIP_CHARS + 500) } })

      const body = buildNodeTooltip(node, [], defaults).body
      expect(body.length).toBe(MAX_TOOLTIP_CHARS + 1)
      expect(body.endsWith('…')).toBe(true)
    })

    it('leaves a body at exactly the cap untouched', () => {
      const defaults = makeDefaults({ nodeTooltipTemplate: '{prop:bio}' })
      const node = makeNode({ properties: { bio: 'x'.repeat(MAX_TOOLTIP_CHARS) } })

      const body = buildNodeTooltip(node, [], defaults).body
      expect(body.length).toBe(MAX_TOOLTIP_CHARS)
      expect(body.endsWith('…')).toBe(false)
    })
  })
})

describe('tooltip-surface rules (the per-type escape hatch)', () => {
  const tooltipRule = (over: Partial<TextFormatRule> = {}) =>
    makeRule({ id: 'tr', name: 'Tooltip rule', surface: 'tooltip', template: 'FROM RULE', ...over })

  it('a matching tooltip rule beats the tooltip default template', () => {
    const defaults = makeDefaults({ nodeTooltipTemplate: 'FROM DEFAULT' })

    expect(buildNodeTooltip(makeNode(), [tooltipRule()], defaults).body).toBe('FROM RULE')
  })

  it('a matching tooltip rule beats the label fallback too', () => {
    expect(buildNodeTooltip(makeNode(), [tooltipRule()], makeDefaults()).body).toBe('FROM RULE')
  })

  it('skips a disabled rule', () => {
    const rules = [tooltipRule({ enabled: false })]

    expect(buildNodeTooltip(makeNode(), rules, makeDefaults()).body).toBe('alice')
  })

  it('skips a rule for another type', () => {
    const rules = [tooltipRule({ types: ['Company'] })]
    const defaults = makeDefaults({ nodeTooltipTemplate: 'FROM DEFAULT' })

    expect(buildNodeTooltip(makeNode(), rules, defaults).body).toBe('FROM DEFAULT')
  })

  it('a label-surface rule never drives the tooltip body directly', () => {
    // It still reaches the tooltip through the label fallback — which is rule 1.
    const rules = [makeRule({ types: ['Person'], template: 'LABEL RULE' })]

    expect(buildNodeTooltip(makeNode(), rules, makeDefaults()).body).toBe('LABEL RULE')
    // ...but with a tooltip default configured, the label rule is out of the picture.
    const defaults = makeDefaults({ nodeTooltipTemplate: 'FROM DEFAULT' })
    expect(buildNodeTooltip(makeNode(), rules, defaults).body).toBe('FROM DEFAULT')
  })

  it("a 'both' rule drives label and tooltip alike", () => {
    const rules = [makeRule({ surface: 'both', template: 'SHARED' })]

    expect(buildNodeTooltip(makeNode(), rules, makeDefaults()).body).toBe('SHARED')
  })

  it('edge tooltip rules match on relationship_type', () => {
    const rules = [
      makeRule({ target: 'edge', surface: 'tooltip', types: ['KNOWS'], template: '{src} > {dst}' }),
    ]

    expect(buildEdgeTooltip(makeEdge(), rules, makeDefaults()).body).toBe('alice > bob')
    const other = makeEdge({ relationship_type: 'WORKS_AT' })
    expect(buildEdgeTooltip(other, rules, makeDefaults()).body).toBe('WORKS_AT')
  })

  it('clamps rule output like any other body', () => {
    const rules = [tooltipRule({ template: '{prop:bio}' })]
    const node = makeNode({ properties: { bio: 'x'.repeat(MAX_TOOLTIP_CHARS + 10) } })

    const body = buildNodeTooltip(node, rules, makeDefaults()).body
    expect(body.length).toBe(MAX_TOOLTIP_CHARS + 1)
  })
})
