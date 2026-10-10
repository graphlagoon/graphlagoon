import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/vue'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import FileImportWizard from '@/components/investigation/FileImportWizard.vue'

vi.mock('@/services/api', () => ({
  api: { uploadInvestigationItem: vi.fn(), updateInvestigationItem: vi.fn() },
}))

import { api } from '@/services/api'

const DIR = join(__dirname, '../../../__tests__/fixtures/fileMapping/simba-mini')
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
  it('step 1 detects SIMBA and picks graph; step 2 maps, shows quality and identity, then maps the main table onto the canvas', async () => {
    const { getByTestId, findByTestId, emitted } = render(FileImportWizard, { props: { investigationId: 'c1' } })
    await pick(getByTestId, files())
    await waitFor(() => expect((getByTestId('wizard-next') as HTMLButtonElement).disabled).toBe(false))
    expect(getByTestId('wizard-detected-hint')).toBeTruthy()
    expect((getByTestId('wizard-role-graph') as HTMLInputElement).checked).toBe(true)
    await fireEvent.click(getByTestId('wizard-next')) // → mapping
    expect(getByTestId('wizard-detected')).toBeTruthy()
    const table = getByTestId('wizard-mapping-table').textContent!
    expect(table).toContain('Desconhecido node when NUMERO_AGENCIA_OD = 9999')
    expect(table).toContain('C = into conta')
    expect(getByTestId('wizard-quality').textContent).toContain('“Desconhecido” nodes')
    expect(getByTestId('wizard-identity').textContent).toMatch(/Conta[\s\S]*Pessoa/)
    await waitFor(() => expect((getByTestId('wizard-submit') as HTMLButtonElement).disabled).toBe(false))
    await fireEvent.click(getByTestId('wizard-submit'))
    await waitFor(() => expect(emitted().done).toBeTruthy())
    expect(api.uploadInvestigationItem).toHaveBeenCalledTimes(5)
    expect(vi.mocked(api.uploadInvestigationItem).mock.calls[0][2]).toEqual({ kind: 'table', subkind: 'csv' })
    const [, fid, body] = vi.mocked(api.updateInvestigationItem).mock.calls[0]
    expect(fid).toBe('id-CASO1_EXTRATO.TXT')
    expect(body.mapping).toMatchObject({ as: 'graph', spec: { name: 'SIMBA v3.1' } })
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
