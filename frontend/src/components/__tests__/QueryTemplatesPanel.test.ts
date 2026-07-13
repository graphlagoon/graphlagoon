import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import QueryTemplatesPanel from '@/components/QueryTemplatesPanel.vue'
import { useGraphStore } from '@/stores/graph'
import { useAuthStore } from '@/stores/auth'
import { useQueryTemplatesStore } from '@/stores/queryTemplates'
import { createGraphContext } from '@/__tests__/fixtures/contexts'
import type { QueryTemplate } from '@/types/graph'

let mockTemplates: QueryTemplate[] = []

vi.mock('@/services/api', () => ({
  api: {
    getQueryTemplates: vi.fn(() => Promise.resolve(mockTemplates)),
    createQueryTemplate: vi.fn(),
    updateQueryTemplate: vi.fn(),
    deleteQueryTemplate: vi.fn(),
  },
}))

const ME = 'me@example.com'

function createTemplate(overrides: Partial<QueryTemplate> = {}): QueryTemplate {
  return {
    id: 'tpl-1',
    graph_context_id: 'ctx-1',
    owner_email: ME,
    name: 'My template',
    query_type: 'cypher',
    query: 'MATCH (n) RETURN n',
    parameters: [],
    options: { procedural_bfs: true, large_results_mode: true },
    visibility: 'shared',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function setupStores({ hasWrite = true } = {}) {
  const graphStore = useGraphStore()
  graphStore.currentContext = createGraphContext({ has_write_access: hasWrite })
  const authStore = useAuthStore()
  authStore.email = ME
}

async function renderPanel() {
  const tplStore = useQueryTemplatesStore()
  const utils = render(QueryTemplatesPanel)
  // Wait for onMounted's loadTemplates to land in the store and the DOM to settle.
  await waitFor(() => {
    expect(tplStore.templates.length).toBe(mockTemplates.length)
    expect(tplStore.loading).toBe(false)
    expect(utils.container.textContent).not.toContain('Loading templates')
  })
  return utils
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockTemplates = []
})

describe('QueryTemplatesPanel grouping', () => {
  it('groups private templates under "My templates" and shared under "Shared templates"', async () => {
    mockTemplates = [
      createTemplate({ id: 'a', name: 'mine', visibility: 'private' }),
      createTemplate({ id: 'b', name: 'ours', visibility: 'shared' }),
    ]
    setupStores()
    const { getByText, container } = await renderPanel()

    expect(getByText('My templates')).toBeDefined()
    expect(getByText('Shared templates')).toBeDefined()
    const groups = container.querySelectorAll('.template-group')
    expect(groups.length).toBe(2)
    expect(groups[0].textContent).toContain('mine')
    expect(groups[1].textContent).toContain('ours')
  })

  it('omits an empty group', async () => {
    mockTemplates = [createTemplate({ visibility: 'shared' })]
    setupStores()
    const { queryByText, getByText } = await renderPanel()

    expect(getByText('Shared templates')).toBeDefined()
    expect(queryByText('My templates')).toBeNull()
  })

  it('shows a PRIVATE badge on private templates', async () => {
    mockTemplates = [createTemplate({ visibility: 'private' })]
    setupStores()
    const { container } = await renderPanel()

    expect(container.querySelector('.badge.private')).not.toBeNull()
  })
})

describe('QueryTemplatesPanel action gating', () => {
  it('shows "+ New" even without write access (private templates are allowed)', async () => {
    setupStores({ hasWrite: false })
    const { getByTitle } = await renderPanel()

    expect(getByTitle('New Template')).toBeDefined()
  })

  it('write access allows editing a shared template someone else created', async () => {
    mockTemplates = [
      createTemplate({ owner_email: 'other@example.com', visibility: 'shared' }),
    ]
    setupStores({ hasWrite: true })
    const { getByTitle } = await renderPanel()

    expect(getByTitle('Edit template')).toBeDefined()
    expect(getByTitle('Delete template')).toBeDefined()
  })

  it('without write access, shared templates are read-only (Use only)', async () => {
    mockTemplates = [createTemplate({ visibility: 'shared' })]
    setupStores({ hasWrite: false })
    const { queryByTitle, getByTitle } = await renderPanel()

    expect(getByTitle('Use this template')).toBeDefined()
    expect(queryByTitle('Edit template')).toBeNull()
    expect(queryByTitle('Delete template')).toBeNull()
  })

  it('own private template is editable even without context write access', async () => {
    mockTemplates = [createTemplate({ owner_email: ME, visibility: 'private' })]
    setupStores({ hasWrite: false })
    const { getByTitle } = await renderPanel()

    expect(getByTitle('Edit template')).toBeDefined()
  })

  it('templates without a visibility field are treated as shared', async () => {
    // Defensive: an older API payload without the field must not be private.
    const legacy = createTemplate({ owner_email: 'other@example.com' })
    delete (legacy as Partial<QueryTemplate>).visibility
    mockTemplates = [legacy]
    setupStores({ hasWrite: true })
    const { getByText, getByTitle } = await renderPanel()

    expect(getByText('Shared templates')).toBeDefined()
    expect(getByTitle('Edit template')).toBeDefined()
  })
})
