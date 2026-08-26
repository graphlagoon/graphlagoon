import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import PropertyVisibilityHint from '@/components/PropertyVisibilityHint.vue'
import { useGraphStore } from '@/stores/graph'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('PropertyVisibilityHint', () => {
  it('renders nothing when no allowlist is active', () => {
    const { container } = render(PropertyVisibilityHint, {
      props: { kind: 'node', visible: 5, total: 5 },
    })
    expect(container.querySelector('[data-testid="property-visibility-hint"]')).toBeNull()
  })

  it('renders nothing when the allowlist hides nothing on this surface', () => {
    // e.g. the allowlist names every key this surface has (plus stale ones)
    useGraphStore().setPropertyVisibility('node', ['a', 'b', 'ghost'])
    const { container } = render(PropertyVisibilityHint, {
      props: { kind: 'node', visible: 2, total: 2 },
    })
    expect(container.querySelector('[data-testid="property-visibility-hint"]')).toBeNull()
  })

  it('shows the counts when a subset is active', () => {
    useGraphStore().setPropertyVisibility('node', ['a'])
    const { container } = render(PropertyVisibilityHint, {
      props: { kind: 'node', visible: 1, total: 4 },
    })
    expect(container.textContent).toContain('Showing 1 of 4 properties')
  })

  it('only reacts to its own kind', () => {
    useGraphStore().setPropertyVisibility('edge', ['a'])
    const { container } = render(PropertyVisibilityHint, {
      props: { kind: 'node', visible: 1, total: 4 },
    })
    expect(container.querySelector('[data-testid="property-visibility-hint"]')).toBeNull()
  })

  it('Show all clears the allowlist for its kind only', async () => {
    const store = useGraphStore()
    store.setPropertyVisibility('node', ['a'])
    store.setPropertyVisibility('edge', ['x'])

    const { container } = render(PropertyVisibilityHint, {
      props: { kind: 'node', visible: 1, total: 4 },
    })
    await fireEvent.click(container.querySelector('.show-all-btn')!)

    expect(store.propertyVisibility.nodeProperties).toBeNull()
    expect(store.propertyVisibility.edgeProperties).toEqual(['x'])
  })
})
