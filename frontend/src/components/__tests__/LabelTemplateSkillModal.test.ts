import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import LabelTemplateSkillModal from '@/components/LabelTemplateSkillModal.vue'
import { useGraphStore } from '@/stores/graph'

const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
Object.defineProperty(navigator, 'clipboard', {
  value: mockClipboard,
  writable: true,
})

function seedGraph() {
  const graphStore = useGraphStore()
  graphStore.nodes = [
    { node_id: 'n1', node_type: 'Person' },
    { node_id: 'n2', node_type: 'Company' },
  ]
  graphStore.edges = [{ edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'WORKS_AT' }]
  return graphStore
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

afterEach(() => {
  document.body.querySelectorAll('.modal-overlay').forEach((el) => el.remove())
})

describe('LabelTemplateSkillModal', () => {
  it('is not visible when modelValue is false', () => {
    seedGraph()
    render(LabelTemplateSkillModal, { props: { modelValue: false } })
    expect(document.body.querySelector('[data-testid="label-skill-modal"]')).toBeNull()
  })

  it('renders the skill text with the graph metadata when open', () => {
    seedGraph()
    render(LabelTemplateSkillModal, { props: { modelValue: true } })
    const text = document.body.querySelector('[data-testid="label-skill-text"]')
    expect(text).not.toBeNull()
    expect(text?.textContent).toContain('Person')
    expect(text?.textContent).toContain('Company')
    expect(text?.textContent).toContain('WORKS_AT')
    expect(text?.textContent).toContain('{prop:')
  })

  it('copies the skill text to the clipboard on Copy click', async () => {
    seedGraph()
    render(LabelTemplateSkillModal, { props: { modelValue: true } })
    const copyBtn = document.body.querySelector('[data-testid="label-skill-copy"]') as HTMLButtonElement
    await fireEvent.click(copyBtn)
    expect(mockClipboard.writeText).toHaveBeenCalledTimes(1)
    const copied = mockClipboard.writeText.mock.calls[0][0] as string
    expect(copied).toContain('label templates')
    expect(copied).toContain('Person')
  })

  it('emits update:modelValue false when closed', async () => {
    seedGraph()
    const { emitted } = render(LabelTemplateSkillModal, { props: { modelValue: true } })
    const closeBtn = document.body.querySelector('.close-btn') as HTMLButtonElement
    await fireEvent.click(closeBtn)
    expect(emitted()['update:modelValue']).toBeTruthy()
    expect(emitted()['update:modelValue'][0]).toEqual([false])
  })
})
