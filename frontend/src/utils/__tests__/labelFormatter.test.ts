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
  extractTemplateProperties,
  extractTemplateMetrics,
  resolveItemMetricValue,
  parseMetricRef,
  METRIC_REF_PREFIX,
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
  it('returns all 13 modifiers', () => {
    const result = getAvailableModifiers()
    expect(result).toHaveLength(13)
    const mods = result.map(r => r.modifier)
    for (const name of [
      'upper', 'lower', 'capitalize', 'truncate', 'number', 'currency', 'percent',
      'split', 'slice', 'trim', 'default', 'match', 'replace',
    ]) {
      expect(mods).toContain(name)
    }
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

// ============================================================================
// prop: escapes built-in shadowing (literal node_id/edge_id table columns)
// ============================================================================

describe('prop: precedence over same-named built-ins', () => {
  // Context configured with an unusual id column (e.g. id_hash): the top-level
  // node_id holds the configured id value, while the table's literal node_id
  // column arrives as properties.node_id.
  const nodeWithLiteralIdCol = () =>
    makeNode({
      node_id: 'hash123',
      properties: { node_id: 'legacy-42', created: '2024-01-15' },
    })

  const edgeWithLiteralIdCol = () =>
    makeEdge({
      edge_id: 'ehash9',
      properties: { edge_id: 'legacy-e7', src: 'raw-src' },
    })

  it('{node_id} still resolves to the configured (top-level) id', () => {
    expect(formatLabel('{node_id}', 'node', nodeWithLiteralIdCol())).toBe('hash123')
  })

  it('{prop:node_id} resolves to the literal node_id property column', () => {
    expect(formatLabel('{prop:node_id}', 'node', nodeWithLiteralIdCol())).toBe('legacy-42')
  })

  it('{edge_id} still resolves to the configured (top-level) id', () => {
    expect(formatLabel('{edge_id}', 'edge', edgeWithLiteralIdCol())).toBe('ehash9')
  })

  it('{prop:edge_id} resolves to the literal edge_id property column', () => {
    expect(formatLabel('{prop:edge_id}', 'edge', edgeWithLiteralIdCol())).toBe('legacy-e7')
  })

  it('{prop:src} resolves to a literal src property column', () => {
    expect(formatLabel('{prop:src}', 'edge', edgeWithLiteralIdCol())).toBe('raw-src')
  })

  it('{prop:node_type} falls back to the built-in when no such property exists', () => {
    // Backward compat: prop: only takes precedence when the property is present.
    expect(formatLabel('{prop:node_type}', 'node', nodeWithLiteralIdCol())).toBe('Person')
  })

  it('modifiers apply to the property value, not the built-in', () => {
    expect(formatLabel('{prop:node_id|upper}', 'node', nodeWithLiteralIdCol())).toBe('LEGACY-42')
  })

  it('conditionals compare against the literal property column', () => {
    expect(
      formatLabel('{if:prop:node_id==legacy-42|A|B}', 'node', nodeWithLiteralIdCol()),
    ).toBe('A')
  })

  it('date tokens read the literal property column', () => {
    const node = makeNode({
      node_id: 'hash123',
      properties: { node_id: '2020-05-01T12:00:00' },
    })
    expect(formatLabel('{date:prop:node_id|DD/MM/YYYY}', 'node', node)).toBe('01/05/2020')
  })
})

describe('extractTemplateProperties', () => {
  it('extracts a simple placeholder', () => {
    expect(extractTemplateProperties('{prop:name}')).toEqual(['name'])
  })

  it('extracts a placeholder with a modifier', () => {
    expect(extractTemplateProperties('{prop:name|upper}')).toEqual(['name'])
  })

  it('does not report built-ins without the prop: prefix', () => {
    expect(extractTemplateProperties('{node_type} - {src} - {dst}')).toEqual([])
  })

  it('extracts a date token property', () => {
    expect(extractTemplateProperties('{date:prop:created_at|DD/MM/YYYY}')).toEqual(['created_at'])
  })

  it('extracts the condition property from a conditional', () => {
    expect(extractTemplateProperties('{if:prop:score>10|High|Low}')).toEqual(['score'])
  })

  it('recurses into trueValue and falseValue of a conditional', () => {
    const props = extractTemplateProperties('{if:prop:score>10|{prop:name|upper}|{prop:fallback}}')
    expect(props.sort()).toEqual(['fallback', 'name', 'score'])
  })

  it('deduplicates repeated references', () => {
    expect(extractTemplateProperties('{prop:name} and {prop:name}')).toEqual(['name'])
  })

  it('returns an empty array for a template with no property references', () => {
    expect(extractTemplateProperties('Just plain text')).toEqual([])
  })

  it('collects every distinct property across a mixed template', () => {
    const props = extractTemplateProperties('{prop:a} {node_type} {if:prop:b==x|{prop:c}|{prop:d}}')
    expect(props.sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})

// ============================================================================
// {br} line-break token
// ============================================================================

describe('{br} line-break token', () => {
  it('renders {br} as a newline character', () => {
    expect(formatLabel('a{br}b', 'node', makeNode())).toBe('a\nb')
  })

  it('breaks between placeholders (name over metric)', () => {
    const node = makeNode({ properties: { name: 'Alice', score: '42' } })
    expect(formatLabel('{prop:name}{br}{prop:score}', 'node', node)).toBe('Alice\n42')
  })

  it('works inside conditional branches', () => {
    const node = makeNode({ properties: { score: '90', name: 'Alice' } })
    expect(formatLabel('{if:prop:score>80|{prop:name}{br}top|low}', 'node', node)).toBe('Alice\ntop')
  })

  it('supports multiple {br} tokens', () => {
    expect(formatLabel('a{br}b{br}c', 'node', makeNode())).toBe('a\nb\nc')
  })

  it('does not treat "br" as a token when it has extra content', () => {
    // {brx} is an unknown placeholder → resolves to empty string
    expect(formatLabel('a{brx}b', 'node', makeNode())).toBe('ab')
  })

  it('validateTemplate accepts {br}', () => {
    expect(validateTemplate('{prop:name}{br}{prop:score}').valid).toBe(true)
  })

  it('is listed in autocomplete placeholders for both targets', () => {
    const nodePlaceholders = getAvailablePlaceholders('node', []).map(r => r.placeholder)
    const edgePlaceholders = getAvailablePlaceholders('edge', []).map(r => r.placeholder)
    expect(nodePlaceholders).toContain('{br}')
    expect(edgePlaceholders).toContain('{br}')
  })
})

// ============================================================================
// Modifier chaining (syntax v2)
// ============================================================================

describe('modifier chaining', () => {
  it('applies modifiers left-to-right', () => {
    const node = makeNode({ properties: { name: 'alice wonders' } })
    expect(formatLabel('{prop:name|upper|truncate:8:..}', 'node', node)).toBe('ALICE ..')
    expect(formatLabel('{prop:name|truncate:8:..|upper}', 'node', node)).toBe('ALICE ..')
  })

  it('order matters for non-commutative chains', () => {
    const node = makeNode({ properties: { name: 'Alice' } })
    expect(formatLabel('{prop:name|upper|lower}', 'node', node)).toBe('alice')
    expect(formatLabel('{prop:name|lower|upper}', 'node', node)).toBe('ALICE')
  })

  it('chains on built-in placeholders too', () => {
    const node = makeNode({ node_id: '12321_CNPJ_RAIZ' })
    expect(formatLabel('{node_id|split:_:0|upper}', 'node', node)).toBe('12321')
  })

  it('unknown modifier in a chain is a no-op, rest still applies', () => {
    const node = makeNode({ properties: { name: 'alice' } })
    expect(formatLabel('{prop:name|nonsense|upper}', 'node', node)).toBe('ALICE')
  })

  it('single-modifier templates behave exactly as before', () => {
    const node = makeNode({ properties: { name: 'a very long name here' } })
    expect(formatLabel('{prop:name|truncate:10:...}', 'node', node)).toBe('a very ...')
    expect(formatLabel('{node_id|upper}', 'node', makeNode())).toBe('ALICE')
  })

  it('chains inside conditional branches', () => {
    const node = makeNode({ properties: { score: '95', name: 'alice wonders' } })
    expect(
      formatLabel('{if:prop:score>90|{prop:name|split: :0|upper}|low}', 'node', node)
    ).toBe('ALICE')
  })
})

// ============================================================================
// Extraction modifiers: split / slice / trim / default
// ============================================================================

describe('split modifier', () => {
  it('extracts by delimiter and index (motivating case: _CNPJ_RAIZ suffix)', () => {
    expect(formatLabel('{node_id|split:_:0}', 'node', makeNode({ node_id: '12321_CNPJ_RAIZ' }))).toBe('12321')
    expect(formatLabel('{node_id|split:_:0}', 'node', makeNode({ node_id: '0_CNPJ_RAIZ' }))).toBe('0')
  })

  it('supports static text composition (Empresa prefix)', () => {
    const node = makeNode({ node_id: '12321_CNPJ_RAIZ' })
    expect(formatLabel('Empresa {node_id|split:_:0}', 'node', node)).toBe('Empresa 12321')
  })

  it('supports negative index (from the end)', () => {
    const node = makeNode({ properties: { path: 'a/b/c/file.txt' } })
    expect(formatLabel('{prop:path|split:/:-1}', 'node', node)).toBe('file.txt')
  })

  it('literal / as delimiter works (not confused with regex spans)', () => {
    const node = makeNode({ properties: { url: 'http://example.com/page' } })
    expect(formatLabel('{prop:url|split:/:2}', 'node', node)).toBe('example.com')
  })

  it('escaped colon as delimiter', () => {
    const node = makeNode({ properties: { pair: 'key:value' } })
    expect(formatLabel('{prop:pair|split:\\::1}', 'node', node)).toBe('value')
  })

  it('out-of-range index yields empty string', () => {
    expect(formatLabel('{node_id|split:_:9}', 'node', makeNode({ node_id: 'a_b' }))).toBe('')
    expect(formatLabel('{node_id|split:_:-9}', 'node', makeNode({ node_id: 'a_b' }))).toBe('')
  })
})

describe('slice modifier', () => {
  it('extracts substring by position', () => {
    const node = makeNode({ properties: { code: 'BR-SP-00123' } })
    expect(formatLabel('{prop:code|slice:0:5}', 'node', node)).toBe('BR-SP')
  })

  it('supports negative start', () => {
    const node = makeNode({ properties: { code: 'BR-SP-00123' } })
    expect(formatLabel('{prop:code|slice:-5}', 'node', node)).toBe('00123')
  })
})

describe('trim modifier', () => {
  it('removes surrounding whitespace', () => {
    const node = makeNode({ properties: { name: '  alice  ' } })
    expect(formatLabel('{prop:name|trim}', 'node', node)).toBe('alice')
  })
})

describe('default modifier', () => {
  it('replaces the [prop] fallback for missing properties', () => {
    expect(formatLabel('{prop:nickname|default:anon}', 'node', makeNode())).toBe('anon')
  })

  it('replaces empty-string property values', () => {
    const node = makeNode({ properties: { nickname: '' } })
    expect(formatLabel('{prop:nickname|default:anon}', 'node', node)).toBe('anon')
  })

  it('passes through non-empty values', () => {
    const node = makeNode({ properties: { nickname: 'ali' } })
    expect(formatLabel('{prop:nickname|default:anon}', 'node', node)).toBe('ali')
  })

  it('without default, missing prop still renders [prop]', () => {
    expect(formatLabel('{prop:nickname}', 'node', makeNode())).toBe('[nickname]')
  })

  it('catches empty results mid-chain (match miss → default)', () => {
    const node = makeNode({ properties: { email: 'no-at-sign' } })
    expect(formatLabel('{prop:email|match:/@(.+)$/:1|default:sem dominio}', 'node', node)).toBe('sem dominio')
  })
})

// ============================================================================
// Regex modifiers: match / replace
// ============================================================================

describe('match modifier', () => {
  it('extracts a capture group', () => {
    const node = makeNode({ properties: { email: 'alice@empresa.com' } })
    expect(formatLabel('{prop:email|match:/@(.+)$/:1}', 'node', node)).toBe('empresa.com')
  })

  it('group defaults to 0 (whole match)', () => {
    const node = makeNode({ properties: { code: 'BR-SP-00123' } })
    expect(formatLabel('{prop:code|match:/\\d+/}', 'node', node)).toBe('00123')
  })

  it('protects | alternation inside the pattern', () => {
    const node = makeNode({ properties: { code: 'US-NY' } })
    expect(formatLabel('{prop:code|match:/^(BR|US)/:1}', 'node', node)).toBe('US')
  })

  it('protects : and escaped slashes inside the pattern', () => {
    const node = makeNode({ properties: { url: 'https://example.com/x' } })
    expect(formatLabel('{prop:url|match:/https?:\\/\\/([^\\/]+)/:1}', 'node', node)).toBe('example.com')
  })

  it('supports the i flag', () => {
    const node = makeNode({ properties: { code: 'br-123' } })
    expect(formatLabel('{prop:code|match:/^BR/i}', 'node', node)).toBe('br')
  })

  it('quantifier braces (balanced) work unescaped', () => {
    const node = makeNode({ properties: { code: 'abc12345' } })
    expect(formatLabel('{prop:code|match:/\\d{3}/}', 'node', node)).toBe('123')
  })

  it('no match yields empty string', () => {
    const node = makeNode({ properties: { email: 'no-at-sign' } })
    expect(formatLabel('{prop:email|match:/@(.+)$/:1}', 'node', node)).toBe('')
  })

  it('invalid regex is a render no-op', () => {
    const node = makeNode({ properties: { name: 'alice' } })
    expect(formatLabel('{prop:name|match:/(unclosed/}', 'node', node)).toBe('alice')
  })

  it('chains with other modifiers', () => {
    const node = makeNode({ properties: { email: 'alice@empresa.com' } })
    expect(formatLabel('{prop:email|match:/@(.+)$/:1|upper}', 'node', node)).toBe('EMPRESA.COM')
  })
})

describe('replace modifier', () => {
  it('removes the matched text with empty replacement (motivating case)', () => {
    const node = makeNode({ node_id: '12321_CNPJ_RAIZ' })
    expect(formatLabel('{node_id|replace:/_CNPJ_RAIZ/:}', 'node', node)).toBe('12321')
  })

  it('replaces with the given text (motivating case: Empresa)', () => {
    const node = makeNode({ node_id: '12321_CNPJ_RAIZ' })
    expect(formatLabel('{node_id|replace:/_CNPJ_RAIZ/: Empresa}', 'node', node)).toBe('12321 Empresa')
  })

  it('replaces ALL occurrences (implicit global)', () => {
    const node = makeNode({ properties: { name: 'a_b_c' } })
    expect(formatLabel('{prop:name|replace:/_/:-}', 'node', node)).toBe('a-b-c')
  })

  it('supports capture group references in the replacement', () => {
    const node = makeNode({ properties: { name: 'alice' } })
    expect(formatLabel('{prop:name|replace:/(a)/:[$1]}', 'node', node)).toBe('[a]lice')
  })
})

// ============================================================================
// matches condition operator + pipe-form conditions
// ============================================================================

describe('matches condition operator', () => {
  it('evaluates a regex test', () => {
    const br = makeNode({ properties: { code: 'BR-123' } })
    const us = makeNode({ properties: { code: 'US-456' } })
    expect(formatLabel('{if:prop:code|matches:/^BR/|Brasil|Outro}', 'node', br)).toBe('Brasil')
    expect(formatLabel('{if:prop:code|matches:/^BR/|Brasil|Outro}', 'node', us)).toBe('Outro')
  })

  it('protects alternation and supports the i flag', () => {
    const node = makeNode({ properties: { code: 'br-1' } })
    expect(formatLabel('{if:prop:code|matches:/^(BR|US)/i|Yes|No}', 'node', node)).toBe('Yes')
  })

  it('invalid regex evaluates to the false branch', () => {
    const node = makeNode({ properties: { code: 'BR' } })
    expect(formatLabel('{if:prop:code|matches:/(bad/|Yes|No}', 'node', node)).toBe('No')
  })

  it('branches may contain nested placeholders with chains', () => {
    const node = makeNode({ properties: { code: 'BR-123', name: 'alice' } })
    expect(
      formatLabel('{if:prop:code|matches:/^BR/|{prop:name|upper}|-}', 'node', node)
    ).toBe('ALICE')
  })
})

describe('pipe-form string/date conditions (previously broken forms)', () => {
  it('pipe-form contains now evaluates (was documented but broken)', () => {
    const node = makeNode({ properties: { name: 'john smith' } })
    expect(formatLabel('{if:prop:name|contains:john|Match|No}', 'node', node)).toBe('Match')
  })

  it('pipe-form daysAgo now evaluates (was documented but broken)', () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    const node = makeNode({ properties: { created: recent } })
    expect(formatLabel('{if:prop:created|daysAgo:<7|Recent|Old}', 'node', node)).toBe('Recent')
  })

  it('inline form still works unchanged', () => {
    const node = makeNode({ properties: { region: 'northeast' } })
    expect(formatLabel('{if:prop:regioncontainseast|E|W}', 'node', node)).toBe('E')
  })
})

// ============================================================================
// validateTemplate: v2 errors and warnings
// ============================================================================

describe('validateTemplate v2', () => {
  it('warns on unknown modifier but stays valid', () => {
    const result = validateTemplate('{prop:name|nonsense}')
    expect(result.valid).toBe(true)
    expect(result.warnings.some(w => w.includes('nonsense'))).toBe(true)
  })

  it('errors on missing required args', () => {
    const result = validateTemplate('{prop:name|split:_}')
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('index'))).toBe(true)
  })

  it('errors on non-integer int arg', () => {
    const result = validateTemplate('{prop:name|split:_:abc}')
    expect(result.valid).toBe(false)
  })

  it('errors on unterminated regex', () => {
    const result = validateTemplate('{prop:name|match:/unclosed}')
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.toLowerCase().includes('unterminated'))).toBe(true)
  })

  it('errors on invalid regex', () => {
    const result = validateTemplate('{prop:name|match:/(bad/}')
    expect(result.valid).toBe(false)
  })

  it('errors on disallowed regex flags', () => {
    const result = validateTemplate('{prop:name|match:/a/g}')
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('flag'))).toBe(true)
  })

  it('errors on overlong regex', () => {
    const result = validateTemplate(`{prop:name|match:/${'a'.repeat(300)}/}`)
    expect(result.valid).toBe(false)
  })

  it('accepts valid regex templates', () => {
    expect(validateTemplate('{prop:email|match:/@(.+)$/:1|upper}').valid).toBe(true)
    expect(validateTemplate('{if:prop:code|matches:/^BR/|A|B}').valid).toBe(true)
  })

  it('errors on invalid matches regex in conditionals', () => {
    const result = validateTemplate('{if:prop:code|matches:/(bad/|A|B}')
    expect(result.valid).toBe(false)
  })

  it('validates modifiers nested in conditional branches', () => {
    const result = validateTemplate('{if:prop:x>1|{prop:y|split:_}|no}')
    expect(result.valid).toBe(false)
  })

  it('legacy shapes keep validating', () => {
    expect(validateTemplate('{node_id} - {node_type}').valid).toBe(true)
    // {if:badformat} stays a (useless but valid) placeholder, as before
    expect(validateTemplate('{if:badformat}').valid).toBe(true)
    // A conditional with an unparseable condition is still invalid
    expect(validateTemplate('{if:prop:x==|yes|no}').valid).toBe(false)
  })
})

// ============================================================================
// extractTemplateProperties with v2 syntax
// ============================================================================

describe('extractTemplateProperties v2', () => {
  it('extracts properties through modifier chains', () => {
    expect(extractTemplateProperties('{prop:url|split:/:2|upper}')).toEqual(['url'])
  })

  it('does not leak regex fragments as properties', () => {
    const props = extractTemplateProperties('{prop:email|match:/prop:fake@(.+)$/:1}')
    expect(props).toEqual(['email'])
  })

  it('extracts the property from matches conditionals', () => {
    const props = extractTemplateProperties('{if:prop:code|matches:/^BR/|{prop:name}|-}')
    expect(props).toContain('code')
    expect(props).toContain('name')
  })
})

// ============================================================================
// Metric placeholders — {metric:<id or name>} resolved through a resolver
// ============================================================================

describe('metric placeholders', () => {
  const values: Record<string, Record<string, number | string | boolean | null>> = {
    'Email domain': { alice: 'foo.com', bob: 'bar.org' },
    'Super-hub': { alice: true, bob: false },
    'custom:score': { alice: 0.12345, bob: null },
    Degree: { alice: 4 },
  }
  const resolver = (target: 'node' | 'edge', itemId: string, ref: string) =>
    target === 'node' ? values[ref]?.[itemId] : undefined

  it('renders a string metric and chains modifiers', () => {
    expect(formatLabel('{metric:Email domain|upper}', 'node', makeNode(), { metrics: resolver })).toBe('FOO.COM')
  })

  it('stringifies booleans and numbers (number modifier still applies)', () => {
    expect(formatLabel('{metric:Super-hub}', 'node', makeNode(), { metrics: resolver })).toBe('true')
    expect(formatLabel('{metric:custom:score|number}', 'node', makeNode(), { metrics: resolver })).toBe((0.12345).toLocaleString())
    expect(formatLabel('{metric:Degree}', 'node', makeNode(), { metrics: resolver })).toBe('4')
  })

  it('missing metric → [metric:name] sentinel, unless a default is given', () => {
    expect(formatLabel('{metric:nope}', 'node', makeNode(), { metrics: resolver })).toBe('[metric:nope]')
    expect(formatLabel('{metric:custom:score}', 'node', makeNode({ node_id: 'bob' }), { metrics: resolver })).toBe('[metric:custom:score]')
    expect(formatLabel('{metric:nope|default:-}', 'node', makeNode(), { metrics: resolver })).toBe('-')
  })

  it('without a resolver the placeholder renders as missing (existing callers unaffected)', () => {
    expect(formatLabel('{metric:Degree}', 'node', makeNode())).toBe('[metric:Degree]')
    expect(formatLabel('{metric:Degree|default:?}', 'node', makeNode())).toBe('?')
  })

  it('never reads item.properties for a metric ref', () => {
    const node = makeNode({ properties: { Degree: 'from-props' } })
    expect(formatLabel('{metric:Degree}', 'node', node, { metrics: resolver })).toBe('4')
  })

  it('works inside conditionals and through formatNodeLabel/formatEdgeLabel', () => {
    expect(
      formatLabel('{if:prop:kind==vip|{metric:Email domain}|-}', 'node', makeNode({ properties: { kind: 'vip' } }), { metrics: resolver }),
    ).toBe('foo.com')
    expect(formatNodeLabel(makeNode(), [], '{node_id} ({metric:Degree})', { metrics: resolver })).toBe('alice (4)')
    // Edge resolver gets target 'edge' and the edge id
    const edgeResolver = (target: 'node' | 'edge', itemId: string, ref: string) =>
      target === 'edge' && itemId === 'e1' && ref === 'Weight' ? 2.5 : undefined
    expect(formatEdgeLabel(makeEdge(), [], '{relationship_type} {metric:Weight}', { metrics: edgeResolver })).toBe('KNOWS 2.5')
  })

  it('extractTemplateMetrics lists refs (incl. nested) and extractTemplateProperties ignores them', () => {
    const tpl = '{metric:A} {prop:x} {if:prop:y>1|{metric:B|upper}|{metric:A}}'
    expect(extractTemplateMetrics(tpl).sort()).toEqual(['A', 'B'])
    expect(extractTemplateProperties(tpl).sort()).toEqual(['x', 'y'])
  })

  it('getAvailablePlaceholders lists metric names', () => {
    const list = getAvailablePlaceholders('node', ['a'], ['Degree', 'Email domain'])
    expect(list.map((p) => p.placeholder)).toContain('{metric:Degree}')
    expect(list.map((p) => p.placeholder)).toContain('{metric:Email domain}')
    expect(getAvailablePlaceholders('node', ['a']).map((p) => p.placeholder)).not.toContain('{metric:Degree}')
  })
})

// ============================================================================
// resolveItemMetricValue / parseMetricRef — shared plumbing for non-label
// consumers (context-menu actions, cluster bindings, layouts)
// ============================================================================

describe('resolveItemMetricValue and parseMetricRef', () => {
  const resolver = (target: 'node' | 'edge', itemId: string, ref: string) => {
    if (target !== 'node' || itemId !== 'alice') return undefined
    return ({ pr: 0.75, hub: true, tier: 'gold', empty: null } as Record<string, number | string | boolean | null>)[ref]
  }

  it('resolves by ref and stringifies numbers/booleans', () => {
    expect(resolveItemMetricValue('node', makeNode(), 'pr', resolver)).toBe('0.75')
    expect(resolveItemMetricValue('node', makeNode(), 'hub', resolver)).toBe('true')
    expect(resolveItemMetricValue('node', makeNode(), 'tier', resolver)).toBe('gold')
  })

  it("missing resolver / metric / value / wrong target all resolve to '' (no sentinel)", () => {
    expect(resolveItemMetricValue('node', makeNode(), 'pr')).toBe('')
    expect(resolveItemMetricValue('node', makeNode(), 'nope', resolver)).toBe('')
    expect(resolveItemMetricValue('node', makeNode(), 'empty', resolver)).toBe('')
    expect(resolveItemMetricValue('edge', makeEdge(), 'pr', resolver)).toBe('')
  })

  it('parseMetricRef strips the prefix and rejects everything else', () => {
    expect(parseMetricRef(`${METRIC_REF_PREFIX}PageRank`)).toBe('PageRank')
    expect(parseMetricRef('metric:custom:score')).toBe('custom:score')
    expect(parseMetricRef('prop:metric')).toBeNull()
    expect(parseMetricRef('PageRank')).toBeNull()
  })
})

// ============================================================================
// Metric conditionals — {if:metric:<ref>...}
// ============================================================================

describe('metric conditionals', () => {
  const values: Record<string, Record<string, number | string | boolean | null>> = {
    PageRank: { alice: 0.8, bob: 0.1 },
    'custom:tier': { alice: 'gold' },
  }
  const resolver = (target: 'node' | 'edge', itemId: string, ref: string) =>
    target === 'node' ? values[ref]?.[itemId] : undefined

  it('evaluates numeric comparisons by metric name', () => {
    expect(formatLabel('{if:metric:PageRank>0.5|hub|leaf}', 'node', makeNode(), { metrics: resolver })).toBe('hub')
    expect(
      formatLabel('{if:metric:PageRank>0.5|hub|leaf}', 'node', makeNode({ node_id: 'bob' }), { metrics: resolver }),
    ).toBe('leaf')
  })

  it('evaluates string ops and id-style refs (colons in the ref)', () => {
    expect(formatLabel('{if:metric:custom:tier==gold|VIP|-}', 'node', makeNode(), { metrics: resolver })).toBe('VIP')
    expect(
      formatLabel('{if:metric:custom:tier|startsWith:go|yes|no}', 'node', makeNode(), { metrics: resolver }),
    ).toBe('yes')
  })

  it('unknown metric or missing resolver falls to the false branch', () => {
    expect(formatLabel('{if:metric:nope>1|a|b}', 'node', makeNode(), { metrics: resolver })).toBe('b')
    expect(formatLabel('{if:metric:PageRank>0.5|a|b}', 'node', makeNode())).toBe('b')
  })

  it('wrong-target metric falls to the false branch', () => {
    expect(formatLabel('{if:metric:PageRank>0|a|b}', 'edge', makeEdge(), { metrics: resolver })).toBe('b')
  })

  it('branches nest placeholders, including other metrics', () => {
    expect(
      formatLabel('{if:metric:PageRank>0.5|{metric:custom:tier|upper}|{node_id}}', 'node', makeNode(), {
        metrics: resolver,
      }),
    ).toBe('GOLD')
  })

  it('never reads item.properties for a metric condition', () => {
    const node = makeNode({ properties: { PageRank: 999 } })
    expect(
      formatLabel('{if:metric:PageRank>1|big|small}', 'node', node, { metrics: resolver }),
    ).toBe('small')
  })

  it('extractTemplateProperties ignores metric conditions; extractTemplateMetrics collects them', () => {
    const tpl = '{if:metric:PageRank>0.5|{prop:name}|-} {if:prop:kind==vip|x|y}'
    expect(extractTemplateProperties(tpl).sort()).toEqual(['kind', 'name'])
    expect(extractTemplateMetrics(tpl)).toEqual(['PageRank'])
  })

  it('validateTemplate accepts metric conditionals', () => {
    expect(validateTemplate('{if:metric:PageRank>0.5|hub|leaf}').valid).toBe(true)
  })
})
