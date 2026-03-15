import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import PropertyFilterPanel from '@/components/PropertyFilterPanel.vue'
import { useGraphStore } from '@/stores/graph'
import { useMetricsStore } from '@/stores/metrics'
import type { ComputedMetric } from '@/types/metrics'

function setupStores() {
  const graphStore = useGraphStore()
  const metricsStore = useMetricsStore()

  graphStore.nodes = [
    { node_id: 'n1', node_type: 'Person' },
    { node_id: 'n2', node_type: 'Company' },
  ]
  graphStore.edges = [
    { edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'WORKS_AT' },
  ]

  // Add a node metric for the property options
  metricsStore.computedMetrics.set('degree', {
    id: 'degree',
    name: 'Degree Centrality',
    algorithmId: 'degree',
    target: 'node',
    values: new Map([['n1', 2], ['n2', 1]]),
    min: 1,
    max: 2,
    mean: 1.5,
    stdDev: 0.5,
    computedAt: Date.now(),
    params: {},
    edgeTypeFilter: [],
    elapsedMs: 10,
  } as ComputedMetric)

  return { graphStore, metricsStore }
}

function renderPanel() {
  return render(PropertyFilterPanel)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('PropertyFilterPanel', () => {
  it('renders with Nodes tab active by default', () => {
    setupStores()
    const { getByText } = renderPanel()
    expect(getByText('Nodes')).toBeDefined()
    expect(getByText('Edges')).toBeDefined()
    expect(getByText('No filters applied')).toBeDefined()
  })

  it('shows metric in property dropdown', () => {
    setupStores()
    const { container } = renderPanel()

    const select = container.querySelector('select') as HTMLSelectElement
    const options = Array.from(select.querySelectorAll('option'))
    const optionTexts = options.map(o => o.textContent?.trim())

    expect(optionTexts).toContain('Degree Centrality')
  })

  it('add filter button is disabled when no property selected', () => {
    setupStores()
    const { container } = renderPanel()

    const addBtn = container.querySelector('button.btn-primary') as HTMLButtonElement
    expect(addBtn).not.toBeNull()
    expect(addBtn.disabled).toBe(true)
  })

  it('can add a filter via the form', async () => {
    const { graphStore } = setupStores()
    const { container } = renderPanel()

    // Select property
    const selects = container.querySelectorAll('select')
    const propertySelect = selects[0] as HTMLSelectElement
    await fireEvent.update(propertySelect, 'metric:degree')

    // Select operator
    const operatorSelect = selects[1] as HTMLSelectElement
    await fireEvent.update(operatorSelect, 'greater_than')

    // Enter value
    const valueInput = container.querySelector('input[placeholder="Enter value..."]') as HTMLInputElement
    await fireEvent.update(valueInput, '1')

    // Click the submit button (not the h4 heading)
    const addBtn = container.querySelector('button.btn-primary') as HTMLButtonElement
    await fireEvent.click(addBtn)

    expect(graphStore.filters.nodePropertyFilters).toHaveLength(1)
    expect(graphStore.filters.nodePropertyFilters[0].property).toBe('metric:degree')
    expect(graphStore.filters.nodePropertyFilters[0].operator).toBe('greater_than')
  })

  it('displays active filters', async () => {
    const { graphStore } = setupStores()
    graphStore.addNodePropertyFilter({
      property: 'metric:degree',
      operator: 'greater_than',
      value: 5,
      enabled: true,
    })

    const { container } = renderPanel()
    const filterItem = container.querySelector('.filter-item')
    expect(filterItem).not.toBeNull()
    expect(filterItem!.textContent).toContain('Degree Centrality')
    expect(filterItem!.textContent).toContain('Greater Than')
  })

  it('toggle filter checkbox toggles enabled state', async () => {
    const { graphStore } = setupStores()
    graphStore.addNodePropertyFilter({
      property: 'metric:degree',
      operator: 'greater_than',
      value: 5,
      enabled: true,
    })

    const { container } = renderPanel()
    const filterCheckbox = container.querySelector('.filter-item input[type="checkbox"]') as HTMLInputElement
    expect(filterCheckbox.checked).toBe(true)

    await fireEvent.click(filterCheckbox)
    expect(graphStore.filters.nodePropertyFilters[0].enabled).toBe(false)
  })

  it('remove button removes filter', async () => {
    const { graphStore } = setupStores()
    graphStore.addNodePropertyFilter({
      property: 'metric:degree',
      operator: 'equals',
      value: 1,
      enabled: true,
    })

    const { container } = renderPanel()
    const removeBtn = container.querySelector('.remove-btn') as HTMLElement
    await fireEvent.click(removeBtn)

    expect(graphStore.filters.nodePropertyFilters).toHaveLength(0)
  })

  it('switching to Edges tab shows edge filters', async () => {
    setupStores()
    const { getByText } = renderPanel()

    await fireEvent.click(getByText('Edges'))
    expect(getByText('No filters applied')).toBeDefined()
  })

  it('Clear All removes all filters', async () => {
    const { graphStore } = setupStores()
    graphStore.addNodePropertyFilter({
      property: 'metric:degree',
      operator: 'equals',
      value: 1,
      enabled: true,
    })
    graphStore.addNodePropertyFilter({
      property: 'metric:degree',
      operator: 'greater_than',
      value: 2,
      enabled: true,
    })

    const { getByText } = renderPanel()
    await fireEvent.click(getByText('Clear All'))

    expect(graphStore.filters.nodePropertyFilters).toHaveLength(0)
  })

  it('close button emits close event', async () => {
    setupStores()
    const { container, emitted } = renderPanel()

    const closeBtn = container.querySelector('.close-btn') as HTMLElement
    await fireEvent.click(closeBtn)

    expect(emitted().close).toBeTruthy()
  })

  it('badge shows filter count', async () => {
    const { graphStore } = setupStores()
    graphStore.addNodePropertyFilter({
      property: 'metric:degree',
      operator: 'equals',
      value: 1,
      enabled: true,
    })

    const { container } = renderPanel()
    const badge = container.querySelector('.badge')
    expect(badge?.textContent?.trim()).toBe('1')
  })
})
