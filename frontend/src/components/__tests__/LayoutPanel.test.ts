import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import LayoutPanel from '@/components/LayoutPanel.vue'
import { useGraphStore } from '@/stores/graph'

function renderPanel() {
  return render(LayoutPanel, { props: { isLayoutRunning: false } })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('LayoutPanel — layout mode selector', () => {
  it('renders all layout options with force active by default', () => {
    const { getByTestId } = renderPanel()

    expect(getByTestId('layout-option-force').classList.contains('active')).toBe(true)
    expect(getByTestId('layout-option-ego').classList.contains('active')).toBe(false)
    expect(getByTestId('layout-option-hive').classList.contains('active')).toBe(false)
  })

  it('renders exactly the implemented layout modes (no stubs)', () => {
    const { getByTestId, queryByTestId } = renderPanel()

    for (const mode of ['force', 'ego', 'hive', 'hierarchical']) {
      expect((getByTestId(`layout-option-${mode}`) as HTMLButtonElement).disabled).toBe(false)
    }
    expect(queryByTestId('layout-option-circular')).toBeNull()
    expect(queryByTestId('layout-option-grid')).toBeNull()
  })

  it('clicking an option updates the store', async () => {
    const store = useGraphStore()
    const { getByTestId } = renderPanel()

    await fireEvent.click(getByTestId('layout-option-ego'))

    expect(store.layoutAlgorithm).toBe('ego')
    expect(getByTestId('layout-option-ego').classList.contains('active')).toBe(true)
  })
})

describe('LayoutPanel — ego mode block', () => {
  it('shows ego controls and the no-focus hint only in ego mode', async () => {
    const { getByTestId, queryByTestId } = renderPanel()

    expect(queryByTestId('ego-direction-select')).toBeNull()

    await fireEvent.click(getByTestId('layout-option-ego'))

    expect(getByTestId('ego-direction-select')).toBeDefined()
    expect(getByTestId('ego-no-focus-hint')).toBeDefined()
  })

  it('"Use selected node" is disabled without a selection and sets the focus with one', async () => {
    const store = useGraphStore()
    store.nodes = [{ node_id: 'acct-1', node_type: 'Account' }] as typeof store.nodes
    const { getByTestId } = renderPanel()
    await fireEvent.click(getByTestId('layout-option-ego'))

    const btn = getByTestId('ego-use-selected-btn') as HTMLButtonElement
    expect(btn.disabled).toBe(true)

    store.selectNode('acct-1')
    await nextTick()
    await fireEvent.click(btn)

    expect(store.layoutModeConfig.ego.focusNodeId).toBe('acct-1')
  })

  it('direction select writes to the store config', async () => {
    const store = useGraphStore()
    const { getByTestId } = renderPanel()
    await fireEvent.click(getByTestId('layout-option-ego'))

    await fireEvent.update(getByTestId('ego-direction-select'), 'out')

    expect(store.layoutModeConfig.ego.direction).toBe('out')
  })

  it('max hops slider maps 0 to null (no limit)', async () => {
    const store = useGraphStore()
    const { getByTestId } = renderPanel()
    await fireEvent.click(getByTestId('layout-option-ego'))

    await fireEvent.update(getByTestId('ego-max-hops'), '2')
    expect(store.layoutModeConfig.ego.maxHops).toBe(2)

    await fireEvent.update(getByTestId('ego-max-hops'), '0')
    expect(store.layoutModeConfig.ego.maxHops).toBeNull()
  })

  it('hides all simulation controls in ego mode (static analytic layout)', async () => {
    const { getByTestId, getByText, queryByText } = renderPanel()

    expect(getByText('Gravity')).toBeDefined()
    expect(getByText('Run')).toBeDefined()
    await fireEvent.click(getByTestId('layout-option-ego'))
    expect(queryByText('Gravity')).toBeNull()
    expect(queryByText('Run')).toBeNull()
    expect(queryByText('Repulsion')).toBeNull()
  })
})

describe('LayoutPanel — hierarchical mode block', () => {
  it('shows hierarchical controls only in hierarchical mode', async () => {
    const { getByTestId, queryByTestId, queryByText } = renderPanel()

    expect(queryByTestId('hierarchical-direction-select')).toBeNull()

    await fireEvent.click(getByTestId('layout-option-hierarchical'))

    expect(getByTestId('hierarchical-direction-select')).toBeDefined()
    expect(getByTestId('hierarchical-traversal-select')).toBeDefined()
    // Static layout — no simulation controls
    expect(queryByText('Run')).toBeNull()
    expect(queryByText('Repulsion')).toBeNull()
  })

  it('direction and traversal selects write to the store config', async () => {
    const store = useGraphStore()
    const { getByTestId } = renderPanel()
    await fireEvent.click(getByTestId('layout-option-hierarchical'))

    await fireEvent.update(getByTestId('hierarchical-direction-select'), 'lr')
    await fireEvent.update(getByTestId('hierarchical-traversal-select'), 'in')

    expect(store.layoutModeConfig.hierarchical.direction).toBe('lr')
    expect(store.layoutModeConfig.hierarchical.traversal).toBe('in')
  })
})

describe('LayoutPanel — hive mode block', () => {
  it('shows hive controls and hides simulation controls', async () => {
    const { getByTestId, queryByText } = renderPanel()

    await fireEvent.click(getByTestId('layout-option-hive'))

    expect(getByTestId('hive-axis-select')).toBeDefined()
    expect(getByTestId('hive-position-select')).toBeDefined()
    expect(getByTestId('hive-scale-select')).toBeDefined()
    // No simulation in a fixed-position layout
    expect(queryByText('Run')).toBeNull()
    expect(queryByText('Reheat')).toBeNull()
    expect(queryByText('Repulsion')).toBeNull()
    expect(queryByText('Advanced')).toBeNull()
  })

  it('populates property selects from the context property columns', async () => {
    const store = useGraphStore()
    store.currentContext = {
      id: 'ctx',
      node_properties: [
        { name: 'risk_score', data_type: 'double' },
        { name: 'bank', data_type: 'string' },
      ],
    } as typeof store.currentContext
    const { getByTestId } = renderPanel()
    await fireEvent.click(getByTestId('layout-option-hive'))

    const axisOptions = [...(getByTestId('hive-axis-select') as HTMLSelectElement).options].map(o => o.value)
    const posOptions = [...(getByTestId('hive-position-select') as HTMLSelectElement).options].map(o => o.value)

    expect(axisOptions).toEqual(['node_type', 'community', 'prop:bank'])
    expect(posOptions).toEqual(['degree', 'prop:risk_score'])
  })

  it('community axis shows a hint when no communities are detected yet', async () => {
    const store = useGraphStore()
    const { getByTestId, queryByTestId } = renderPanel()
    await fireEvent.click(getByTestId('layout-option-hive'))

    expect(queryByTestId('hive-no-communities-hint')).toBeNull()

    store.updateLayoutModeConfig({ hive: { axisKey: 'community' } })
    await nextTick()

    expect(getByTestId('hive-no-communities-hint')).toBeDefined()
  })

  it('scale select writes to the store config', async () => {
    const store = useGraphStore()
    const { getByTestId } = renderPanel()
    await fireEvent.click(getByTestId('layout-option-hive'))

    await fireEvent.update(getByTestId('hive-scale-select'), 'log')

    expect(store.layoutModeConfig.hive.scale).toBe('log')
  })

  it('warns when categories exceed maxAxes', async () => {
    const store = useGraphStore()
    store.nodes = Array.from({ length: 8 }, (_, i) => ({
      node_id: `n${i}`,
      node_type: `Type${i}`,
    })) as typeof store.nodes
    store.updateLayoutModeConfig({ hive: { maxAxes: 3 } })
    const { getByTestId } = renderPanel()

    await fireEvent.click(getByTestId('layout-option-hive'))

    expect(getByTestId('hive-others-hint').textContent).toContain('5 categories')
  })
})

describe('LayoutPanel — edge type layout gating', () => {
  it('shows the edge-type layout section only in force mode', async () => {
    const { getByTestId, getByText, queryByText } = renderPanel()

    expect(getByText('Layout by Edge Type')).toBeDefined()

    await fireEvent.click(getByTestId('layout-option-ego'))
    expect(queryByText('Layout by Edge Type')).toBeNull()
  })
})

describe('LayoutPanel — ego ring ordering and edge arcs', () => {
  async function renderEgoPanel() {
    const store = useGraphStore()
    store.setLayoutAlgorithm('ego')
    const utils = renderPanel()
    await nextTick()
    // Ring geometry / edge drawing live behind the Advanced disclosure
    const openAdvanced = async () => {
      await fireEvent.click(utils.getByTestId('ego-advanced-toggle'))
      await nextTick()
    }
    return { store, openAdvanced, ...utils }
  }

  it('defaults to crossing reduction with same-ring arcs on', async () => {
    const { getByTestId, openAdvanced } = await renderEgoPanel()

    expect((getByTestId('ego-ring-ordering') as HTMLSelectElement).value).toBe('barycenter')

    await openAdvanced()
    expect((getByTestId('ego-arc-intra-ring') as HTMLInputElement).checked).toBe(true)
  })

  it('keeps ring geometry and edge drawing behind the Advanced disclosure', async () => {
    const { getByTestId, queryByTestId, openAdvanced } = await renderEgoPanel()

    // Essentials stay visible; refinements start collapsed
    expect(getByTestId('ego-ring-ordering')).toBeTruthy()
    expect(getByTestId('ego-max-hops')).toBeTruthy()
    expect(queryByTestId('ego-ring-spacing')).toBeNull()
    expect(queryByTestId('ego-arc-intra-ring')).toBeNull()
    expect(queryByTestId('ego-hide-ring-labels')).toBeNull()

    await openAdvanced()

    expect(queryByTestId('ego-ring-spacing')).not.toBeNull()
    expect(queryByTestId('ego-arc-intra-ring')).not.toBeNull()
    expect(queryByTestId('ego-hide-ring-labels')).not.toBeNull()
  })

  it('changing the ordering strategy updates the store', async () => {
    const { store, getByTestId } = await renderEgoPanel()

    await fireEvent.update(getByTestId('ego-ring-ordering'), 'node-type')

    expect(store.layoutModeConfig.ego.ringOrdering).toBe('node-type')
  })

  it('toggling same-ring arcs updates the store', async () => {
    const { store, getByTestId, openAdvanced } = await renderEgoPanel()
    await openAdvanced()

    await fireEvent.click(getByTestId('ego-arc-intra-ring'))

    expect(store.layoutModeConfig.ego.arcIntraRingEdges).toBe(false)
  })

  it('ring labels show by default and the toggle hides them', async () => {
    const { store, getByTestId, openAdvanced } = await renderEgoPanel()
    await openAdvanced()

    const checkbox = getByTestId('ego-hide-ring-labels') as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    expect(store.layoutModeConfig.ego.hideRingLabels).toBe(false)

    await fireEvent.click(checkbox)

    expect(store.layoutModeConfig.ego.hideRingLabels).toBe(true)
  })

  it('shows the property picker only for the property strategy', async () => {
    const { store, queryByTestId } = await renderEgoPanel()

    expect(queryByTestId('ego-ring-ordering-key')).toBeNull()

    store.updateLayoutModeConfig({ ego: { ringOrdering: 'property' } })
    await nextTick()

    expect(queryByTestId('ego-ring-ordering-key')).not.toBeNull()
  })

  it('warns when no node carries the attribute instead of silently falling back', async () => {
    const { store, getByTestId } = await renderEgoPanel()
    // Nodes exist but none carries the selected property
    store.nodes = [
      { node_id: 'a', node_type: 'Person', properties: {} },
      { node_id: 'b', node_type: 'Person', properties: {} },
    ]
    store.updateLayoutModeConfig({ ego: { ringOrdering: 'property', ringOrderingKey: 'jurisdiction' } })
    await nextTick()

    expect(getByTestId('ego-ordering-degraded-hint')).toBeTruthy()
  })

  it('reports partial coverage so missing-attribute nodes are accounted for', async () => {
    const { store, getByTestId, queryByTestId } = await renderEgoPanel()
    store.nodes = [
      { node_id: 'a', node_type: 'Person', properties: { seg: 'x' } },
      { node_id: 'b', node_type: 'Person', properties: {} },
      { node_id: 'c', node_type: 'Person', properties: {} },
    ]
    store.updateLayoutModeConfig({ ego: { ringOrdering: 'property', ringOrderingKey: 'seg' } })
    await nextTick()

    expect(queryByTestId('ego-ordering-degraded-hint')).toBeNull()
    expect(getByTestId('ego-ordering-coverage-hint').textContent).toContain('2 of 3')
  })

  it('offers to enable Graph Lens only while it is off', async () => {
    const { store, getByTestId, queryByTestId, openAdvanced } = await renderEgoPanel()
    store.behaviors.edgeLensMode = 'off'
    await openAdvanced()

    await fireEvent.click(getByTestId('ego-enable-lens'))

    expect(store.behaviors.edgeLensMode).toBe('dim')
    await nextTick()
    expect(queryByTestId('ego-lens-hint')).toBeNull()
  })
})

describe('LayoutPanel — ego no-op and pinning hints', () => {
  async function renderEgoPanel() {
    const store = useGraphStore()
    store.setLayoutAlgorithm('ego')
    const utils = render(LayoutPanel, { props: { isLayoutRunning: false } })
    await nextTick()
    const openAdvanced = async () => {
      await fireEvent.click(utils.getByTestId('ego-advanced-toggle'))
      await nextTick()
    }
    return { store, openAdvanced, ...utils }
  }

  it('explains that crossing reduction has nothing to do in a convergence star', async () => {
    const { store, getByTestId, queryByTestId } = await renderEgoPanel()
    expect(queryByTestId('ego-crossing-noop-hint')).toBeNull()

    store.egoLayoutStats = { nonTreeEdgeCount: 0, sameRingEdgeCount: 0, siftingSkippedLargeRing: false }
    await nextTick()

    expect(getByTestId('ego-crossing-noop-hint')).toBeTruthy()
  })

  it('does not claim a no-op when non-tree edges exist', async () => {
    const { store, queryByTestId, openAdvanced } = await renderEgoPanel()

    store.egoLayoutStats = { nonTreeEdgeCount: 7, sameRingEdgeCount: 3, siftingSkippedLargeRing: false }
    await openAdvanced()

    expect(queryByTestId('ego-crossing-noop-hint')).toBeNull()
    expect(queryByTestId('ego-no-same-ring-hint')).toBeNull()
  })

  it('does not claim a crossing no-op under a sector strategy', async () => {
    const { store, queryByTestId } = await renderEgoPanel()
    store.egoLayoutStats = { nonTreeEdgeCount: 0, sameRingEdgeCount: 0, siftingSkippedLargeRing: false }
    store.updateLayoutModeConfig({ ego: { ringOrdering: 'node-type' } })
    await nextTick()

    expect(queryByTestId('ego-crossing-noop-hint')).toBeNull()
  })

  it('flags when no edge joins two nodes on the same ring', async () => {
    const { store, getByTestId, openAdvanced } = await renderEgoPanel()
    await openAdvanced()

    store.egoLayoutStats = { nonTreeEdgeCount: 4, sameRingEdgeCount: 0, siftingSkippedLargeRing: false }
    await nextTick()

    expect(getByTestId('ego-no-same-ring-hint')).toBeTruthy()
  })

  it('explains that ego pins nodes so simulation controls do not apply', async () => {
    const { getByTestId, openAdvanced } = await renderEgoPanel()
    await openAdvanced()

    expect(getByTestId('ego-pinned-hint').textContent).toContain('pinned')
  })
})

describe('LayoutPanel — crossing heuristic controls', () => {
  async function renderEgoAdvanced() {
    const store = useGraphStore()
    store.setLayoutAlgorithm('ego')
    const utils = render(LayoutPanel, { props: { isLayoutRunning: false } })
    await nextTick()
    await fireEvent.click(utils.getByTestId('ego-advanced-toggle'))
    await nextTick()
    return { store, ...utils }
  }

  it('defaults to the cheap heuristic — sifting is opt-in', async () => {
    // Sifting uncrosses far more but costs up to ~90ms; the layout re-runs on
    // every config nudge inside a 150ms debounce, so it must not be imposed.
    const { getByTestId } = await renderEgoAdvanced()

    expect((getByTestId('ego-crossing-heuristic') as HTMLSelectElement).value).toBe('barycenter')
  })

  it('changing the heuristic updates the store', async () => {
    const { store, getByTestId } = await renderEgoAdvanced()

    await fireEvent.update(getByTestId('ego-crossing-heuristic'), 'median')

    expect(store.layoutModeConfig.ego.crossingHeuristic).toBe('median')
  })

  it('exposes the sweep count only for the sweep-based heuristics', async () => {
    const { store, queryByTestId } = await renderEgoAdvanced()

    // Default (barycenter) is sweep-based, so the slider is there
    expect(queryByTestId('ego-crossing-sweeps')).not.toBeNull()

    store.updateLayoutModeConfig({ ego: { crossingHeuristic: 'sifting' } })
    await nextTick()

    // Sifting ignores sweeps entirely
    expect(queryByTestId('ego-crossing-sweeps')).toBeNull()
  })

  it('sweep slider writes to the store', async () => {
    const { store, getByTestId } = await renderEgoAdvanced()

    await fireEvent.update(getByTestId('ego-crossing-sweeps'), '6')

    expect(store.layoutModeConfig.ego.crossingSweeps).toBe(6)
  })

  it('warns that the default sweep heuristic is weak on hub-dominated graphs', async () => {
    const { store, getByTestId, queryByTestId } = await renderEgoAdvanced()

    // Shown by default, since the default IS a sweep heuristic
    expect(getByTestId('ego-heuristic-weak-hint')).toBeTruthy()

    store.updateLayoutModeConfig({ ego: { crossingHeuristic: 'sifting' } })
    await nextTick()

    expect(queryByTestId('ego-heuristic-weak-hint')).toBeNull()
  })

  it('reports when a ring was too large to sift', async () => {
    const { store, getByTestId, queryByTestId } = await renderEgoAdvanced()

    store.updateLayoutModeConfig({ ego: { crossingHeuristic: 'sifting' } })
    store.egoLayoutStats = { nonTreeEdgeCount: 50, sameRingEdgeCount: 50, siftingSkippedLargeRing: false }
    await nextTick()
    expect(queryByTestId('ego-sifting-skipped-hint')).toBeNull()

    store.egoLayoutStats = { nonTreeEdgeCount: 50, sameRingEdgeCount: 50, siftingSkippedLargeRing: true }
    await nextTick()

    expect(getByTestId('ego-sifting-skipped-hint')).toBeTruthy()
  })

  it('hides heuristic controls under a sector strategy', async () => {
    const { store, queryByTestId } = await renderEgoAdvanced()

    store.updateLayoutModeConfig({ ego: { ringOrdering: 'node-type' } })
    await nextTick()

    expect(queryByTestId('ego-crossing-heuristic')).toBeNull()
  })
})
