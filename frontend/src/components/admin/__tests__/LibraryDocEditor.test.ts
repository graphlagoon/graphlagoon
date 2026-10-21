import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import LibraryDocEditor from '@/components/admin/LibraryDocEditor.vue'
import catalog from '@/__tests__/fixtures/authoring/catalog.json'

const TYPES = [
  { slug: 'general', label: 'General', fields: [] },
  { slug: 'merchant_review', label: 'Merchant review', fields: [{ id: 'merchant_id', label: 'Merchant', type: 'text' }] },
] as any
const draft = (kind: string, body = '', isNew = true) => ({ slug: 'memo', title: 'Memo', kind, body, isNew }) as any

describe('LibraryDocEditor (06)', () => {
  it('a report template: placeholders and the chosen type fields insert at the cursor', async () => {
    const { getByTestId, emitted } = render(LibraryDocEditor, { props: { draft: draft('template', 'Dear X,\n'), authoring: catalog as any, caseTypes: TYPES } })
    const body = getByTestId('library-body') as HTMLTextAreaElement
    body.setSelectionRange(5, 6) // "X"
    await fireEvent.click(getByTestId('library-placeholder-case.owner'))
    expect(body.value).toBe('Dear {{case.owner}},\n')
    await fireEvent.update(getByTestId('library-template-type'), 'merchant_review')
    body.setSelectionRange(body.value.length, body.value.length)
    await fireEvent.click(getByTestId('library-placeholder-fields.merchant_id'))
    expect(body.value).toBe('Dear {{case.owner}},\n{{fields.merchant_id}}')
    await fireEvent.click(getByTestId('admin-library-save'))
    expect((emitted('save')![0] as any[])[0]).toMatchObject({ kind: 'template', body: 'Dear {{case.owner}},\n{{fields.merchant_id}}' })
  })

  it('a playbook lists the agent tools; Start from the example; Ask an AI improves what is there', async () => {
    const { getByTestId } = render(LibraryDocEditor, { props: { draft: draft('playbook'), authoring: catalog as any } })
    expect(getByTestId('library-tool-propose_decision').getAttribute('title')).toContain('Propose the decision')
    await fireEvent.click(getByTestId('library-example'))
    expect((getByTestId('library-body') as HTMLTextAreaElement).value).toContain('`propose_decision`')
    await fireEvent.click(getByTestId('library-ask-ai'))
    expect(document.body.querySelector('[data-testid="library-skill-text"]')!.textContent).toContain('# Task: write a playbook') // the untouched example is not "current"
    await fireEvent.update(getByTestId('library-body'), 'Case {investigation_id}: my steps')
    expect(document.body.querySelector('[data-testid="library-skill-text"]')!.textContent).toContain('# Task: improve a playbook')
  })

  it('a file mapping: operators from the server; invalid JSON blocks Save', async () => {
    const { getByTestId, queryByTestId } = render(LibraryDocEditor, { props: { draft: draft('mapping', '{"as": "graph"'), authoring: catalog as any } })
    expect(getByTestId('library-reference').textContent).toContain('terminal_id')
    expect(getByTestId('library-mapping-error').textContent).toContain('Not valid JSON')
    expect((getByTestId('admin-library-save') as HTMLButtonElement).disabled).toBe(true)
    await fireEvent.click(getByTestId('library-example'))
    expect(queryByTestId('library-mapping-error')).toBeNull()
    expect((getByTestId('admin-library-save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('the kind help explains the three kinds', async () => {
    const { getByTestId } = render(LibraryDocEditor, { props: { draft: draft('playbook'), authoring: catalog as any } })
    await fireEvent.click(getByTestId('help-library-kind'))
    const text = getByTestId('help-library-kind-text').textContent!
    expect(text).toContain('Report template')
    expect(text).toContain('{{placeholders}}')
  })
})
