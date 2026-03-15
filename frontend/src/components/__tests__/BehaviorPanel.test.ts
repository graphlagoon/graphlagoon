import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import BehaviorPanel from '@/components/BehaviorPanel.vue'
import { useGraphStore } from '@/stores/graph'

function renderPanel() {
  return render(BehaviorPanel)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('BehaviorPanel', () => {
  it('renders visible sections and advanced toggle', () => {
    const { getByText, queryByText } = renderPanel()

    expect(getByText('Graph Lens')).toBeDefined()
    expect(getByText('Degree Dimming')).toBeDefined()
    expect(getByText('Advanced')).toBeDefined()
    // Advanced sections hidden by default
    expect(queryByText('Search Behavior')).toBeNull()
    expect(queryByText('3D Rendering')).toBeNull()
    expect(queryByText('Pointer Tools')).toBeNull()
  })

  it('advanced toggle reveals hidden sections', async () => {
    const { getByText } = renderPanel()

    await fireEvent.click(getByText('Advanced'))

    expect(getByText('Search Behavior')).toBeDefined()
    expect(getByText('3D Rendering')).toBeDefined()
    expect(getByText('Pointer Tools')).toBeDefined()
    expect(getByText('Clipping Plane (Alt+scroll)')).toBeDefined()
  })

  it('selecting dim mode updates store', async () => {
    const store = useGraphStore()
    const { container } = renderPanel()

    const dimRadio = container.querySelectorAll('input[name="edgeLensMode"]')[2] as HTMLInputElement
    await fireEvent.click(dimRadio)

    expect(store.behaviors.edgeLensMode).toBe('dim')
  })

  it('focus depth selector appears when graph lens is enabled', async () => {
    const store = useGraphStore()
    store.updateBehaviors({ edgeLensMode: 'hide' })

    const { container } = renderPanel()
    const depthSelect = container.querySelector('.sub-options select') as HTMLSelectElement

    expect(depthSelect).not.toBeNull()
  })

  it('focus depth selector hidden when graph lens is off', () => {
    const store = useGraphStore()
    store.updateBehaviors({ edgeLensMode: 'off' })
    const { container } = renderPanel()
    // Edge lens is off, graph lens section (first visible section) should not have depth select
    const edgeLensSubOptions = container.querySelectorAll('.behavior-section')[0]?.querySelector('.sub-options select')
    expect(edgeLensSubOptions).toBeNull()
  })

  it('toggling hide labels on camera move updates store (advanced)', async () => {
    const store = useGraphStore()
    const { getByText, getByLabelText } = renderPanel()

    await fireEvent.click(getByText('Advanced'))
    const checkbox = getByLabelText('Hide labels on camera move')
    await fireEvent.click(checkbox)

    // Default is false, so toggling makes it true
    expect(store.behaviors.hideLabelsOnCameraMove).toBe(true)
  })

  it('reset button restores default behaviors', async () => {
    const store = useGraphStore()
    store.updateBehaviors({
      edgeLensMode: 'dim',
      focusDepth: 3,
      searchMode: 'hide',
      degreeDimEnabled: false,
    })

    const { getByText } = renderPanel()
    await fireEvent.click(getByText('Reset'))

    expect(store.behaviors.edgeLensMode).toBe('dim')
    expect(store.behaviors.focusDepth).toBe(1)
    expect(store.behaviors.searchMode).toBe('highlight')
    expect(store.behaviors.degreeDimEnabled).toBe(true)
  })

  it('close button emits close event', async () => {
    const { container, emitted } = renderPanel()

    const closeBtn = container.querySelector('.close-btn') as HTMLElement
    await fireEvent.click(closeBtn)

    expect(emitted().close).toBeTruthy()
  })

  it('shows hint when no selection and graph lens enabled', () => {
    const store = useGraphStore()
    store.updateBehaviors({ edgeLensMode: 'dim' })

    const { getByText } = renderPanel()
    expect(getByText('Select or hover a node to see the effect')).toBeDefined()
  })
})
