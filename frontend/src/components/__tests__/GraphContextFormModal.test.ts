import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import GraphContextFormModal from '@/components/GraphContextFormModal.vue'
import { createGraphContext } from '@/__tests__/fixtures/contexts'

vi.mock('@/services/api', () => ({
  api: {
    getDatasets: vi.fn(),
    getTableSchema: vi.fn(),
    discoverSchema: vi.fn(),
    createGraphContext: vi.fn(),
    updateGraphContext: vi.fn(),
  },
}))

import { api } from '@/services/api'

/** Resolve pending microtasks from the component's watchers. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await nextTick()
}

function renderModal(props: Record<string, unknown>) {
  return render(GraphContextFormModal, { props: props as any })
}

function titleInput(container: Element) {
  return container.querySelector('input[placeholder="My Graph Context"]') as HTMLInputElement
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(api.getDatasets).mockResolvedValue({
    edge_tables: ['db.edges'],
    node_tables: ['db.nodes'],
  } as any)
  vi.mocked(api.getTableSchema).mockImplementation(async (table: string) => {
    if (table === 'edges') {
      return {
        table_name: 'edges',
        database: 'db',
        catalog: 'spark_catalog',
        columns: [
          { name: 'src', data_type: 'string', nullable: true, comment: null },
          { name: 'dst', data_type: 'string', nullable: true, comment: null },
          { name: 'weight', data_type: 'double', nullable: true, comment: null },
        ],
      } as any
    }
    return {
      table_name: 'nodes',
      database: 'db',
      catalog: 'spark_catalog',
      columns: [
        { name: 'node_id', data_type: 'string', nullable: true, comment: null },
        { name: 'node_type', data_type: 'string', nullable: true, comment: null },
        { name: 'name', data_type: 'string', nullable: true, comment: null },
      ],
    } as any
  })
})

describe('GraphContextFormModal', () => {
  describe('create mode', () => {
    it('fetches datasets when opened', async () => {
      renderModal({ open: true, mode: 'create' })
      await flush()
      expect(api.getDatasets).toHaveBeenCalled()
    })

    it('builds a payload with properties computed from live columns minus structural ones', async () => {
      vi.mocked(api.createGraphContext).mockResolvedValue(createGraphContext())

      const { getByTestId, container } = renderModal({ open: true, mode: 'create' })
      await flush()

      await fireEvent.update(titleInput(container), 'My Context')

      const edgeSelect = container.querySelectorAll('select')[0] as HTMLSelectElement
      await fireEvent.update(edgeSelect, 'db.edges')
      await flush()

      const nodeSelect = container.querySelectorAll('select')[1] as HTMLSelectElement
      await fireEvent.update(nodeSelect, 'db.nodes')
      await flush()

      await fireEvent.click(getByTestId('create-context-submit'))
      await flush()

      expect(api.createGraphContext).toHaveBeenCalledTimes(1)
      const payload = vi.mocked(api.createGraphContext).mock.calls[0][0]
      expect(payload.title).toBe('My Context')
      expect(payload.edge_structure).toEqual({
        edge_id_col: 'edge_id',
        src_col: 'src',
        dst_col: 'dst',
        relationship_type_col: 'relationship_type',
      })
      expect(payload.node_structure).toEqual({
        node_id_col: 'node_id',
        node_type_col: 'node_type',
      })
      // Auto-selected src/dst leave 'weight' as the only edge property
      expect(payload.edge_properties).toEqual([{ name: 'weight', data_type: 'double' }])
      // Auto-selected node_id/node_type leave 'name' as the only node property
      expect(payload.node_properties).toEqual([{ name: 'name', data_type: 'string' }])
    })

    it('emits saved with the created context', async () => {
      const created = createGraphContext({ id: 'new-ctx' })
      vi.mocked(api.createGraphContext).mockResolvedValue(created)

      const { getByTestId, container, emitted } = renderModal({ open: true, mode: 'create' })
      await flush()
      await fireEvent.update(titleInput(container), 'X')
      // Edge/Node Table are required selects — HTML5 constraint validation
      // silently blocks form submission (no submit event at all) without them.
      await fireEvent.update(container.querySelectorAll('select')[0] as HTMLSelectElement, 'db.edges')
      await fireEvent.update(container.querySelectorAll('select')[1] as HTMLSelectElement, 'db.nodes')
      await flush()
      await fireEvent.click(getByTestId('create-context-submit'))
      await flush()

      expect(emitted().saved).toBeTruthy()
      expect(emitted().saved[0]).toEqual([created])
    })

    it('invalid default_behaviors JSON keeps submit disabled', async () => {
      const { getByTestId } = renderModal({ open: true, mode: 'create' })
      await flush()

      const textarea = getByTestId('create-context-default-behaviors')
      await fireEvent.update(textarea, '{not valid json')
      await flush()

      const submitBtn = getByTestId('create-context-submit') as HTMLButtonElement
      expect(submitBtn.disabled).toBe(true)
    })

    it('does not call the API when submit is attempted with invalid JSON', async () => {
      const { getByTestId } = renderModal({ open: true, mode: 'create' })
      await flush()

      await fireEvent.update(getByTestId('create-context-default-behaviors'), '{bad')
      await flush()
      await fireEvent.click(getByTestId('create-context-submit'))
      await flush()

      expect(api.createGraphContext).not.toHaveBeenCalled()
    })
  })

  describe('edit mode', () => {
    it('seeds the form from the given context', async () => {
      const context = createGraphContext({
        title: 'Existing Title',
        description: 'Existing description',
        tags: ['env:prod'],
      })

      const { container } = renderModal({ open: true, mode: 'edit', context })
      await flush()

      expect(titleInput(container).value).toBe('Existing Title')
    })

    it('does not fetch datasets (table names are immutable)', async () => {
      const context = createGraphContext()
      renderModal({ open: true, mode: 'edit', context })
      await flush()
      expect(api.getDatasets).not.toHaveBeenCalled()
    })

    it('renders table names as disabled text, not selects', async () => {
      const context = createGraphContext({ edge_table_name: 'db.edges', node_table_name: 'db.nodes' })
      const { container } = renderModal({ open: true, mode: 'edit', context })
      await flush()

      const selects = container.querySelectorAll('select')
      expect(selects.length).toBe(0)
      const disabledInputs = Array.from(container.querySelectorAll('input[disabled]')) as HTMLInputElement[]
      expect(disabledInputs.some((i) => i.value === 'db.edges')).toBe(true)
      expect(disabledInputs.some((i) => i.value === 'db.nodes')).toBe(true)
    })

    it('sends only the fields this form edits, never node/edge_properties', async () => {
      const context = createGraphContext({ id: 'ctx-edit' })
      vi.mocked(api.updateGraphContext).mockResolvedValue(context)

      const { getByTestId, container } = renderModal({ open: true, mode: 'edit', context })
      await flush()

      await fireEvent.update(titleInput(container), 'Renamed')
      await fireEvent.click(getByTestId('create-context-submit'))
      await flush()

      expect(api.updateGraphContext).toHaveBeenCalledTimes(1)
      const [id, payload] = vi.mocked(api.updateGraphContext).mock.calls[0]
      expect(id).toBe('ctx-edit')
      expect(payload.title).toBe('Renamed')
      expect(payload).not.toHaveProperty('node_properties')
      expect(payload).not.toHaveProperty('edge_properties')
      expect(payload).not.toHaveProperty('edge_table_name')
      expect(payload).not.toHaveProperty('node_table_name')
    })

    it('sends the edited structural columns as plain text values', async () => {
      const context = createGraphContext({ id: 'ctx-edit' })
      vi.mocked(api.updateGraphContext).mockResolvedValue(context)

      const { getByTestId, container } = renderModal({ open: true, mode: 'edit', context })
      await flush()

      const srcInput = container.querySelector('input[placeholder="src"]') as HTMLInputElement
      await fireEvent.update(srcInput, 'source_id')
      await fireEvent.click(getByTestId('create-context-submit'))
      await flush()

      const [, payload] = vi.mocked(api.updateGraphContext).mock.calls[0]
      expect(payload.edge_structure?.src_col).toBe('source_id')
    })
  })
})
