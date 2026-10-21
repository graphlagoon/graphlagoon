import { describe, it, expect } from 'vitest'
import { buildCaseTypeSkill } from '@/utils/caseTypeSkill'
import { buildLibrarySkill } from '@/utils/librarySkill'
import catalog from '@/__tests__/fixtures/authoring/catalog.json'
import type { OrgAuthoring } from '@/types/admin'

// The live catalog of the server (kept equal by api/tests/test_type_data.py).
const AUTHORING = catalog as unknown as OrgAuthoring
const BASE = {
  authoring: AUTHORING,
  existingTypes: [{ slug: 'fraud_ring', label: 'Fraud ring' }],
  playbooks: [{ slug: 'triage', title: 'Triage a case' }],
  templates: [{ slug: 'offboarding-memo', title: 'Offboarding memo' }],
}

describe('buildCaseTypeSkill', () => {
  it('interviews first, explains every part and embeds the server schema and the org', () => {
    const skill = buildCaseTypeSkill(BASE)
    expect(skill).toContain('# Task: write a "case type"')
    expect(skill).toContain('**Do NOT write JSON immediately.**')
    for (const part of ['`outcomes`', '`actions`', '`fields`', '`sla_hours`', '`starter_queries`', '`analysis_defaults.trace`', '`agent_suggest_kinds`']) {
      expect(skill).toContain(part)
    }
    expect(skill).toContain(JSON.stringify(AUTHORING.case_type_schema))
    expect(skill).toContain('`fraud_ring` — Fraud ring')
    expect(skill).toContain('`triage` — Triage a case')
    expect(skill).toContain('`offboarding-memo` — Offboarding memo')
    expect(skill).toContain('"label": "Merchant review"') // the example (validated by the backend tests)
    expect(skill).toContain('`task`') // default suggest kinds come from the server
  })

  it('improves the given type, keeping its ids', () => {
    const skill = buildCaseTypeSkill({ ...BASE, current: { label: 'Credit review', outcomes: [{ id: 'approve' }] } })
    expect(skill).toContain('# Task: improve a "case type"')
    expect(skill).toContain('"label": "Credit review"')
    expect(skill).toContain('Keep the ids of outcomes, actions and fields')
    expect(skill).not.toContain('Do NOT write JSON immediately')
  })
})

describe('buildLibrarySkill', () => {
  it('a report template lists every placeholder of the server and the chosen type fields', () => {
    const skill = buildLibrarySkill({
      kind: 'template',
      authoring: AUTHORING,
      caseType: { slug: 'merchant_review', label: 'Merchant review', fields: [{ id: 'merchant_id', label: 'Merchant', type: 'text' }] },
    })
    for (const p of AUTHORING.report_placeholders) expect(skill).toContain(`\`{{${p.key}}}\``)
    expect(skill).toContain('`{{fields.merchant_id}}` — Merchant (text)')
    expect(skill).toContain('{{decision.rationale}}') // the example
    expect(skill).toContain('output ONLY the template')
  })

  it('a playbook lists the agent tools with their summaries and the standing rules', () => {
    const skill = buildLibrarySkill({ kind: 'playbook', authoring: AUTHORING })
    expect(skill).toContain('`propose_decision` — ')
    expect(skill).toContain('`find_entity_cases`')
    expect(skill).toContain('{investigation_id}')
    expect(skill).toContain('**the agent never decides, shares, deletes,')
  })

  it('a file mapping documents the operators of the server, widths and the enrichment schema; improves a given body', () => {
    const skill = buildLibrarySkill({ kind: 'mapping', authoring: AUTHORING, current: '{"as": "graph", "spec": {}}' })
    for (const op of [...AUTHORING.mapping.normalizers, ...AUTHORING.mapping.when_ops]) expect(skill).toContain(`\`${op}\``)
    expect(skill).toContain('`widths`')
    expect(skill).toContain(JSON.stringify(AUTHORING.mapping.enrichment_schema))
    expect(skill).toContain('# Task: improve a file mapping')
    expect(skill).toContain('the first 5–10 lines of each file')
  })
})

describe('suggest kinds', () => {
  it('the client lists are the server catalog', async () => {
    const { SUGGEST_KINDS, DEFAULT_SUGGEST_KINDS } = await import('@/utils/caseVocabulary')
    expect([...SUGGEST_KINDS].sort()).toEqual([...AUTHORING.suggest_kinds.all].sort())
    expect([...DEFAULT_SUGGEST_KINDS].sort()).toEqual([...AUTHORING.suggest_kinds.default].sort())
  })
})
