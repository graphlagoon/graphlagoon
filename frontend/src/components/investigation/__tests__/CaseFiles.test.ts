import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/vue'
import { createPinia, setActivePinia } from 'pinia'
import CaseFiles from '@/components/investigation/CaseFiles.vue'
import { useInvestigationStore } from '@/stores/investigation'

vi.mock('@/services/api', () => ({
  api: { getInvestigationFiles: vi.fn() },
}))

import { api } from '@/services/api'

const FILE = { id: 'f1', filename: '1_EXTRATO.TXT', role: 'graph', sha256: 'ab'.repeat(32), size_bytes: 2048, uploaded_by: 'me@x.com' }

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  useInvestigationStore().current = { id: 'c1' } as any
  vi.mocked(api.getInvestigationFiles).mockResolvedValue([FILE] as any)
})

describe('CaseFiles', () => {
  it('hides the upload without investigation.upload', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, permissions: [] }
    const { getByTestId, queryByTestId } = render(CaseFiles, { props: { investigationId: 'c1', canEdit: true }, global: { plugins: [pinia] } })
    await flush()
    expect(getByTestId('case-file-f1').textContent).toContain('sha256 abababababab')
    expect(queryByTestId('case-file-upload')).toBeNull()
  })

  it('opens the file assistant', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, permissions: ['investigation.upload'] }
    const { getByTestId, findByTestId } = render(CaseFiles, { props: { investigationId: 'c1', canEdit: true }, global: { plugins: [pinia] } })
    await flush()
    getByTestId('case-file-upload').click()
    expect(await findByTestId('file-import-wizard')).toBeTruthy()
  })
})
