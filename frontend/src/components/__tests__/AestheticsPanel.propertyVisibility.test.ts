import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import AestheticsPanel from '@/components/AestheticsPanel.vue'
import { useGraphStore } from '@/stores/graph'

// Stub heavy children; the MultiSelect stub exposes its options so the
// computed union is observable without PrimeVue's overlay machinery.
const stubs = {
  StylePresetModal: true,
  IconPicker: true,
  MultiSelect: {
    props: ['modelValue', 'options'],
    template:
      '<div class="multiselect-stub" :data-options="JSON.stringify(options)" />',
  },
}

function seedGraph(opts: { edgeProps?: boolean; schemaEdgeProps?: boolean } = {}) {
  const graphStore = useGraphStore()
  graphStore.currentContext = {
    id: 'ctx-1',
    title: 'Ctx',
    node_properties: [{ name: 'name', data_type: 'string', display_name: 'Name' }],
    edge_properties: opts.schemaEdgeProps
      ? [{ name: 'since', data_type: 'date' }]
      : [],
  } as any
  graphStore.nodes = [
    { node_id: 'n1', node_type: 'Person', properties: { name: 'Alice', age: 30 } },
    { node_id: 'n2', node_type: 'Person', properties: null }, // progressive load pending
  ] as any
  graphStore.edges = [
    {
      edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'KNOWS',
      properties: opts.edgeProps ? { weight: 0.7 } : null,
    },
  ] as any
  return graphStore
}

function optionValues(el: Element | null): string[] {
  if (!el) return []
  return JSON.parse(el.getAttribute('data-options') || '[]').map(
    (o: { value: string }) => o.value,
  )
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('AestheticsPanel — property visibility', () => {
  it('unions context schema and observed keys for the node options', async () => {
    const graphStore = seedGraph()
    graphStore.setPropertyVisibility('node', ['name'])

    const { container } = render(AestheticsPanel, { global: { stubs } })

    const select = container.querySelector('[data-testid="property-visibility-node"]')
    expect(optionValues(select)).toEqual(['age', 'name'])
  })

  it('lists edge options from edge properties on the loaded graph', async () => {
    const graphStore = seedGraph({ edgeProps: true })
    graphStore.setPropertyVisibility('edge', ['weight'])

    const { container } = render(AestheticsPanel, { global: { stubs } })

    const select = container.querySelector('[data-testid="property-visibility-edge"]')
    expect(optionValues(select)).toEqual(['weight'])
  })

  it('lists edge options from the context schema when edges carry none', async () => {
    const graphStore = seedGraph({ edgeProps: false, schemaEdgeProps: true })
    graphStore.setPropertyVisibility('edge', [])

    const { container } = render(AestheticsPanel, { global: { stubs } })

    const select = container.querySelector('[data-testid="property-visibility-edge"]')
    expect(optionValues(select)).toEqual(['since'])
  })

  it('disables the edge toggle and says why when there is nothing to pick', () => {
    seedGraph({ edgeProps: false, schemaEdgeProps: false })

    const { container } = render(AestheticsPanel, { global: { stubs } })

    const toggle = container.querySelector(
      '[data-testid="property-visibility-edge-toggle"]',
    ) as HTMLInputElement
    expect(toggle.disabled).toBe(true)
    expect(container.textContent).toContain('No edge properties in this graph')
  })

  it('checking the box seeds the allowlist with every current option', async () => {
    const graphStore = seedGraph({ edgeProps: true })

    const { container } = render(AestheticsPanel, { global: { stubs } })

    const toggle = container.querySelector(
      '[data-testid="property-visibility-edge-toggle"]',
    ) as HTMLInputElement
    expect(toggle.disabled).toBe(false)
    await fireEvent.click(toggle)

    expect(graphStore.propertyVisibility.edgeProperties).toEqual(['weight'])
  })

  it('unchecking the box returns to show-all (null, not [])', async () => {
    const graphStore = seedGraph({ edgeProps: true })
    graphStore.setPropertyVisibility('edge', ['weight'])

    const { container } = render(AestheticsPanel, { global: { stubs } })
    await fireEvent.click(
      container.querySelector('[data-testid="property-visibility-edge-toggle"]')!,
    )

    expect(graphStore.propertyVisibility.edgeProperties).toBeNull()
  })
})

describe('AestheticsPanel — details display', () => {
  it('reflects the saved hide-empty-values setting', () => {
    const graphStore = seedGraph()
    graphStore.updateAesthetics({ hideEmptyValues: false })

    const { container } = render(AestheticsPanel, { global: { stubs } })

    const box = container.querySelector<HTMLInputElement>(
      '[data-testid="hide-empty-values-toggle"]',
    )
    expect(box).not.toBeNull()
    expect(box!.checked).toBe(false)
  })

  it('defaults to on', () => {
    seedGraph()
    const { container } = render(AestheticsPanel, { global: { stubs } })

    expect(
      container.querySelector<HTMLInputElement>(
        '[data-testid="hide-empty-values-toggle"]',
      )!.checked,
    ).toBe(true)
  })

  it('writes the toggle back to the store', async () => {
    const graphStore = seedGraph()
    const { container } = render(AestheticsPanel, { global: { stubs } })

    await fireEvent.click(
      container.querySelector('[data-testid="hide-empty-values-toggle"]')!,
    )

    expect(graphStore.aesthetics.hideEmptyValues).toBe(false)
  })
})
