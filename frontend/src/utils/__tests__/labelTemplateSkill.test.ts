import { describe, it, expect } from 'vitest'
import { buildLabelTemplateSkill } from '@/utils/labelTemplateSkill'
import { MODIFIER_REGISTRY, MAX_REGEX_LENGTH } from '@/utils/labelModifiers'

describe('buildLabelTemplateSkill', () => {
  const fullInput = {
    nodeTypes: ['Person', 'Company'],
    edgeTypes: ['KNOWS', 'WORKS_AT'],
    nodeProperties: [
      { name: 'name', data_type: 'string', description: 'Full name' },
      { name: 'age', data_type: 'int' },
    ],
    edgeProperties: [{ name: 'since', data_type: 'timestamp' }],
  }

  it('embeds node types and edge types', () => {
    const text = buildLabelTemplateSkill(fullInput)
    expect(text).toContain('Node types (2)')
    expect(text).toContain('- Person')
    expect(text).toContain('- Company')
    expect(text).toContain('Edge / relationship types (2)')
    expect(text).toContain('- KNOWS')
    expect(text).toContain('- WORKS_AT')
  })

  it('embeds node and edge properties with data types and descriptions', () => {
    const text = buildLabelTemplateSkill(fullInput)
    expect(text).toContain('- name (string) — Full name')
    expect(text).toContain('- age (int)')
    expect(text).toContain('- since (timestamp)')
  })

  it('documents the built-in placeholders for nodes and edges', () => {
    const text = buildLabelTemplateSkill(fullInput)
    expect(text).toContain('{node_id}')
    expect(text).toContain('{node_type}')
    expect(text).toContain('{edge_id}')
    expect(text).toContain('{relationship_type}')
    expect(text).toContain('{src}')
    expect(text).toContain('{dst}')
    expect(text).toContain('{prop:<column>}')
  })

  it('documents every modifier supported by the formatter (registry-driven)', () => {
    const text = buildLabelTemplateSkill(fullInput)
    for (const def of Object.values(MODIFIER_REGISTRY)) {
      expect(text).toContain(`|${def.name}`)
      expect(text).toContain(def.example)
    }
    // Chaining is supported since syntax v2
    expect(text).toContain('chain left-to-right')
    expect(text).not.toContain('Only ONE modifier per placeholder')
  })

  it('documents the regex rules and the matches operator', () => {
    const text = buildLabelTemplateSkill(fullInput)
    expect(text).toContain('matches:/^BR/')
    expect(text).toContain(`capped at ${MAX_REGEX_LENGTH} characters`)
  })

  it('documents date formatting and date conditionals', () => {
    const text = buildLabelTemplateSkill(fullInput)
    expect(text).toContain('{date:prop:created|DD/MM/YYYY}')
    expect(text).toContain('daysAgo:<7')
    expect(text).toContain('dateAfter:')
    expect(text).toContain('dateBefore:')
    expect(text).toContain('dateBetween:')
  })

  it('documents conditionals with the inline operator syntax the parser expects', () => {
    const text = buildLabelTemplateSkill(fullInput)
    expect(text).toContain('{if:prop:active==true|Active|Inactive}')
    // The parser reads `prop:<field><operator><value>` with no separators —
    // a pipe/space form (as an older help slide showed) does not parse.
    expect(text).toContain('{if:prop:namecontainsjohn|Match|No match}')
    expect(text).toContain('no spaces or separators')
  })

  it('documents the rule shape used by the Labels panel', () => {
    const text = buildLabelTemplateSkill(fullInput)
    expect(text).toContain("target: 'node' | 'edge'")
    expect(text).toContain('types: string[]')
    expect(text).toContain('priority: number')
    expect(text).toContain('the highest `priority` wins')
  })

  it('warns that labels are drawn in a 3D canvas and should stay short', () => {
    const text = buildLabelTemplateSkill(fullInput)
    expect(text).toContain('3D canvas')
    expect(text).toContain('truncate')
  })

  it('documents the {br} line-break token', () => {
    const text = buildLabelTemplateSkill(fullInput)
    expect(text).toContain('{br}')
    expect(text).toContain('multiple lines')
  })

  it('warns about the ASCII-only label font and avoids non-ASCII in examples', () => {
    const text = buildLabelTemplateSkill(fullInput)
    expect(text).toContain('basic ASCII')
    // The worked examples must not recommend characters the font cannot draw
    expect(text).not.toContain('…')
    expect(text).not.toContain('🔥')
  })

  it('asks the AI to interview me before writing templates', () => {
    const text = buildLabelTemplateSkill(fullInput)
    expect(text).toContain('Do NOT write templates immediately')
    expect(text).toContain('ask me questions, one topic at a')
    expect(text).toContain('Start by asking me your first question')
  })

  it('renders placeholders when the graph has no types or properties', () => {
    const text = buildLabelTemplateSkill({
      nodeTypes: [],
      edgeTypes: [],
      nodeProperties: [],
      edgeProperties: [],
    })
    expect(text).toContain('Node types (0)')
    expect(text).toContain('(no nodes loaded yet)')
    expect(text).toContain('(no edges loaded yet)')
    expect(text).toContain('(none declared)')
  })
})
