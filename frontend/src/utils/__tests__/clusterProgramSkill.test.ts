import { describe, it, expect } from 'vitest'
import { buildClusterProgramSkill } from '@/utils/clusterProgramSkill'

describe('buildClusterProgramSkill', () => {
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
    const text = buildClusterProgramSkill(fullInput)
    expect(text).toContain('Node types (2)')
    expect(text).toContain('- Person')
    expect(text).toContain('- Company')
    expect(text).toContain('Edge / relationship types (2)')
    expect(text).toContain('- KNOWS')
    expect(text).toContain('- WORKS_AT')
  })

  it('embeds node and edge properties with data types and descriptions', () => {
    const text = buildClusterProgramSkill(fullInput)
    expect(text).toContain('- name (string) — Full name')
    expect(text).toContain('- age (int)')
    expect(text).toContain('- since (timestamp)')
  })

  it('documents the return contract and enforced rules', () => {
    const text = buildClusterProgramSkill(fullInput)
    expect(text).toContain('cluster_name')
    expect(text).toContain('node_ids')
    expect(text).toContain('must be one of: circle, box, diamond, hexagon, star')
    expect(text).toContain("must be 'open' or 'closed'")
    expect(text).toContain('return clusters')
  })

  it('documents the context input variables', () => {
    const text = buildClusterProgramSkill(fullInput)
    expect(text).toContain('selectedNodeIds')
    expect(text).toContain('selectedEdgeIds')
    expect(text).toContain('relationship_type')
  })

  it('instructs the LLM to ask the user questions before writing code', () => {
    const text = buildClusterProgramSkill(fullInput)
    expect(text).toContain('Do NOT write code immediately')
    expect(text).toContain('ask me questions')
    expect(text).toContain('Start by asking me your first question')
    // No leftover fill-in placeholder for the user
    expect(text).not.toContain('<describe here>')
  })

  it('shows friendly placeholders when the graph is empty', () => {
    const text = buildClusterProgramSkill({
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

  it('is stable/deterministic for the same input', () => {
    expect(buildClusterProgramSkill(fullInput)).toBe(buildClusterProgramSkill(fullInput))
  })
})
