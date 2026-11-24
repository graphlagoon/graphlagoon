import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import TextFormatPanel from '@/components/TextFormatPanel.vue'
import { useGraphStore } from '@/stores/graph'
import { useToast } from '@/composables/useToast'

const el = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

const IMPORT = {
  defaults: { nodeTemplate: '{prop:name|truncate:20:...}' },
  rules: [
    { name: 'Person', target: 'node', types: ['Person'], template: '{prop:name|upper}', priority: 20 },
    { name: 'Company', target: 'node', types: ['Company'], template: '{prop:name}{br}{node_type}' },
    { name: 'Knows', target: 'edge', types: ['KNOWS'], template: 'knows' },
  ],
}

async function paste(json: unknown) {
  if (!el('label-import-text')) await fireEvent.click(el('label-import-toggle')!)
  await fireEvent.update(el('label-import-text')!, typeof json === 'string' ? json : JSON.stringify(json))
  await nextTick()
}

beforeEach(() => {
  setActivePinia(createPinia())
  const graphStore = useGraphStore()
  graphStore.currentContext = {
    id: 'c1',
    title: 'Fraud ring',
    node_types: ['Person', 'Company'],
    relationship_types: ['KNOWS'],
    node_properties: [{ name: 'name', data_type: 'string' }],
    edge_properties: [],
  } as any
  useToast().toasts.value.splice(0)
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  document.body.querySelectorAll('.modal-overlay').forEach((node) => node.remove())
})

describe('Labels panel — import / export JSON', () => {
  it('applies the labels of several types in one import, and Undo puts the old ones back', async () => {
    const graphStore = useGraphStore()
    render(TextFormatPanel)
    await paste(IMPORT)

    expect(el('label-import-summary')!.textContent).toContain('3 rules for 3 types and 1 default template')
    expect(el('label-import-warnings')).toBeNull()
    await fireEvent.click(el('label-import-apply')!)

    expect(graphStore.textFormatRules.map((r) => r.name)).toEqual(['Person', 'Company', 'Knows'])
    expect(graphStore.textFormatDefaults.nodeTemplate).toBe('{prop:name|truncate:20:...}')
    // A default the import did not name is untouched.
    expect(graphStore.textFormatDefaults.edgeTemplate).toBe('{relationship_type}')
    expect(el('label-import-text')).toBeNull()

    const toast = useToast().toasts.value.at(-1)!
    expect(toast.message).toBe('Labels imported: 3 rules added, defaults updated')
    toast.action!.onClick()
    expect(graphStore.textFormatRules).toEqual([])
    expect(graphStore.textFormatDefaults.nodeTemplate).toBe('{node_id|truncate:10:...}')
  })

  it('merges by name, or replaces the current rules when asked', async () => {
    const graphStore = useGraphStore()
    graphStore.addTextFormatRule({
      name: 'Person', target: 'node', types: ['Person'], template: '{node_id}', priority: 5, enabled: true, scope: 'exploration',
    })
    graphStore.addTextFormatRule({
      name: 'Mine', target: 'node', types: [], template: '{node_type}', priority: 1, enabled: true, scope: 'exploration',
    })
    render(TextFormatPanel)

    await paste(IMPORT)
    await fireEvent.click(el('label-import-apply')!)
    expect(graphStore.textFormatRules.map((r) => r.name)).toEqual(['Person', 'Mine', 'Company', 'Knows'])
    expect(graphStore.textFormatRules[0].template).toBe('{prop:name|upper}')
    expect(useToast().toasts.value.at(-1)!.message).toBe('Labels imported: 2 rules added, 1 rule updated, defaults updated')

    await paste({ rules: [IMPORT.rules[2]] })
    graphStore.updateTextFormatRule(graphStore.textFormatRules[1].id, { surface: 'tooltip' })
    await nextTick()
    // The count says what is on the tab the user is not looking at.
    expect(el('label-import-replace')!.parentElement!.textContent).toContain('4 current rules (3 label, 1 tooltip)')
    await fireEvent.click(el('label-import-replace')!)
    expect(el('label-import-summary')!.textContent).toContain('replacing the 4 current rules')
    await fireEvent.click(el('label-import-apply')!)
    expect(graphStore.textFormatRules.map((r) => r.name)).toEqual(['Knows'])
    expect(useToast().toasts.value.at(-1)!.message).toBe('Labels imported: 1 rule added, 4 rules removed')
    await nextTick()
    expect(document.activeElement).toBe(el('label-import-toggle'))
  })

  it('names the bad rule and applies nothing', async () => {
    const graphStore = useGraphStore()
    render(TextFormatPanel)
    await paste({ rules: [IMPORT.rules[0], { name: 'Broken', target: 'node', template: '{prop:name' }] })

    expect(el('label-import-parse-error')!.textContent).toContain('Rule 2 ("Broken"): Unbalanced braces')
    expect((el('label-import-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(graphStore.textFormatRules).toEqual([])
  })

  it('warns about names this graph lacks and opens the AI prompt in adapt mode', async () => {
    render(TextFormatPanel)
    await paste({
      graphlagoon_export: 'label-formats',
      source: { context_title: 'Old', node_types: ['Customer'], relationship_types: [], node_properties: ['cname'], edge_properties: [] },
      textFormat: { rules: [{ name: 'Customer', target: 'node', types: ['Customer'], template: '{prop:cname}' }] },
    })

    const warnings = el('label-import-warnings')!
    expect(warnings.textContent).toContain('node types: Customer')
    expect(warnings.textContent).toContain('properties: cname')
    // A warning never blocks applying.
    expect((el('label-import-apply') as HTMLButtonElement).disabled).toBe(false)

    await fireEvent.click(el('label-import-adapt')!)
    const prompt = el('label-skill-text')!.textContent!
    expect(prompt).toContain('adapt "label templates"')
    expect(prompt).toContain('"Old"')
    expect(prompt).toContain('- Company')
  })

  it('the robot button keeps the plain write prompt even with JSON pasted', async () => {
    render(TextFormatPanel)
    await paste(IMPORT)
    await fireEvent.click(el('label-skill-help')!)
    expect(el('label-skill-text')!.textContent).toContain('# Task: write "label templates"')
  })

  it('exports defaults and rules in the portable envelope, and that file imports back', async () => {
    const graphStore = useGraphStore()
    graphStore.addTextFormatRule({
      name: 'Person', target: 'node', types: ['Person'], template: '{prop:name}', priority: 5, enabled: true, scope: 'exploration', surface: 'both',
    })
    render(TextFormatPanel)
    await fireEvent.click(el('label-export')!)

    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as unknown as Blob
    const text = await blob.text()
    const payload = JSON.parse(text)
    expect(payload.graphlagoon_export).toBe('label-formats')
    expect(payload.source.node_types).toEqual(['Company', 'Person'])
    expect(payload.textFormat.rules[0].name).toBe('Person')
    expect(payload.textFormat.defaults.edgeTemplate).toBe('{relationship_type}')

    graphStore.loadTextFormatState(undefined)
    await paste(text)
    await fireEvent.click(el('label-import-apply')!)
    expect(graphStore.textFormatRules).toHaveLength(1)
    expect(graphStore.textFormatRules[0]).toMatchObject({ name: 'Person', surface: 'both', priority: 5 })
  })

  it('takes only the labels out of a pasted style preset', async () => {
    const graphStore = useGraphStore()
    render(TextFormatPanel)
    await paste({
      graphlagoon_export: 'style-preset',
      settings: { nodeTypeColors: { Person: '#123456' }, textFormat: { rules: [IMPORT.rules[0]] } },
    })
    await fireEvent.click(el('label-import-apply')!)
    expect(graphStore.textFormatRules.map((r) => r.name)).toEqual(['Person'])
    expect(graphStore.nodeTypeColors.get('Person')).not.toBe('#123456')
  })
})
