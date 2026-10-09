import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import ArtifactsSpace from '@/components/investigation/ArtifactsSpace.vue'

vi.mock('@/services/api', () => ({
  api: {
    getInvestigationArtifacts: vi.fn(),
    getArtifactContent: vi.fn(),
    uploadInvestigationArtifact: vi.fn(),
    approveArtifactVersion: vi.fn(),
  },
}))

import { api } from '@/services/api'

const version = (n: number, status: 'draft' | 'approved', actor: any = { kind: 'agent', email: 'me@x.com', agent_name: 'Claude' }) => ({
  version: n, sha256: 'abcd1234ef', size_bytes: 4, content_type: 'text/markdown', status, actor, source_evidence_ids: [],
})
const summary = {
  id: 'a1', name: 'Resumo.md', kind: 'doc', current_version: 1, download_only: false, versions: [version(1, 'draft')],
}
const page = {
  id: 'a2', name: 'grafo.html', kind: 'report', current_version: 1, download_only: true,
  versions: [version(1, 'approved', { kind: 'human', email: 'me@x.com' })],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getInvestigationArtifacts).mockResolvedValue([summary, page] as any)
  vi.mocked(api.getArtifactContent).mockResolvedValue(new Blob(['# <b>Resumo</b>']))
})

describe('ArtifactsSpace', () => {
  it('previews markdown as text, never html, and keeps html download-only', async () => {
    const { getByTestId, container } = render(ArtifactsSpace, { props: { investigationId: 'inv', canEdit: true } })
    await flushPromises()
    expect(getByTestId('artifact-preview').textContent).toContain('# <b>Resumo</b>')
    expect(container.querySelector('.preview b')).toBeNull()
    expect(container.querySelector('.filters')!.textContent).toContain('Documents (1)')

    await fireEvent.click(getByTestId('artifact-a2'))
    await flushPromises()
    expect(getByTestId('artifact-preview').textContent).toContain('Download only')
    expect(api.getArtifactContent).toHaveBeenCalledTimes(1) // never fetched for preview
  })

  it('uploads a new version and approves it', async () => {
    vi.mocked(api.uploadInvestigationArtifact).mockResolvedValue({
      ...summary, current_version: 2, versions: [version(2, 'draft'), version(1, 'draft')],
    } as any)
    vi.mocked(api.approveArtifactVersion).mockResolvedValue({
      ...summary, current_version: 2, versions: [version(2, 'approved'), version(1, 'draft')],
    } as any)
    const { getByTestId, emitted } = render(ArtifactsSpace, { props: { investigationId: 'inv', canEdit: true } })
    await flushPromises()

    await fireEvent.click(getByTestId('artifact-new-version'))
    const file = new File(['# v2'], 'Resumo.md')
    const input = getByTestId('artifact-file-input') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await fireEvent.change(input)
    await flushPromises()
    expect(api.uploadInvestigationArtifact).toHaveBeenCalledWith('inv', file, 'a1')
    expect(getByTestId('artifact-version-2')).toBeTruthy()

    await fireEvent.click(getByTestId('artifact-approve'))
    await flushPromises()
    expect(api.approveArtifactVersion).toHaveBeenCalledWith('inv', 'a1', 2)
    expect(getByTestId('artifact-version-2').textContent).toContain('approved')
    expect(emitted().changed).toBeTruthy()
  })

  it('hides upload and approval without write access', async () => {
    const { queryByTestId } = render(ArtifactsSpace, { props: { investigationId: 'inv', canEdit: false } })
    await flushPromises()
    expect(queryByTestId('artifact-upload')).toBeNull()
    expect(queryByTestId('artifact-approve')).toBeNull()
  })
})
