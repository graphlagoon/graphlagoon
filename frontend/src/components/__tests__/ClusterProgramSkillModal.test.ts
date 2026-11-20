import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import ClusterProgramSkillModal from '@/components/ClusterProgramSkillModal.vue'
import { flushPromises } from '@vue/test-utils'
import { useGraphStore } from '@/stores/graph'
import { api } from '@/services/api'
import type { GraphContext } from '@/types/graph'

const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
Object.defineProperty(navigator, 'clipboard', {
  value: mockClipboard,
  writable: true,
})

function seedGraph() {
  const graphStore = useGraphStore()
  graphStore.nodes = [
    { node_id: 'n1', node_type: 'Person' },
    { node_id: 'n2', node_type: 'Company' },
  ]
  graphStore.edges = [{ edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'WORKS_AT' }]
  return graphStore
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

afterEach(() => {
  document.body.querySelectorAll('.modal-overlay').forEach((el) => el.remove())
})

describe('ClusterProgramSkillModal', () => {
  it('is not visible when modelValue is false', () => {
    seedGraph()
    render(ClusterProgramSkillModal, { props: { modelValue: false } })
    expect(document.body.querySelector('[data-testid="cluster-skill-modal"]')).toBeNull()
  })

  it('renders the skill text with the graph metadata when open', () => {
    seedGraph()
    render(ClusterProgramSkillModal, { props: { modelValue: true } })
    const text = document.body.querySelector('[data-testid="cluster-skill-text"]')
    expect(text).not.toBeNull()
    expect(text?.textContent).toContain('Person')
    expect(text?.textContent).toContain('Company')
    expect(text?.textContent).toContain('WORKS_AT')
  })

  it('lists the properties enrichment added and names the enrichments that have not run', async () => {
    const graphStore = useGraphStore()
    graphStore.currentContext = {
      id: 'c1',
      title: 'Bank',
      edge_table_name: 'main.bank.edges',
      node_properties: [{ name: 'name', data_type: 'string' }],
      edge_properties: [],
      enrichment_tables: [
        { name: 'risk', label: 'Risk', table: 'main.bank.risk', query: { sql: 'SELECT node_id FROM graph_nodes', target: 'nodes', run: 'auto' } },
        { name: 'audit', label: 'Audit', table: 'main.bank.audit', query: { sql: 'SELECT edge_id FROM graph_edges', run: 'manual' } },
      ],
    } as unknown as GraphContext
    vi.spyOn(api, 'getSubgraph').mockResolvedValue({
      nodes: [{ node_id: 'a', node_type: 'Account', properties: { name: 'Ana' } }],
      edges: [],
      truncated: false,
    })
    vi.spyOn(api, 'runEnrichmentQuery').mockResolvedValue({
      name: 'risk', label: 'Risk', target: 'nodes', columns: ['score'], rows: { a: { score: 0.9 } }, truncated: false,
    })
    await graphStore.loadSubgraph()
    await flushPromises()

    render(ClusterProgramSkillModal, { props: { modelValue: true } })
    const text = document.body.querySelector('[data-testid="cluster-skill-text"]')?.textContent ?? ''
    expect(text).toContain('- name (string)')
    expect(text).toContain('- score (number) — added by enrichment Risk')
    expect(text).toContain('the enrichment "Audit", which has not run on the loaded graph')
    expect(text).not.toContain('"Risk", which')
  })

  it('copies the skill text to the clipboard on Copy click', async () => {
    seedGraph()
    render(ClusterProgramSkillModal, { props: { modelValue: true } })
    const copyBtn = document.body.querySelector('[data-testid="cluster-skill-copy"]') as HTMLButtonElement
    await fireEvent.click(copyBtn)
    expect(mockClipboard.writeText).toHaveBeenCalledTimes(1)
    const copied = mockClipboard.writeText.mock.calls[0][0] as string
    expect(copied).toContain('cluster program')
    expect(copied).toContain('Person')
  })

  it('emits update:modelValue false when closed', async () => {
    seedGraph()
    const { emitted } = render(ClusterProgramSkillModal, { props: { modelValue: true } })
    const closeBtn = document.body.querySelector('.close-btn') as HTMLButtonElement
    await fireEvent.click(closeBtn)
    expect(emitted()['update:modelValue']).toBeTruthy()
    expect(emitted()['update:modelValue'][0]).toEqual([false])
  })
})
