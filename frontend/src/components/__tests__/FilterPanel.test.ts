import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import FilterPanel from '@/components/FilterPanel.vue'
import { useGraphStore } from '@/stores/graph'

function setupStore() {
  const store = useGraphStore()
  store.nodes = [
    { node_id: 'n1', node_type: 'Person' },
    { node_id: 'n2', node_type: 'Person' },
    { node_id: 'n3', node_type: 'Company' },
    { node_id: 'n4', node_type: 'Location' },
  ]
  store.edges = [
    { edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'KNOWS' },
    { edge_id: 'e2', src: 'n1', dst: 'n3', relationship_type: 'WORKS_AT' },
  ]
  return store
}

function renderFilterPanel() {
  return render(FilterPanel, {
    global: {
      plugins: [],
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('FilterPanel', () => {
  it('renders node type checkboxes', () => {
    setupStore()
    const { getByText } = renderFilterPanel()

    expect(getByText('Person')).toBeDefined()
    expect(getByText('Company')).toBeDefined()
    expect(getByText('Location')).toBeDefined()
  })

  it('renders edge type checkboxes', () => {
    setupStore()
    const { getByText } = renderFilterPanel()

    expect(getByText('KNOWS')).toBeDefined()
    expect(getByText('WORKS_AT')).toBeDefined()
  })

  it('all checkboxes start checked', () => {
    setupStore()
    const { container } = renderFilterPanel()

    const checkboxes = container.querySelectorAll('input[type="checkbox"]')
    checkboxes.forEach((cb) => {
      expect((cb as HTMLInputElement).checked).toBe(true)
    })
  })

  it('unchecking a node type applies filter to store', async () => {
    const store = setupStore()
    const { container } = renderFilterPanel()

    // nodeTypes are sorted: ['Company', 'Location', 'Person']
    // So first checkbox is Company
    const checkboxes = container.querySelectorAll('input[type="checkbox"]')
    const companyCheckbox = checkboxes[0] as HTMLInputElement

    await fireEvent.click(companyCheckbox)

    // After unchecking Company, store should have Location and Person as visible
    expect(store.filters.node_types).toContain('Location')
    expect(store.filters.node_types).toContain('Person')
    expect(store.filters.node_types).not.toContain('Company')
  })

  it('search input updates store filter', async () => {
    vi.useFakeTimers()
    const store = setupStore()
    const { container } = renderFilterPanel()

    const searchInput = container.querySelector('input.form-control') as HTMLInputElement
    await fireEvent.update(searchInput, 'test query')

    // Search is debounced (300ms)
    vi.advanceTimersByTime(300)
    expect(store.filters.search_query).toBe('test query')
    vi.useRealTimers()
  })

  it('reset button clears all filters', async () => {
    const store = setupStore()
    const { getByText, container } = renderFilterPanel()

    // First apply some filters
    const checkboxes = container.querySelectorAll('input[type="checkbox"]')
    await fireEvent.click(checkboxes[0])
    const searchInput = container.querySelector('input.form-control') as HTMLInputElement
    await fireEvent.update(searchInput, 'search text')

    // Now reset
    const resetBtn = getByText('Reset')
    await fireEvent.click(resetBtn)

    expect(store.filters.node_types).toEqual([])
    expect(store.filters.edge_types).toEqual([])
    expect(store.filters.search_query).toBeUndefined()
  })

  it('close button emits close event', async () => {
    setupStore()
    const { emitted } = renderFilterPanel()

    const closeBtn = document.querySelector('button[aria-label="Close"]') as HTMLElement
    await fireEvent.click(closeBtn)

    expect(emitted().close).toBeTruthy()
  })
})
