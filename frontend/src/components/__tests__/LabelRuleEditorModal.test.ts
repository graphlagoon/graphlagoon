import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import LabelRuleEditorModal from '@/components/LabelRuleEditorModal.vue'
import { useGraphStore } from '@/stores/graph'
import type { TextFormatRule } from '@/types/graph'

// The modal teleports to <body>.
function el(sel: string) {
  return document.body.querySelector(`[data-testid="rule-editor-modal"] ${sel}`)
}

beforeEach(() => {
  setActivePinia(createPinia())
  const graphStore = useGraphStore()
  graphStore.nodes = [
    { node_id: 'n1', node_type: 'Person' },
    { node_id: 'n2', node_type: 'Company' },
  ]
  graphStore.edges = [{ edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'KNOWS' }]
})

afterEach(() => {
  document.body.querySelectorAll('.modal-overlay').forEach((n) => n.remove())
})

describe('LabelRuleEditorModal', () => {
  it('defaults surface to label for a new rule', () => {
    render(LabelRuleEditorModal, { props: { rule: null } })

    expect((el('[data-testid="rule-surface"]') as HTMLSelectElement).value).toBe('label')
  })

  it('disables Save until name and template are filled', async () => {
    render(LabelRuleEditorModal, { props: { rule: null } })

    const save = el('[data-testid="rule-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(true)

    await fireEvent.update(el('[data-testid="rule-name"]') as HTMLInputElement, 'R')
    expect(save.disabled).toBe(true)

    await fireEvent.update(el('[data-testid="rule-template"]') as HTMLTextAreaElement, '{node_id}')
    expect(save.disabled).toBe(false)
  })

  it('clears the selected types when the target flips', async () => {
    render(LabelRuleEditorModal, { props: { rule: null } })

    const personBox = [...document.body.querySelectorAll('.type-checkbox')].find((l) =>
      l.textContent?.includes('Person')
    )?.querySelector('input') as HTMLInputElement
    await fireEvent.click(personBox)
    expect(personBox.checked).toBe(true)

    await fireEvent.update(el('[data-testid="rule-target"]') as HTMLSelectElement, 'edge')

    // Types list now shows edge types, none selected.
    const checked = document.body.querySelectorAll('.type-checkbox input:checked')
    expect(checked.length).toBe(0)
  })

  it('defaults a new rule to winning over the existing ones (newest wins)', () => {
    const graphStore = useGraphStore()
    graphStore.addTextFormatRule({
      name: 'Old', target: 'node', types: [], template: '{node_id}',
      priority: 30, enabled: true, scope: 'exploration',
    })
    render(LabelRuleEditorModal, { props: { rule: null } })

    expect((el('[data-testid="rule-priority"]') as HTMLInputElement).value).toBe('40')
  })

  it('newest-wins priority is capped at 100 and scoped to the target', async () => {
    const graphStore = useGraphStore()
    graphStore.addTextFormatRule({
      name: 'Loud', target: 'node', types: [], template: '{node_id}',
      priority: 97, enabled: true, scope: 'exploration',
    })
    render(LabelRuleEditorModal, { props: { rule: null } })

    const priority = el('[data-testid="rule-priority"]') as HTMLInputElement
    expect(priority.value).toBe('100')

    // Edge rules are a separate pool: no edge rules -> back to the base 10.
    await fireEvent.update(el('[data-testid="rule-target"]') as HTMLSelectElement, 'edge')
    expect(priority.value).toBe('10')
  })

  it('pre-fills every field from an existing rule', () => {
    const rule: TextFormatRule = {
      id: 'r1',
      name: 'Tips',
      target: 'node',
      types: ['Person'],
      template: '{prop:name}',
      priority: 42,
      enabled: true,
      scope: 'exploration',
      surface: 'both',
    }
    render(LabelRuleEditorModal, { props: { rule } })

    expect((el('[data-testid="rule-name"]') as HTMLInputElement).value).toBe('Tips')
    expect((el('[data-testid="rule-surface"]') as HTMLSelectElement).value).toBe('both')
    expect((el('[data-testid="rule-priority"]') as HTMLInputElement).value).toBe('42')
    expect((el('[data-testid="rule-template"]') as HTMLTextAreaElement).value).toBe('{prop:name}')
  })
})
