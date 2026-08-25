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

describe('TextFormatPanel — inline validation and preview', () => {
  it('renders inline previews under the default template inputs', async () => {
    const { container } = render(TextFormatPanel)
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(400)
    vi.useRealTimers()
    // node + edge default previews (defaults are non-empty)
    expect(container.querySelectorAll('[data-testid="template-preview"]').length).toBeGreaterThanOrEqual(2)
  })

  it('blocks saving an invalid rule template with an inline error (no alert)', async () => {
    const { container, getByText } = render(TextFormatPanel)
    const graphStore = useGraphStore()

    // Open the rule form
    const addBtn = container.querySelector('.add-rule-btn') as HTMLButtonElement
    await fireEvent.click(addBtn)

    const nameInput = container.querySelector('.rule-form input[type="text"]') as HTMLInputElement
    await fireEvent.update(nameInput, 'Bad rule')
    const templateInput = container.querySelector('.rule-form .template-input') as HTMLInputElement
    await fireEvent.update(templateInput, '{prop:name|match:/(bad/}')

    await fireEvent.click(getByText('Save'))

    expect(container.querySelector('[data-testid="form-error"]')?.textContent).toContain('Template error')
    expect(graphStore.textFormatRules).toHaveLength(0)
  })

  it('saves a valid v2 rule template', async () => {
    const { container, getByText } = render(TextFormatPanel)
    const graphStore = useGraphStore()

    const addBtn = container.querySelector('.add-rule-btn') as HTMLButtonElement
    await fireEvent.click(addBtn)

    const nameInput = container.querySelector('.rule-form input[type="text"]') as HTMLInputElement
    await fireEvent.update(nameInput, 'Empresa rule')
    const templateInput = container.querySelector('.rule-form .template-input') as HTMLInputElement
    await fireEvent.update(templateInput, 'Empresa {node_id|split:_:0}')

    await fireEvent.click(getByText('Save'))

    expect(container.querySelector('[data-testid="form-error"]')).toBeNull()
    expect(graphStore.textFormatRules).toHaveLength(1)
    expect(graphStore.textFormatRules[0].template).toBe('Empresa {node_id|split:_:0}')
  })
})
