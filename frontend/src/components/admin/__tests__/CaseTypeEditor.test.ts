import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import CaseTypeEditor from '@/components/admin/CaseTypeEditor.vue'
import type { CaseType } from '@/types/investigation'
import catalog from '@/__tests__/fixtures/authoring/catalog.json'

const LIBRARY = [{ slug: 'triage', title: 'Triage a case', kind: 'playbook', body: '', seeded: true }] as any

describe('CaseTypeEditor (06 §1)', () => {
  it('a new type: slug and ids from the labels, outcomes, actions and fields become the spec', async () => {
    const { getByTestId, emitted } = render(CaseTypeEditor, { props: { caseType: null, library: LIBRARY } })
    await fireEvent.update(getByTestId('ct-label'), 'Fraud ring')
    await fireEvent.update(getByTestId('ct-roles'), 'victim, mule , organizer')
    await fireEvent.click(getByTestId('ct-add-outcome'))
    await fireEvent.update(getByTestId('ct-outcome-label-0'), 'Report to the authorities')
    await fireEvent.click(getByTestId('ct-outcome-review-0'))
    await fireEvent.click(getByTestId('ct-add-outcome'))
    await fireEvent.update(getByTestId('ct-outcome-label-1'), 'Keep monitoring')
    await fireEvent.click(getByTestId('ct-outcome-closes-1')) // does not close
    await fireEvent.click(getByTestId('ct-add-action'))
    await fireEvent.update(getByTestId('ct-action-label-0'), 'Block the accounts')
    await fireEvent.click(getByTestId('ct-add-field'))
    await fireEvent.update(getByTestId('ct-field-label-0'), 'Amount at risk')
    await fireEvent.update(getByTestId('ct-field-type-0'), 'money')
    await fireEvent.click(getByTestId('ct-field-queue-0'))
    await fireEvent.update(getByTestId('ct-sla-open'), '240')
    await fireEvent.update(getByTestId('ct-notice'), 'Need-to-know.')
    await fireEvent.update(getByTestId('ct-playbook'), 'triage')
    await fireEvent.click(getByTestId('ct-save'))
    const [slug, spec] = emitted('save')![0] as [string, any]
    expect(slug).toBe('fraud_ring')
    expect(spec.vocabularies.roles).toEqual(['victim', 'mule', 'organizer'])
    expect(spec.outcomes).toEqual([
      { id: 'report_to_the_authorities', label: 'Report to the authorities', description: null, closes_case: true, requires_review: true },
      { id: 'keep_monitoring', label: 'Keep monitoring', description: null, closes_case: false, requires_review: false },
    ])
    expect(spec.actions).toEqual([{ id: 'block_the_accounts', label: 'Block the accounts', due_hours: null }])
    expect(spec.fields).toEqual([{ id: 'amount_at_risk', label: 'Amount at risk', type: 'money', options: [], required: false, in_queue: true }])
    expect(spec.sla_hours).toEqual({ open: 240, analysis: null })
    expect(spec.agent_suggest_kinds).toBeNull() // the default suggest kinds
    expect([spec.notice, spec.playbook]).toEqual(['Need-to-know.', 'triage'])
  })

  it('refuses a catalog where nothing closes the case', async () => {
    const { getByTestId, emitted } = render(CaseTypeEditor, { props: { caseType: null, library: [] } })
    await fireEvent.update(getByTestId('ct-label'), 'X')
    await fireEvent.click(getByTestId('ct-add-outcome'))
    await fireEvent.update(getByTestId('ct-outcome-label-0'), 'Monitor')
    await fireEvent.click(getByTestId('ct-outcome-closes-0'))
    await fireEvent.click(getByTestId('ct-save'))
    expect(getByTestId('ct-error').textContent).toContain('close the case')
    expect(emitted('save')).toBeUndefined()
  })

  it('an existing type keeps its slug and the parts edited elsewhere', async () => {
    const existing = {
      slug: 'credit_review', label: 'Credit review', builtin: false, vocabularies: { roles: ['borrower'], tags: [], link_attributes: [] },
      roles_multi: true, outcomes: [{ id: 'approve', label: 'Approve', closes_case: true, requires_review: false }], actions: [], stages: [],
      fields: [], sla_hours: { open: 72, analysis: 168 }, starter_queries: [{ title: 'Exposure', language: 'sql', query: 'SELECT 1' }], report_templates: ['memo'],
    } as unknown as CaseType
    const { getByTestId, emitted } = render(CaseTypeEditor, { props: { caseType: existing, library: [] } })
    await fireEvent.click(getByTestId('ct-save'))
    const [slug, spec] = emitted('save')![0] as [string, any]
    expect(slug).toBe('credit_review')
    expect(spec.roles_multi).toBe(true)
    expect(spec.starter_queries).toEqual([{ ...existing.starter_queries[0], parameters: [] }]) // the server's default
    expect(spec.report_templates).toEqual(['memo'])
    expect(spec.analysis_defaults).toEqual({ trace: { max_hops: null, max_dwell_hours: null, min_amount: null } })
  })

  it('edits what a new case starts with: starter queries, report templates and the trace defaults (06 P5)', async () => {
    const existing = {
      slug: 'merchant_review', label: 'Merchant review', builtin: false, vocabularies: { roles: [], tags: [], link_attributes: [] },
      roles_multi: false, outcomes: [], actions: [], stages: [], fields: [], sla_hours: {}, report_templates: [],
      starter_queries: [{ title: 'TPV by day', language: 'sql', query: 'SELECT day, tpv FROM d', parameters: [{ id: 'm', label: 'Merchant' }] }],
      analysis_defaults: { trace: { max_hops: 5, allocation: 'proportional' } },
    } as unknown as CaseType
    const library = [...LIBRARY, { slug: 'memo', title: 'Offboarding memo', kind: 'template', body: '', seeded: false }]
    const { getByTestId, emitted } = render(CaseTypeEditor, { props: { caseType: existing, library } })
    await fireEvent.click(getByTestId('ct-add-query'))
    const row = getByTestId('ct-query-1')
    await fireEvent.update(row.querySelector('input')!, 'Shared terminals')
    await fireEvent.update(row.querySelector('select')!, 'cypher')
    await fireEvent.update(row.querySelector('textarea')!, 'MATCH (t:Terminal) RETURN t')
    await fireEvent.click(getByTestId('ct-template-memo'))
    await fireEvent.update(getByTestId('ct-trace-hops'), '6')
    await fireEvent.click(getByTestId('ct-save'))
    const [, spec] = emitted('save')![0] as [string, any]
    expect(spec.starter_queries).toEqual([
      existing.starter_queries[0],
      { title: 'Shared terminals', language: 'cypher', query: 'MATCH (t:Terminal) RETURN t', parameters: [] },
    ])
    expect(spec.report_templates).toEqual(['memo'])
    expect(spec.analysis_defaults.trace).toEqual({ max_hops: 6, allocation: 'proportional', max_dwell_hours: null, min_amount: null })
  })

  it('help on each section, and Ask an AI builds the prompt from the catalog and the org', async () => {
    const { getByTestId, queryByTestId } = render(CaseTypeEditor, {
      props: { caseType: null, library: LIBRARY, authoring: catalog as any, caseTypes: [{ slug: 'fraud_ring', label: 'Fraud ring' }] },
    })
    expect(queryByTestId('help-ct-outcomes-text')).toBeNull()
    await fireEvent.click(getByTestId('help-ct-outcomes'))
    expect(getByTestId('help-ct-outcomes-text').textContent).toContain('Four eyes')
    await fireEvent.click(getByTestId('help-ct-agent'))
    expect(getByTestId('help-ct-agent-text').textContent).toContain('task') // the default suggest kinds, from the server
    await fireEvent.click(getByTestId('ct-ask-ai'))
    const text = document.body.querySelector('[data-testid="ct-skill-text"]')!.textContent!
    expect(text).toContain('write a "case type"')
    expect(text).toContain('`fraud_ring` — Fraud ring')
    expect(text).toContain('`triage` — Triage a case')
  })

  it('Import JSON fills the form from an AI answer (fenced), keeps what the form has no input for, then saves', async () => {
    const answer = {
      slug: 'merchant_review', label: 'Merchant review',
      vocabularies: { roles: ['suspect merchant'], tags: [], link_attributes: ['phone'] },
      outcomes: [{ id: 'offboard', label: 'Offboard', closes_case: true, requires_review: true }],
      actions: [{ id: 'hold', label: 'Hold settlements', due_hours: 2 }],
      fields: [{ id: 'mcc', label: 'MCC', type: 'enum', options: ['5411', '5999'], in_queue: true }],
      starter_queries: [{ title: 'By day', language: 'sql', query: 'SELECT 1 WHERE m = :m', parameters: [{ id: 'm', label: 'Merchant' }] }],
      analysis_defaults: { trace: { max_hops: 4, allocation: 'proportional', stop_types: ['Exchange'] } },
    }
    const { getByTestId, emitted } = render(CaseTypeEditor, { props: { caseType: null, library: LIBRARY, authoring: catalog as any } })
    await fireEvent.click(getByTestId('ct-import-json'))
    await fireEvent.update(getByTestId('ct-import-text'), '{"label": "x", "colour": "red"}')
    await fireEvent.click(getByTestId('ct-import-apply'))
    expect(getByTestId('ct-import-error').textContent).toContain('Unknown keys: colour')
    await fireEvent.update(getByTestId('ct-import-text'), '```json\n' + JSON.stringify(answer) + '\n```')
    await fireEvent.click(getByTestId('ct-import-apply'))
    expect((getByTestId('ct-label') as HTMLInputElement).value).toBe('Merchant review')
    expect((getByTestId('ct-slug') as HTMLInputElement).value).toBe('merchant_review')
    expect((getByTestId('ct-outcome-review-0') as HTMLInputElement).checked).toBe(true)
    await fireEvent.click(getByTestId('ct-save'))
    const [slug, spec] = emitted('save')![0] as [string, any]
    expect(slug).toBe('merchant_review')
    expect(spec.fields[0]).toEqual({ id: 'mcc', label: 'MCC', type: 'enum', options: ['5411', '5999'], required: false, in_queue: true })
    expect(spec.starter_queries[0].parameters).toEqual([{ id: 'm', label: 'Merchant' }])
    expect(spec.analysis_defaults.trace).toEqual({ max_hops: 4, allocation: 'proportional', stop_types: ['Exchange'], max_dwell_hours: null, min_amount: null })
  })
})
