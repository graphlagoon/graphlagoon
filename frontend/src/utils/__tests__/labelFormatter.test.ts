import { describe, it, expect, beforeEach } from 'vitest'
import {
  formatLabel,
  findMatchingRule,
  formatNodeLabel,
  formatEdgeLabel,
  validateTemplate,
  getAvailablePlaceholders,
  getAvailableModifiers,
  clearTemplateCache,
} from '@/utils/labelFormatter'
import type { Node, Edge, TextFormatRule } from '@/types/graph'

// Helpers
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

function makeRule(overrides: Partial<TextFormatRule> = {}): TextFormatRule {
  return {
    id: 'rule-1',
    name: 'Test Rule',
    target: 'node',
    types: [],
    template: '{node_id}',
    priority: 1,
    enabled: true,
    scope: 'global',
    ...overrides,
  }
}

beforeEach(() => {
  clearTemplateCache()
})

// ============================================================================
// formatLabel
// ============================================================================

describe('formatLabel', () => {
  describe('basic placeholders', () => {
    it('resolves {node_id} for a node', () => {
      expect(formatLabel('{node_id}', 'node', makeNode())).toBe('alice')
    })

    it('resolves {node_type} for a node', () => {
      expect(formatLabel('{node_type}', 'node', makeNode())).toBe('Person')
    })

    it('resolves {relationship_type} for an edge', () => {
      expect(formatLabel('{relationship_type}', 'edge', makeEdge())).toBe('KNOWS')
    })

    it('resolves {edge_id} for an edge', () => {
      expect(formatLabel('{edge_id}', 'edge', makeEdge())).toBe('e1')
    })

    it('resolves {src} and {dst} for an edge', () => {
      expect(formatLabel('{src} -> {dst}', 'edge', makeEdge())).toBe('alice -> bob')
    })

    it('returns empty string for node_id placeholder on edge target', () => {
      expect(formatLabel('{node_id}', 'edge', makeEdge())).toBe('')
    })

    it('returns node_id as default when template is empty', () => {
      expect(formatLabel('', 'node', makeNode())).toBe('alice')
    })

    it('returns relationship_type as default when edge template is empty', () => {
      expect(formatLabel('', 'edge', makeEdge())).toBe('KNOWS')
    })
  })

  describe('modifiers', () => {
    it('|upper converts to uppercase', () => {
      expect(formatLabel('{node_id|upper}', 'node', makeNode())).toBe('ALICE')
    })

    it('|lower converts to lowercase', () => {
      expect(formatLabel('{node_type|lower}', 'node', makeNode())).toBe('person')
    })

    it('|capitalize capitalizes first letter, lowercases rest', () => {
      expect(formatLabel('{node_id|capitalize}', 'node', makeNode({ node_id: 'aLICE' }))).toBe('Alice')
    })

    it('|truncate:10 truncates long strings with default suffix', () => {
      const node = makeNode({ node_id: 'a_very_long_node_identifier' })
      const result = formatLabel('{node_id|truncate:10}', 'node', node)
      expect(result.length).toBeLessThanOrEqual(10)
      expect(result).toContain('...')
    })

    it('|truncate:10:-- uses custom suffix', () => {
      const node = makeNode({ node_id: 'a_very_long_node_identifier' })
      const result = formatLabel('{node_id|truncate:10:--}', 'node', node)
      expect(result.endsWith('--')).toBe(true)
      expect(result.length).toBeLessThanOrEqual(10)
    })

    it('|truncate does not truncate strings shorter than limit', () => {
      expect(formatLabel('{node_id|truncate:50}', 'node', makeNode())).toBe('alice')
    })

    it('|number formats numeric string with locale', () => {
      const node = makeNode({ node_id: '1234567' })
      const result = formatLabel('{node_id|number}', 'node', node)
      // Locale-dependent, but should have some separator or just the number
      expect(result).toBeTruthy()
    })

    it('|number returns original string for non-numeric input', () => {
      expect(formatLabel('{node_id|number}', 'node', makeNode())).toBe('alice')
    })

    it('|percent formats as percentage', () => {
      const node = makeNode({ node_id: '0.75' })
      expect(formatLabel('{node_id|percent}', 'node', node)).toBe('75.0%')
    })

    it('|percent returns original for non-numeric input', () => {
      expect(formatLabel('{node_id|percent}', 'node', makeNode())).toBe('alice')
    })

    it('modifier on built-in placeholder: {node_type|upper}', () => {
      expect(formatLabel('{node_type|upper}', 'node', makeNode())).toBe('PERSON')
    })
  })

  describe('mixed templates', () => {
    it('template with text + placeholder', () => {
      expect(formatLabel('Node: {node_id}', 'node', makeNode())).toBe('Node: alice')
    })

    it('multiple placeholders', () => {
      expect(formatLabel('{node_type} - {node_id}', 'node', makeNode())).toBe('Person - alice')
    })

    it('placeholder with modifier in mixed template', () => {
      expect(formatLabel('{node_id|upper} [{node_type}]', 'node', makeNode())).toBe('ALICE [Person]')
    })

    it('edge template with all fields', () => {
      expect(formatLabel('{src} -[{relationship_type}]-> {dst}', 'edge', makeEdge()))
        .toBe('alice -[KNOWS]-> bob')
    })
  })

  describe('template cache', () => {
    it('same template returns same result', () => {
      const r1 = formatLabel('{node_id}', 'node', makeNode())
      const r2 = formatLabel('{node_id}', 'node', makeNode())
      expect(r1).toBe(r2)
    })

    it('clearTemplateCache allows re-parsing', () => {
      formatLabel('{node_id}', 'node', makeNode())
      clearTemplateCache()
      // Should still work after clearing cache
      expect(formatLabel('{node_id}', 'node', makeNode())).toBe('alice')
    })
  })
})

// ============================================================================
// validateTemplate
// ============================================================================

describe('validateTemplate', () => {
  it('valid template returns no errors', () => {
    const result = validateTemplate('{node_id} - {node_type}')
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('empty string is valid', () => {
    expect(validateTemplate('').valid).toBe(true)
  })

  it('unbalanced opening brace returns error', () => {
    const result = validateTemplate('{node_id')
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('Unbalanced braces'))).toBe(true)
  })

  it('unbalanced closing brace returns error', () => {
    const result = validateTemplate('node_id}')
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('Unbalanced braces'))).toBe(true)
  })

  it('valid conditional syntax', () => {
    const result = validateTemplate('{if:prop:x>10|High|Low}')
    expect(result.valid).toBe(true)
  })

  it('plain text is valid', () => {
    expect(validateTemplate('just text').valid).toBe(true)
  })
})

// ============================================================================
// findMatchingRule
// ============================================================================

describe('findMatchingRule', () => {
  it('returns null when no rules match', () => {
    expect(findMatchingRule([], 'node', 'Person')).toBeNull()
  })

  it('matches by target and enabled status', () => {
    const rule = makeRule({ target: 'node', enabled: true })
    expect(findMatchingRule([rule], 'node', 'Person')).toBe(rule)
  })

  it('disabled rules are skipped', () => {
    const rule = makeRule({ enabled: false })
    expect(findMatchingRule([rule], 'node', 'Person')).toBeNull()
  })

  it('filters by target (edge rule does not match node)', () => {
    const rule = makeRule({ target: 'edge' })
    expect(findMatchingRule([rule], 'node', 'Person')).toBeNull()
  })

  it('empty types array matches all types (generic rule)', () => {
    const rule = makeRule({ types: [] })
    expect(findMatchingRule([rule], 'node', 'Company')).toBe(rule)
  })

  it('specific type rule matches only that type', () => {
    const rule = makeRule({ types: ['Person'] })
    expect(findMatchingRule([rule], 'node', 'Person')).toBe(rule)
    expect(findMatchingRule([rule], 'node', 'Company')).toBeNull()
  })

  it('higher priority rule wins over lower priority', () => {
    const low = makeRule({ id: 'low', priority: 1, template: 'low' })
    const high = makeRule({ id: 'high', priority: 10, template: 'high' })
    const result = findMatchingRule([low, high], 'node', 'Person')
    expect(result).toBe(high)
  })

  it('specific type rule wins over generic rule at same priority', () => {
    const generic = makeRule({ id: 'generic', types: [], priority: 5 })
    const specific = makeRule({ id: 'specific', types: ['Person'], priority: 5 })
    const result = findMatchingRule([generic, specific], 'node', 'Person')
    expect(result).toBe(specific)
  })
})

// ============================================================================
// formatNodeLabel / formatEdgeLabel
// ============================================================================

describe('formatNodeLabel', () => {
  it('uses matching rule template', () => {
    const rule = makeRule({ template: 'TYPE:{node_type}', types: ['Person'] })
    expect(formatNodeLabel(makeNode(), [rule], '{node_id}')).toBe('TYPE:Person')
  })

  it('falls back to default template when no rule matches', () => {
    expect(formatNodeLabel(makeNode(), [], '{node_id}')).toBe('alice')
  })

  it('falls back to default when rule types do not match', () => {
    const rule = makeRule({ types: ['Company'], template: 'COMPANY' })
    expect(formatNodeLabel(makeNode(), [rule], '{node_id}')).toBe('alice')
  })
})

describe('formatEdgeLabel', () => {
  it('uses matching edge rule', () => {
    const rule = makeRule({
      target: 'edge',
      template: '{src}->{dst}',
      types: ['KNOWS'],
    })
    expect(formatEdgeLabel(makeEdge(), [rule], '{relationship_type}')).toBe('alice->bob')
  })

  it('falls back to default template', () => {
    expect(formatEdgeLabel(makeEdge(), [], '{relationship_type}')).toBe('KNOWS')
  })
})

// ============================================================================
// getAvailablePlaceholders / getAvailableModifiers
// ============================================================================

describe('getAvailablePlaceholders', () => {
  it('returns node placeholders for node target', () => {
    const result = getAvailablePlaceholders('node', [])
    const placeholders = result.map(r => r.placeholder)
    expect(placeholders).toContain('{node_id}')
    expect(placeholders).toContain('{node_type}')
    expect(placeholders).not.toContain('{edge_id}')
  })

  it('returns edge placeholders for edge target', () => {
    const result = getAvailablePlaceholders('edge', [])
    const placeholders = result.map(r => r.placeholder)
    expect(placeholders).toContain('{edge_id}')
    expect(placeholders).toContain('{relationship_type}')
    expect(placeholders).toContain('{src}')
    expect(placeholders).toContain('{dst}')
  })

  it('includes property placeholders', () => {
    const result = getAvailablePlaceholders('node', ['name', 'age'])
    const placeholders = result.map(r => r.placeholder)
    expect(placeholders).toContain('{prop:name}')
    expect(placeholders).toContain('{prop:age}')
  })
})

describe('getAvailableModifiers', () => {
  it('returns all 7 modifiers', () => {
    const result = getAvailableModifiers()
    expect(result).toHaveLength(7)
    const mods = result.map(r => r.modifier)
    expect(mods).toContain('upper')
    expect(mods).toContain('lower')
    expect(mods).toContain('capitalize')
    expect(mods).toContain('truncate')
    expect(mods).toContain('number')
    expect(mods).toContain('currency')
    expect(mods).toContain('percent')
  })
})

// ============================================================================
// currency modifier
// ============================================================================

describe('currency modifier', () => {
  it('|currency formats with default USD', () => {
    const node = makeNode({ node_id: '42.5' })
    const result = formatLabel('{node_id|currency}', 'node', node)
    // Locale-dependent but should contain the number
    expect(result).toContain('42')
  })

  it('|currency returns original for non-numeric input', () => {
    expect(formatLabel('{node_id|currency}', 'node', makeNode())).toBe('alice')
  })

  it('|currency:BRL uses specified currency', () => {
    const node = makeNode({ node_id: '100' })
    const result = formatLabel('{node_id|currency:BRL}', 'node', node)
    expect(result).toBeTruthy()
    // Should contain the number in some form
    expect(result).toContain('100')
  })
})

// ============================================================================
// conditionals (via formatLabel)
// ============================================================================

describe('conditionals', () => {
  // Note: conditionals use {if:prop:field|operator:value|trueVal|falseVal}
  // These nodes have no properties, so prop fields resolve to ''

  it('conditional with == on built-in node_type is not supported (prop: prefix required)', () => {
    // Conditionals require prop: prefix, so built-in fields don't work in conditions
    // This tests the fallback behavior
    const result = formatLabel('{if:prop:x==10|match|no}', 'node', makeNode())
    // prop:x returns '', '' == '10' is false, so falseValue
    expect(result).toBe('no')
  })

  it('conditional with empty comparison value fails to parse (regex requires .+)', () => {
    // {if:prop:x==|yes|no} splits by | => condition="prop:x==", trueVal="yes", falseVal="no"
    // But the regex /^prop:([^=!<>]+)(==|...)(.+)$/ requires at least 1 char after ==
    // So parseConditionExpression returns null → evaluates to ''
    const result = formatLabel('{if:prop:x==|yes|no}', 'node', makeNode())
    expect(result).toBe('')
  })

  it('conditional with != evaluates correctly', () => {
    const result = formatLabel('{if:prop:x!=hello|yes|no}', 'node', makeNode())
    // condition="prop:x!=hello" → prop x='', '' != 'hello' is true → 'yes'
    expect(result).toBe('yes')
  })

  it('conditional with contains on empty prop returns falseValue', () => {
    const result = formatLabel('{if:prop:xcontainstest|yes|no}', 'node', makeNode())
    // condition="prop:xcontainstest" → regex: prop=x, op=contains, val=test
    // prop x='', ''.includes('test') is false → 'no'
    expect(result).toBe('no')
  })

  it('conditional without enough parts after split returns empty', () => {
    // {if:prop:x==|yes} splits to ["prop:x==", "yes"] — condition can't parse
    const result = formatLabel('{if:prop:x==|yes}', 'node', makeNode())
    expect(result).toBe('')
  })

  it('validates invalid conditional syntax', () => {
    // A conditional like {if:badformat} has < 2 parts after split
    const result = validateTemplate('{if:badformat}')
    // Should be valid (no parse error) but the conditional won't produce output
    expect(result.valid).toBe(true)
  })
})

// ============================================================================
// date formatting (via formatLabel)
// ============================================================================

describe('date formatting', () => {
  it('date template on empty prop returns fallback', () => {
    // {date:prop:created_at|DD/MM/YYYY} — prop:created_at returns ''
    const result = formatLabel('{date:prop:created_at|DD/MM/YYYY}', 'node', makeNode())
    // parseDate('') returns null, so fallback is [created_at]
    expect(result).toBe('[created_at]')
  })

  it('date template without format uses YYYY-MM-DD default', () => {
    // Tests parsing path when no format specified
    const result = formatLabel('{date:prop:ts}', 'node', makeNode())
    expect(result).toBe('[ts]') // empty prop → fallback
  })
})

// ============================================================================
// prop: placeholders
// ============================================================================

describe('prop: placeholders', () => {
  it('resolves prop from node.properties', () => {
    const node = makeNode({ properties: { name: 'Alice' } })
    expect(formatLabel('{prop:name}', 'node', node)).toBe('Alice')
  })

  it('resolves prop from edge.properties', () => {
    const edge = makeEdge({ properties: { weight: 0.75 } })
    expect(formatLabel('{prop:weight}', 'edge', edge)).toBe('0.75')
  })

  it('returns fallback [field] when property is missing', () => {
    const node = makeNode({ properties: { age: 30 } })
    expect(formatLabel('{prop:name}', 'node', node)).toBe('[name]')
  })

  it('returns fallback [field] when properties is undefined', () => {
    const node = makeNode()
    expect(formatLabel('{prop:name}', 'node', node)).toBe('[name]')
  })

  it('applies modifier to resolved property', () => {
    const node = makeNode({ properties: { name: 'alice' } })
    expect(formatLabel('{prop:name|upper}', 'node', node)).toBe('ALICE')
  })

  it('handles null property value', () => {
    const node = makeNode({ properties: { name: null } })
    expect(formatLabel('{prop:name}', 'node', node)).toBe('[name]')
  })

  it('handles numeric property value', () => {
    const node = makeNode({ properties: { score: 42 } })
    expect(formatLabel('{prop:score}', 'node', node)).toBe('42')
  })

  it('combines prop with built-in placeholders', () => {
    const node = makeNode({ properties: { name: 'Alice' } })
    expect(formatLabel('{node_type}: {prop:name}', 'node', node)).toBe('Person: Alice')
  })
})

// ============================================================================
// cache eviction
// ============================================================================

describe('cache eviction', () => {
  it('cache evicts oldest entry when exceeding 1000', () => {
    // Fill cache with 1001 unique templates
    for (let i = 0; i < 1001; i++) {
      formatLabel(`template-${i} {node_id}`, 'node', makeNode())
    }
    // Should still work — the eviction doesn't break functionality
    expect(formatLabel('template-1001 {node_id}', 'node', makeNode())).toBe('template-1001 alice')
  })
})

// ============================================================================
// Complex combinations: conditionals with nested placeholders
// ============================================================================

describe('conditionals with nested placeholders (nodes)', () => {
  const ghostNode = makeNode({
    node_id: 'ghost-1',
    node_type: 'Entity',
    properties: { is_ghost: 'true', label: 'Phantom', status: 'active', score: '95' },
  })

  const normalNode = makeNode({
    node_id: 'person-1',
    node_type: 'Person',
    properties: { is_ghost: 'false', label: 'Alice', status: 'inactive', score: '42' },
  })

  const noPropsNode = makeNode({ node_id: 'bare-1', node_type: 'Thing' })

  it('resolves {node_id} inside true branch', () => {
    const tpl = '{if:prop:is_ghost==true|{node_id}|{prop:label}}'
    expect(formatLabel(tpl, 'node', ghostNode)).toBe('ghost-1')
  })

  it('resolves {prop:label} inside false branch', () => {
    const tpl = '{if:prop:is_ghost==true|{node_id}|{prop:label}}'
    expect(formatLabel(tpl, 'node', normalNode)).toBe('Alice')
  })

  it('resolves {node_type} inside conditional branch', () => {
    const tpl = '{if:prop:status==active|{node_type}: ativo|{node_type}: inativo}'
    expect(formatLabel(tpl, 'node', ghostNode)).toBe('Entity: ativo')
    expect(formatLabel(tpl, 'node', normalNode)).toBe('Person: inativo')
  })

  it('resolves modifiers inside conditional branches', () => {
    const tpl = '{if:prop:is_ghost==true|{node_id|upper}|{prop:label|lower}}'
    expect(formatLabel(tpl, 'node', ghostNode)).toBe('GHOST-1')
    expect(formatLabel(tpl, 'node', normalNode)).toBe('alice')
  })

  it('resolves multiple placeholders inside one branch', () => {
    const tpl = '{if:prop:status==active|{node_type} - {prop:label}|{node_id}}'
    expect(formatLabel(tpl, 'node', ghostNode)).toBe('Entity - Phantom')
    expect(formatLabel(tpl, 'node', normalNode)).toBe('person-1')
  })

  it('handles missing prop inside branch with fallback', () => {
    // noPropsNode has no properties → {prop:label} falls back to [label]
    const tpl = '{if:prop:is_ghost==true|ghost|{prop:label}}'
    // prop:is_ghost == '' which != 'true', so false branch
    expect(formatLabel(tpl, 'node', noPropsNode)).toBe('[label]')
  })

  it('conditional with != and nested placeholders', () => {
    const tpl = '{if:prop:status!=active|OFF: {node_id}|ON: {prop:label}}'
    expect(formatLabel(tpl, 'node', ghostNode)).toBe('ON: Phantom')
    expect(formatLabel(tpl, 'node', normalNode)).toBe('OFF: person-1')
  })

  it('conditional with numeric > and nested placeholders', () => {
    const tpl = '{if:prop:score>50|High: {prop:score}|Low: {prop:score}}'
    expect(formatLabel(tpl, 'node', ghostNode)).toBe('High: 95')
    expect(formatLabel(tpl, 'node', normalNode)).toBe('Low: 42')
  })

  it('conditional with truncate modifier inside branch', () => {
    const longNode = makeNode({
      node_id: 'a-very-long-identifier-that-should-be-truncated',
      properties: { is_ghost: 'true' },
    })
    const tpl = '{if:prop:is_ghost==true|{node_id|truncate:15}|full}'
    const result = formatLabel(tpl, 'node', longNode)
    expect(result.length).toBeLessThanOrEqual(15)
    expect(result).toContain('...')
  })
})

describe('conditionals with nested placeholders (edges)', () => {
  const strongEdge = makeEdge({
    edge_id: 'e-strong',
    src: 'alice',
    dst: 'bob',
    relationship_type: 'KNOWS',
    properties: { weight: '0.9', type: 'strong', since: '2020' },
  })

  const weakEdge = makeEdge({
    edge_id: 'e-weak',
    src: 'carol',
    dst: 'dave',
    relationship_type: 'FOLLOWS',
    properties: { weight: '0.2', type: 'weak', since: '2023' },
  })

  it('resolves {src} and {dst} inside conditional branches', () => {
    const tpl = '{if:prop:type==strong|{src} <=> {dst}|{src} -> {dst}}'
    expect(formatLabel(tpl, 'edge', strongEdge)).toBe('alice <=> bob')
    expect(formatLabel(tpl, 'edge', weakEdge)).toBe('carol -> dave')
  })

  it('resolves {relationship_type} inside conditional branch', () => {
    const tpl = '{if:prop:weight>0.5|{relationship_type} (forte)|{relationship_type} (fraco)}'
    expect(formatLabel(tpl, 'edge', strongEdge)).toBe('KNOWS (forte)')
    expect(formatLabel(tpl, 'edge', weakEdge)).toBe('FOLLOWS (fraco)')
  })

  it('resolves modifiers on edge placeholders inside branches', () => {
    const tpl = '{if:prop:type==strong|{relationship_type|lower}|{relationship_type|upper}}'
    expect(formatLabel(tpl, 'edge', strongEdge)).toBe('knows')
    expect(formatLabel(tpl, 'edge', weakEdge)).toBe('FOLLOWS')
  })

  it('resolves {edge_id} inside conditional branch', () => {
    const tpl = '{if:prop:type==strong|[{edge_id}] {src}->{dst}|{edge_id}}'
    expect(formatLabel(tpl, 'edge', strongEdge)).toBe('[e-strong] alice->bob')
    expect(formatLabel(tpl, 'edge', weakEdge)).toBe('e-weak')
  })

  it('resolves {prop:weight|percent} inside branch', () => {
    const tpl = '{if:prop:weight>0.5|{prop:weight|percent} forte|{prop:weight|percent} fraco}'
    expect(formatLabel(tpl, 'edge', strongEdge)).toBe('90.0% forte')
    expect(formatLabel(tpl, 'edge', weakEdge)).toBe('20.0% fraco')
  })
})

describe('multiple conditionals and mixed templates', () => {
  const node = makeNode({
    node_id: 'n1',
    node_type: 'Server',
    properties: { status: 'active', cpu: '85', region: 'us-east', label: 'WebServer' },
  })

  it('conditional followed by regular placeholder', () => {
    const tpl = '{if:prop:status==active|ON|OFF} - {node_id}'
    expect(formatLabel(tpl, 'node', node)).toBe('ON - n1')
  })

  it('regular placeholder followed by conditional', () => {
    const tpl = '{node_type}: {if:prop:cpu>80|HOT|OK}'
    expect(formatLabel(tpl, 'node', node)).toBe('Server: HOT')
  })

  it('two conditionals in same template', () => {
    const tpl = '{if:prop:status==active|ON|OFF} | CPU: {if:prop:cpu>80|HIGH|NORMAL}'
    expect(formatLabel(tpl, 'node', node)).toBe('ON | CPU: HIGH')
  })

  it('conditional + prop + modifier all mixed', () => {
    const tpl = '{prop:label|upper} [{if:prop:status==active|{prop:region}|?}]'
    expect(formatLabel(tpl, 'node', node)).toBe('WEBSERVER [us-east]')
  })

  it('two conditionals with nested placeholders', () => {
    const tpl = '{if:prop:status==active|{prop:label}|{node_id}} ({if:prop:cpu>80|{prop:cpu}%|ok})'
    expect(formatLabel(tpl, 'node', node)).toBe('WebServer (85%)')
  })

  it('conditional with contains operator and nested placeholder', () => {
    const tpl = '{if:prop:regioncontainseast|{prop:region|upper}|{prop:region}}'
    expect(formatLabel(tpl, 'node', node)).toBe('US-EAST')
  })

  it('conditional with startsWith and nested placeholders', () => {
    const tpl = '{if:prop:regionstartsWithus|USA: {prop:label}|Other: {prop:label}}'
    expect(formatLabel(tpl, 'node', node)).toBe('USA: WebServer')
  })

  it('edge: mixed conditional with all edge fields', () => {
    const edge = makeEdge({
      src: 'server-1',
      dst: 'server-2',
      relationship_type: 'REPLICATES',
      properties: { lag: '150', healthy: 'true' },
    })
    const tpl = '{src} {if:prop:healthy==true|==>|~~>} {dst} ({if:prop:lag>100|lag:{prop:lag}ms|ok})'
    expect(formatLabel(tpl, 'edge', edge)).toBe('server-1 ==> server-2 (lag:150ms)')
  })
})

describe('conditionals with formatNodeLabel and formatEdgeLabel (rules)', () => {
  it('node rule with conditional and nested placeholders', () => {
    const node = makeNode({
      node_id: 'x1',
      node_type: 'Device',
      properties: { online: 'true', name: 'Router' },
    })
    const rule = makeRule({
      target: 'node',
      types: ['Device'],
      template: '{if:prop:online==true|{prop:name}|{node_id} (offline)}',
    })
    expect(formatNodeLabel(node, [rule], '{node_id}')).toBe('Router')

    const offlineNode = makeNode({
      node_id: 'x2',
      node_type: 'Device',
      properties: { online: 'false', name: 'Switch' },
    })
    expect(formatNodeLabel(offlineNode, [rule], '{node_id}')).toBe('x2 (offline)')
  })

  it('edge rule with conditional and nested placeholders', () => {
    const edge = makeEdge({
      src: 'a',
      dst: 'b',
      relationship_type: 'LINK',
      properties: { encrypted: 'true' },
    })
    const rule = makeRule({
      target: 'edge',
      types: ['LINK'],
      template: '{src} {if:prop:encrypted==true|🔒|🔓} {dst}',
    })
    expect(formatEdgeLabel(edge, [rule], '{relationship_type}')).toBe('a 🔒 b')
  })

  it('falls back to default when rule does not match, default has conditional', () => {
    const node = makeNode({
      node_id: 'z1',
      node_type: 'Unknown',
      properties: { visible: 'false' },
    })
    const rule = makeRule({ target: 'node', types: ['Other'], template: 'OTHER' })
    const defaultTpl = '{if:prop:visible==true|{prop:label}|{node_id}}'
    expect(formatNodeLabel(node, [rule], defaultTpl)).toBe('z1')
  })
})
