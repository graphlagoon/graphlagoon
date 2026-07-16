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
