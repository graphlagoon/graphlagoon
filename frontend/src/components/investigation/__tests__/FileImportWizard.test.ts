import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/vue'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import FileImportWizard from '@/components/investigation/FileImportWizard.vue'

vi.mock('@/services/api', () => ({
  api: { uploadInvestigationFile: vi.fn(), createFileContext: vi.fn(), setInvestigationFileMapping: vi.fn() },
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
  vi.mocked(api.uploadInvestigationFile).mockImplementation(async (_c, f, role) => ({ id: `id-${f.name}`, filename: f.name, role }) as any)
  vi.mocked(api.createFileContext).mockImplementation(async (_c, fid) => ({ file: { id: fid }, source: { id: 's9' } }) as any)
})

describe('FileImportWizard', () => {
  it('detects SIMBA, maps, shows quality and identity, then generates the graph', async () => {
    const { getByTestId, findByTestId, emitted } = render(FileImportWizard, { props: { investigationId: 'c1' } })
    await pick(getByTestId, files())
    await waitFor(() => expect((getByTestId('wizard-next') as HTMLButtonElement).disabled).toBe(false))
    await fireEvent.click(getByTestId('wizard-next')) // → role
    expect((getByTestId('wizard-role-graph') as HTMLInputElement).checked).toBe(true)
    await fireEvent.click(getByTestId('wizard-next')) // → map
    expect(getByTestId('wizard-detected')).toBeTruthy()
    const table = getByTestId('wizard-mapping-table').textContent!
    expect(table).toContain('Desconhecido node when NUMERO_AGENCIA_OD = 9999')
    expect(table).toContain('C = into conta')
    expect(getByTestId('wizard-quality').textContent).toContain('“Desconhecido” nodes')
    await fireEvent.click(getByTestId('wizard-next')) // → identity
    expect(getByTestId('wizard-identity').textContent).toMatch(/Conta[\s\S]*Pessoa/)
    await fireEvent.click(getByTestId('wizard-next')) // → review
    await fireEvent.click(getByTestId('wizard-submit'))
    await waitFor(() => expect(emitted().done).toBeTruthy())
    expect(api.uploadInvestigationFile).toHaveBeenCalledTimes(5)
    const [, fid, body] = vi.mocked(api.createFileContext).mock.calls[0]
    expect(fid).toBe('id-CASO1_EXTRATO.TXT')
    expect(body.mapping.name).toBe('SIMBA v3.1')
    expect(body.file_ids).toHaveLength(4)
    expect(await findByTestId('file-import-wizard')).toBeTruthy()
  })

  it('an invalid mapping blocks the next step', async () => {
    const { getByTestId } = render(FileImportWizard, { props: { investigationId: 'c1' } })
    await pick(getByTestId, files())
    await waitFor(() => expect((getByTestId('wizard-next') as HTMLButtonElement).disabled).toBe(false))
    await fireEvent.click(getByTestId('wizard-next'))
    await fireEvent.click(getByTestId('wizard-next'))
    await fireEvent.update(getByTestId('wizard-spec'), '{"version": 1, "inputs": {}, "nodes": [{"bogus": 1}]}')
    expect(getByTestId('wizard-mapping-error')).toBeTruthy()
    expect((getByTestId('wizard-next') as HTMLButtonElement).disabled).toBe(true)
  })
})
