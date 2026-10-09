import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import CaseFiles from '@/components/investigation/CaseFiles.vue'

vi.mock('@/services/api', () => ({
  api: { getInvestigationFiles: vi.fn(), uploadInvestigationFile: vi.fn() },
}))

import { api } from '@/services/api'

const FILE = { id: 'f1', filename: '1_EXTRATO.TXT', role: 'graph', sha256: 'ab'.repeat(32), size_bytes: 2048, uploaded_by: 'me@x.com' }

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.mocked(api.getInvestigationFiles).mockResolvedValue([FILE] as any)
  vi.mocked(api.uploadInvestigationFile).mockResolvedValue({ ...FILE, id: 'f2', filename: 'qsa.csv', role: 'enrichment' } as any)
})

describe('CaseFiles', () => {
  it('hides the upload without investigation.upload', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, permissions: [] }
    const { getByTestId, queryByTestId } = render(CaseFiles, { props: { investigationId: 'c1', canEdit: true } })
    await flush()
    expect(getByTestId('case-file-f1').textContent).toContain('sha256 abababababab')
    expect(queryByTestId('case-file-upload')).toBeNull()
  })

  it('uploads with the chosen role', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, permissions: ['investigation.upload'] }
    const { getByTestId, findByTestId } = render(CaseFiles, { props: { investigationId: 'c1', canEdit: true } })
    await flush()
    await fireEvent.update(getByTestId('case-file-role'), 'enrichment')
    const file = new File(['cnpj;socio'], 'qsa.csv')
    const input = getByTestId('case-file-input') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [file] })
    await fireEvent.change(input)
    expect(api.uploadInvestigationFile).toHaveBeenCalledWith('c1', file, 'enrichment')
    expect((await findByTestId('case-file-f2')).textContent).toContain('enrichment')
  })
})
