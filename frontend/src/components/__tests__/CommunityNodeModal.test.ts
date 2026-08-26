import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import CommunityNodeModal from '@/components/CommunityNodeModal.vue'
import { useGraphStore } from '@/stores/graph'
import { useCommunityStore } from '@/stores/community'

// The community store watches graphStore.nodes and clears communities when it
// changes. Seeding nodes leaves that watcher pending, so we must flush it
// (nextTick) BEFORE seeding communityMap — otherwise the first flush wipes it.
async function seedStores() {
  const graphStore = useGraphStore()
  graphStore.nodes = [
    { node_id: 'n1', node_type: 'Person', properties: { name: 'Alice', age: '30' } },
    { node_id: 'n2', node_type: 'Person', properties: { name: 'Bob', age: '25' } },
    { node_id: 'n3', node_type: 'Company', properties: { name: 'Acme' } },
  ]

  const communityStore = useCommunityStore()
  await nextTick()
  communityStore.communityMap = new Map([
    ['n1', 0],
    ['n2', 0],
    ['n3', 1],
  ])
}

function rowIds(container: Element): string[] {
  return Array.from(container.querySelectorAll('tbody tr td:first-child')).map(
    td => td.textContent!.trim()
  )
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  document.body.querySelectorAll('.modal-overlay').forEach((el) => el.remove())
})

describe('CommunityNodeModal', () => {
  it('renders nothing when communityId is null', async () => {
    await seedStores()
    const { container } = render(CommunityNodeModal, { props: { communityId: null } })
    expect(container.querySelector('.modal-overlay')).toBeNull()
  })

  it('renders nothing when the community does not exist', async () => {
    await seedStores()
    const { container } = render(CommunityNodeModal, { props: { communityId: 99 } })
    expect(container.querySelector('.modal-overlay')).toBeNull()
  })

  it('shows the community title, node count, and algorithm badge', async () => {
    await seedStores()
    const { container } = render(CommunityNodeModal, { props: { communityId: 0 } })

    expect(container.querySelector('h2')?.textContent).toContain('Community 0')
    expect(container.textContent).toContain('2 nodes')
    expect(container.textContent).toContain('Louvain')
  })

  it('shows "Cluster Program" badge when a cluster program is the algorithm', async () => {
    await seedStores()
    const communityStore = useCommunityStore()
    communityStore.algorithm = 'cluster-program:my-prog'

    const { container } = render(CommunityNodeModal, { props: { communityId: 0 } })
    expect(container.textContent).toContain('Cluster Program')
  })

  it('lists only the nodes of the community with their properties', async () => {
    await seedStores()
    const { container } = render(CommunityNodeModal, { props: { communityId: 0 } })

    expect(rowIds(container)).toEqual(['n1', 'n2'])
    const body = container.querySelector('tbody')!
    expect(body.textContent).toContain('Alice')
    expect(body.textContent).toContain('Bob')
    expect(body.textContent).not.toContain('Acme')
  })

  it('filters rows by search query', async () => {
    await seedStores()
    const { container } = render(CommunityNodeModal, { props: { communityId: 0 } })

    const search = container.querySelector('.table-search')! as HTMLInputElement
    await fireEvent.update(search, 'alice')

    const body = container.querySelector('tbody')!
    expect(body.textContent).toContain('Alice')
    expect(body.textContent).not.toContain('Bob')
    expect(container.textContent).toContain('1 of 2 nodes')
  })

  it('shows empty state when search matches nothing', async () => {
    await seedStores()
    const { container } = render(CommunityNodeModal, { props: { communityId: 0 } })

    const search = container.querySelector('.table-search')! as HTMLInputElement
    await fireEvent.update(search, 'zzz-no-match')

    expect(container.querySelector('.no-data')?.textContent).toContain('No nodes found')
  })

  it('sorts rows when a column header is clicked', async () => {
    await seedStores()
    const { container } = render(CommunityNodeModal, { props: { communityId: 0 } })

    // Default: sorted by node_id asc (n1, n2). Click ID header to flip.
    const idHeader = Array.from(container.querySelectorAll('th'))
      .find(th => th.textContent!.includes('ID'))!
    await fireEvent.click(idHeader)

    const firstCell = container.querySelector('tbody tr td')!
    expect(firstCell.textContent).toContain('n2')
  })

  it('emits close on footer button click', async () => {
    await seedStores()
    const { container, emitted } = render(CommunityNodeModal, { props: { communityId: 0 } })

    await fireEvent.click(container.querySelector('.btn-secondary')!)
    expect(emitted().close).toBeTruthy()
  })

  it('emits close on overlay click', async () => {
    await seedStores()
    const { container, emitted } = render(CommunityNodeModal, { props: { communityId: 0 } })

    await fireEvent.click(container.querySelector('.modal-overlay')!)
    expect(emitted().close).toBeTruthy()
  })

  describe('property visibility allowlist', () => {
    it('shows only allowlisted property columns, with a "N of M" hint', async () => {
      await seedStores()
      const graphStore = useGraphStore()
      graphStore.setPropertyVisibility('node', ['name'])

      const { container } = render(CommunityNodeModal, { props: { communityId: 0 } })

      const headers = Array.from(container.querySelectorAll('th')).map(th => th.textContent!.trim())
      expect(headers.some(h => h.includes('name'))).toBe(true)
      expect(headers.some(h => h.includes('age'))).toBe(false)

      const hint = container.querySelector('[data-testid="property-visibility-hint"]')!
      expect(hint.textContent).toContain('1 of 2')
    })

    it('Show all clears the allowlist and brings every column back', async () => {
      await seedStores()
      const graphStore = useGraphStore()
      graphStore.setPropertyVisibility('node', ['name'])

      const { container } = render(CommunityNodeModal, { props: { communityId: 0 } })
      await fireEvent.click(container.querySelector('.show-all-btn')!)

      expect(graphStore.propertyVisibility.nodeProperties).toBeNull()
      const headers = Array.from(container.querySelectorAll('th')).map(th => th.textContent!.trim())
      expect(headers.some(h => h.includes('age'))).toBe(true)
      expect(container.querySelector('[data-testid="property-visibility-hint"]')).toBeNull()
    })

    it('renders no hint when nothing is hidden', async () => {
      await seedStores()
      const { container } = render(CommunityNodeModal, { props: { communityId: 0 } })
      expect(container.querySelector('[data-testid="property-visibility-hint"]')).toBeNull()
    })
  })
})
