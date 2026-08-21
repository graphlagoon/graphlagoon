import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import TextFormatPanel from '@/components/TextFormatPanel.vue'
import { useGraphStore } from '@/stores/graph'

Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  writable: true,
})

beforeEach(() => {
  setActivePinia(createPinia())
  const graphStore = useGraphStore()
  graphStore.nodes = [{ node_id: 'n1', node_type: 'Person' }]
  graphStore.edges = [{ edge_id: 'e1', src: 'n1', dst: 'n1', relationship_type: 'KNOWS' }]
})

afterEach(() => {
  document.body.querySelectorAll('.modal-overlay').forEach((el) => el.remove())
})

describe('TextFormatPanel — AI skill helper', () => {
  it('opens the label skill modal from the robot button', async () => {
    const { container } = render(TextFormatPanel)

    expect(document.body.querySelector('[data-testid="label-skill-modal"]')).toBeNull()

    const btn = container.querySelector('[data-testid="label-skill-help"]') as HTMLButtonElement
    expect(btn).not.toBeNull()

    await fireEvent.click(btn)

    const modal = document.body.querySelector('[data-testid="label-skill-modal"]')
    expect(modal).not.toBeNull()
    expect(document.body.querySelector('[data-testid="label-skill-text"]')?.textContent).toContain(
      'Person'
    )
  })
})
