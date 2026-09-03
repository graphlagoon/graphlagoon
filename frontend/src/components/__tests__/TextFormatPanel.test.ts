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

  // The rule editor lives in a modal teleported to <body> (house pattern), so
  // these query document.body; the afterEach sweep removes the overlay.
  function modalEl(sel: string) {
    return document.body.querySelector(`[data-testid="rule-editor-modal"] ${sel}`)
  }

  it('blocks saving an invalid rule template with an inline error (no alert)', async () => {
    const { container } = render(TextFormatPanel)
    const graphStore = useGraphStore()

    // Open the rule editor modal
    const addBtn = container.querySelector('.add-rule-btn') as HTMLButtonElement
    await fireEvent.click(addBtn)

    await fireEvent.update(modalEl('[data-testid="rule-name"]') as HTMLInputElement, 'Bad rule')
    await fireEvent.update(
      modalEl('[data-testid="rule-template"] input, input[data-testid="rule-template"]') as HTMLInputElement,
      '{prop:name|match:/(bad/}'
    )

    await fireEvent.click(modalEl('[data-testid="rule-save"]') as HTMLButtonElement)

    expect(modalEl('[data-testid="form-error"]')?.textContent).toContain('Template error')
    expect(graphStore.textFormatRules).toHaveLength(0)
    // The modal stays open so the user can fix the template.
    expect(document.body.querySelector('[data-testid="rule-editor-modal"]')).not.toBeNull()
  })

  it('saves a valid v2 rule template and closes the modal', async () => {
    const { container } = render(TextFormatPanel)
    const graphStore = useGraphStore()

    const addBtn = container.querySelector('.add-rule-btn') as HTMLButtonElement
    await fireEvent.click(addBtn)

    await fireEvent.update(modalEl('[data-testid="rule-name"]') as HTMLInputElement, 'Empresa rule')
    await fireEvent.update(
      modalEl('[data-testid="rule-template"] input, input[data-testid="rule-template"]') as HTMLInputElement,
      'Empresa {node_id|split:_:0}'
    )

    await fireEvent.click(modalEl('[data-testid="rule-save"]') as HTMLButtonElement)

    expect(graphStore.textFormatRules).toHaveLength(1)
    expect(graphStore.textFormatRules[0].template).toBe('Empresa {node_id|split:_:0}')
    // Unset surface defaults to 'label' explicitly.
    expect(graphStore.textFormatRules[0].surface).toBe('label')
    expect(document.body.querySelector('[data-testid="rule-editor-modal"]')).toBeNull()
  })

  it('saves a tooltip-surface rule and pre-fills it on edit', async () => {
    const { container } = render(TextFormatPanel)
    const graphStore = useGraphStore()

    await fireEvent.click(container.querySelector('.add-rule-btn') as HTMLButtonElement)
    await fireEvent.update(modalEl('[data-testid="rule-name"]') as HTMLInputElement, 'Tip rule')
    await fireEvent.update(modalEl('[data-testid="rule-surface"]') as HTMLSelectElement, 'tooltip')
    await fireEvent.update(
      modalEl('[data-testid="rule-template"] input, input[data-testid="rule-template"]') as HTMLInputElement,
      '{node_id|upper}'
    )
    await fireEvent.click(modalEl('[data-testid="rule-save"]') as HTMLButtonElement)

    expect(graphStore.textFormatRules[0].surface).toBe('tooltip')
    // The list shows a surface chip for non-label rules...
    expect(container.querySelector('.rule-surface')?.textContent).toBe('tooltip')

    // ...and reopening the rule pre-fills the surface select.
    await fireEvent.click(container.querySelector('.rule-action') as HTMLButtonElement)
    expect((modalEl('[data-testid="rule-surface"]') as HTMLSelectElement).value).toBe('tooltip')
  })
})

describe('TextFormatPanel — hover tooltip templates', () => {
  // The panel debounces store writes by 400 ms, so the fake clock has to be
  // installed before the input schedules its timer.
  it('writes the node tooltip template to the store after the debounce', async () => {
    vi.useFakeTimers()
    try {
      const { container } = render(TextFormatPanel)
      const graphStore = useGraphStore()

      const input = container.querySelector(
        '[data-testid="tooltip-template-node"]'
      ) as HTMLInputElement
      await fireEvent.update(input, '{prop:name}{br}{prop:email}')

      expect(graphStore.textFormatDefaults.nodeTooltipTemplate).toBe('')
      await vi.advanceTimersByTimeAsync(400)

      expect(graphStore.textFormatDefaults.nodeTooltipTemplate).toBe('{prop:name}{br}{prop:email}')
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes the edge tooltip template to the store', async () => {
    vi.useFakeTimers()
    try {
      const { container } = render(TextFormatPanel)
      const graphStore = useGraphStore()

      const input = container.querySelector(
        '[data-testid="tooltip-template-edge"]'
      ) as HTMLInputElement
      await fireEvent.update(input, '{src} -> {dst}')
      await vi.advanceTimersByTimeAsync(400)

      expect(graphStore.textFormatDefaults.edgeTooltipTemplate).toBe('{src} -> {dst}')
    } finally {
      vi.useRealTimers()
    }
  })

  it('syncs back from the store, so applying a preset updates the inputs', async () => {
    const { container } = render(TextFormatPanel)
    const graphStore = useGraphStore()

    graphStore.updateTextFormatDefaults({ nodeTooltipTemplate: '{node_type}' })
    await new Promise((r) => setTimeout(r, 0))

    const input = container.querySelector(
      '[data-testid="tooltip-template-node"]'
    ) as HTMLInputElement
    expect(input.value).toBe('{node_type}')
  })

  it('starts empty, so an unconfigured tooltip keeps showing the label', () => {
    const { container } = render(TextFormatPanel)

    const node = container.querySelector('[data-testid="tooltip-template-node"]') as HTMLInputElement
    const edge = container.querySelector('[data-testid="tooltip-template-edge"]') as HTMLInputElement
    expect(node.value).toBe('')
    expect(edge.value).toBe('')
  })
})
