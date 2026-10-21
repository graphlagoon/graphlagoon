import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/vue'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import FileImportWizard from '@/components/investigation/FileImportWizard.vue'

vi.mock('@/services/api', () => ({
  api: { uploadInvestigationItem: vi.fn(), updateInvestigationItem: vi.fn(), getOrgLibrary: vi.fn(async () => []), putAdminLibraryDoc: vi.fn(async () => ({})) },
}))

import { api } from '@/services/api'

const DIR = join(__dirname, '../../../__tests__/fixtures/fileMapping/bank-statements')
const SPEC = readFileSync(join(DIR, 'spec.json'), 'utf-8')
const files = () => readdirSync(DIR).filter((f) => f.endsWith('.TXT')).map((f) => new File([readFileSync(join(DIR, f))], f))

async function pick(getByTestId: (id: string) => HTMLElement, list: File[]) {
  const input = getByTestId('wizard-files') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: list, configurable: true })
  await fireEvent.change(input)
}

beforeEach(() => {
  vi.mocked(api.uploadInvestigationItem).mockImplementation(async (_c: string, f: File, p: any) => ({ id: `id-${f.name}`, title: f.name, provenance: { filename: f.name }, ...p }) as any)
  vi.mocked(api.updateInvestigationItem).mockImplementation(async (_c: string, id: string, patch: any) => ({ id, ...patch }) as any)
})

describe('FileImportWizard (2 steps)', () => {
  it("the org's saved mapping is detected; a superuser saves the current one for the org (06 P5)", async () => {
    vi.mocked(api.getOrgLibrary).mockResolvedValueOnce([
      { slug: 'simba', title: 'Bank statements (SIMBA)', kind: 'mapping', body: JSON.stringify({ as: 'graph', spec: JSON.parse(SPEC) }), seeded: false },
    ] as any)
    window.__GRAPH_LAGOON_CONFIG__ = { is_superuser: true } as any
    const { getByTestId } = render(FileImportWizard, { props: { investigationId: 'c1' } })
    await waitFor(() => expect(api.getOrgLibrary).toHaveBeenCalledWith('mapping'))
    await pick(getByTestId, files())
    await waitFor(() => expect(getByTestId('wizard-detected-hint')).toBeTruthy())
    await fireEvent.click(getByTestId('wizard-next'))
    expect(JSON.parse((getByTestId('wizard-spec') as HTMLTextAreaElement).value).name).toBe('Bank statements (TAB, Latin-1)')
    await fireEvent.update(getByTestId('wizard-save-slug'), 'Bank Statements v2')
    await waitFor(() => expect((getByTestId('wizard-save-org-btn') as HTMLButtonElement).disabled).toBe(false))
    await fireEvent.click(getByTestId('wizard-save-org-btn'))
    await waitFor(() => expect(getByTestId('wizard-saved').textContent).toContain('bank-statements-v2'))
    const [slug, doc] = vi.mocked(api.putAdminLibraryDoc).mock.calls[0]
    expect(slug).toBe('bank-statements-v2')
    expect(doc).toMatchObject({ kind: 'mapping', title: 'Bank statements (TAB, Latin-1)' })
    expect(JSON.parse(doc.body)).toMatchObject({ as: 'graph', spec: { name: 'Bank statements (TAB, Latin-1)' } })
    window.__GRAPH_LAGOON_CONFIG__ = {} as any
  })

  it('a multi-file layout: step 1 picks graph; step 2 maps (advanced JSON), shows quality and identity, then maps the main table onto the canvas', async () => {
    const { getByTestId, findByTestId, emitted, queryByTestId } = render(FileImportWizard, { props: { investigationId: 'c1' } })
    await pick(getByTestId, files())
    await waitFor(() => expect((getByTestId('wizard-next') as HTMLButtonElement).disabled).toBe(false))
    expect(queryByTestId('wizard-detected-hint')).toBeNull() // no saved mapping matches: a generic start
    expect((getByTestId('wizard-role-graph') as HTMLInputElement).checked).toBe(true)
    await fireEvent.click(getByTestId('wizard-next')) // → mapping
    await fireEvent.update(getByTestId('wizard-spec'), SPEC)
    const table = getByTestId('wizard-mapping-table').textContent!
    expect(table).toContain('Unknown node when CP_BRANCH = 9999')
    expect(table).toContain('C = into account')
    expect(getByTestId('wizard-quality').textContent).toContain('“Unknown” nodes')
    expect(getByTestId('wizard-identity').textContent).toMatch(/Account[\s\S]*Person/)
    await waitFor(() => expect((getByTestId('wizard-submit') as HTMLButtonElement).disabled).toBe(false))
    await fireEvent.click(getByTestId('wizard-submit'))
    await waitFor(() => expect(emitted().done).toBeTruthy())
    expect(api.uploadInvestigationItem).toHaveBeenCalledTimes(5)
    expect(vi.mocked(api.uploadInvestigationItem).mock.calls[0][2]).toEqual({ kind: 'table', subkind: 'csv' })
    const [, fid, body] = vi.mocked(api.updateInvestigationItem).mock.calls[0]
    expect(fid).toBe('id-CASE1_STATEMENT.TXT')
    expect(body.mapping).toMatchObject({ as: 'graph', spec: { name: 'Bank statements (TAB, Latin-1)' } })
    expect((body.mapping as any).extra_item_ids).toHaveLength(4)
    expect(await findByTestId('file-import-wizard')).toBeTruthy()
  })

  it('an invalid mapping (advanced JSON) blocks "Add to case"', async () => {
    const { getByTestId } = render(FileImportWizard, { props: { investigationId: 'c1' } })
    await pick(getByTestId, files())
    await waitFor(() => expect((getByTestId('wizard-next') as HTMLButtonElement).disabled).toBe(false))
    await fireEvent.click(getByTestId('wizard-next'))
    await fireEvent.update(getByTestId('wizard-spec'), '{"version": 1, "inputs": {}, "nodes": [{"bogus": 1}]}')
    expect(getByTestId('wizard-mapping-error')).toBeTruthy()
    await waitFor(() => expect((getByTestId('wizard-submit') as HTMLButtonElement).disabled).toBe(true))
  })

  it('a document skips the mapping', async () => {
    const { getByTestId, queryByTestId } = render(FileImportWizard, { props: { investigationId: 'c1', initialRole: 'attachment' } })
    await pick(getByTestId, files().slice(0, 1))
    await waitFor(() => expect((getByTestId('wizard-next') as HTMLButtonElement).disabled).toBe(false))
    await fireEvent.click(getByTestId('wizard-next'))
    expect(queryByTestId('mapping-step')).toBeNull()
    expect((getByTestId('wizard-submit') as HTMLButtonElement).disabled).toBe(false)
  })
})
