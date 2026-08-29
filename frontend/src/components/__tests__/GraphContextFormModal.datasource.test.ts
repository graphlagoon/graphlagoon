/**
 * Datasource selection in the context creation form.
 *
 * The picker is not cosmetic: it decides whether the table/column half of the
 * form exists at all, and what shape the created context has.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import GraphContextFormModal from '@/components/GraphContextFormModal.vue'
import {
  createGraphContext,
  createNeptuneGraphContext,
} from '@/__tests__/fixtures/contexts'

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

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await nextTick()
}

function enableBothDatasources() {
  ;(window as any).__GRAPH_LAGOON_CONFIG__ = {
    datasources: { sql_warehouse: true, neptune: true },
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(api.getDatasets).mockResolvedValue({
    edge_tables: ['db.edges'],
    node_tables: ['db.nodes'],
  } as any)
  vi.mocked(api.getTableSchema).mockImplementation(
    async (table: string) =>
      ({
        table_name: table,
        database: 'db',
        catalog: 'spark_catalog',
        columns: [
          { name: 'src', data_type: 'string', nullable: true, comment: null },
          { name: 'dst', data_type: 'string', nullable: true, comment: null },
        ],
      }) as any,
  )
  vi.mocked(api.createGraphContext).mockImplementation(
    async (payload: any) => createGraphContext(payload) as any,
  )
  vi.mocked(api.discoverSchema).mockResolvedValue({
    node_types: ['Person'],
    relationship_types: ['KNOWS'],
  } as any)
})

afterEach(() => {
  delete (window as any).__GRAPH_LAGOON_CONFIG__
})

/**
 * Pick a table through `TableSelect` (open the menu, click the row). The form
 * used to render native `<select>`s; the picker is a button + menu so a 90-table
 * workspace can be filtered.
 */
async function pickTable(container: Element, role: 'edge' | 'node', table: string) {
  // Roles are assigned on the table's own row in WarehouseTablePicker.
  await fireEvent.click(container.querySelector(`[data-testid="assign-${role}-${table}"]`)!)
}

describe('datasource picker visibility', () => {
  it('is hidden when the server serves only one datasource', async () => {
    ;(window as any).__GRAPH_LAGOON_CONFIG__ = {
      datasources: { sql_warehouse: true, neptune: false },
    }
    const { container } = render(GraphContextFormModal, {
      props: { open: true, mode: 'create' } as any,
    })
    await flush()

    // Nothing to pick between — the picker would only add noise.
    expect(container.querySelector('[data-testid="datasource-picker"]')).toBeNull()
  })

  it('offers both when the server serves both', async () => {
    enableBothDatasources()
    const { container } = render(GraphContextFormModal, {
      props: { open: true, mode: 'create' } as any,
    })
    await flush()

    expect(container.querySelector('[data-testid="datasource-picker"]')).not.toBeNull()
    expect(
      container.querySelector('[data-testid="datasource-option-sql_warehouse"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="datasource-option-neptune"]'),
    ).not.toBeNull()
  })

  it('is disabled in edit mode — the datasource is immutable', async () => {
    enableBothDatasources()
    const { container } = render(GraphContextFormModal, {
      props: {
        open: true,
        mode: 'edit',
        context: createNeptuneGraphContext(),
      } as any,
    })
    await flush()

    const option = container.querySelector(
      '[data-testid="datasource-option-sql_warehouse"]',
    ) as HTMLButtonElement
    expect(option.disabled).toBe(true)
  })
})

describe('form shape per datasource', () => {
  it('shows table configuration for the warehouse', async () => {
    enableBothDatasources()
    const { container } = render(GraphContextFormModal, {
      props: { open: true, mode: 'create' } as any,
    })
    await flush()

    expect(container.querySelector('[data-testid="warehouse-table-picker"]')).not.toBeNull()
  })

  it('collapses the table configuration for a native graph database', async () => {
    enableBothDatasources()
    const { container } = render(GraphContextFormModal, {
      props: { open: true, mode: 'create' } as any,
    })
    await flush()

    await fireEvent.click(
      container.querySelector('[data-testid="datasource-option-neptune"]')!,
    )
    await flush()

    // Table selects, structural column mapping and property lists all go away.
    const headings = Array.from(container.querySelectorAll('h4')).map((h) => h.textContent)
    expect(headings).not.toContain('Edge Table Columns')
    expect(headings).not.toContain('Node Table Columns')
    // Types remain: every datasource has them, only discovery differs.
    expect(headings).toContain('Schema Types')
  })

  it('lets types be discovered without any table selected', async () => {
    enableBothDatasources()
    const { container } = render(GraphContextFormModal, {
      props: { open: true, mode: 'create' } as any,
    })
    await flush()
    await fireEvent.click(
      container.querySelector('[data-testid="datasource-option-neptune"]')!,
    )
    await flush()

    const discover = container.querySelector(
      '[data-testid="discover-types-btn"]',
    ) as HTMLButtonElement
    expect(discover.disabled).toBe(false)

    await fireEvent.click(discover)
    await flush()

    expect(api.discoverSchema).toHaveBeenCalledWith({ datasource_type: 'neptune' })
  })

  it('requires both tables before discovery on the warehouse', async () => {
    enableBothDatasources()
    const { container } = render(GraphContextFormModal, {
      props: { open: true, mode: 'create' } as any,
    })
    await flush()

    const discover = container.querySelector(
      '[data-testid="discover-types-btn"]',
    ) as HTMLButtonElement
    expect(discover.disabled).toBe(true)
  })
})

describe('submitted payload', () => {
  async function submitNeptuneContext() {
    enableBothDatasources()
    const { container } = render(GraphContextFormModal, {
      props: { open: true, mode: 'create' } as any,
    })
    await flush()

    await fireEvent.click(
      container.querySelector('[data-testid="datasource-option-neptune"]')!,
    )
    await flush()

    const title = container.querySelector(
      'input[placeholder="My Graph Context"]',
    ) as HTMLInputElement
    await fireEvent.update(title, 'My Neptune graph')
    await fireEvent.submit(container.querySelector('form')!)
    await flush()

    return vi.mocked(api.createGraphContext).mock.calls[0]?.[0] as any
  }

  it('sends no table or structure fields for a native graph database', async () => {
    const payload = await submitNeptuneContext()

    expect(payload.datasource_type).toBe('neptune')
    expect(payload.title).toBe('My Neptune graph')
    expect(payload).not.toHaveProperty('edge_table_name')
    expect(payload).not.toHaveProperty('node_table_name')
    expect(payload).not.toHaveProperty('edge_structure')
    expect(payload).not.toHaveProperty('node_structure')
  })

  it('still sends the full warehouse payload when that is the choice', async () => {
    enableBothDatasources()
    const { container } = render(GraphContextFormModal, {
      props: { open: true, mode: 'create' } as any,
    })
    await flush()

    const title = container.querySelector(
      'input[placeholder="My Graph Context"]',
    ) as HTMLInputElement
    await fireEvent.update(title, 'Warehouse graph')

    await pickTable(container, 'edge', 'db.edges')
    await pickTable(container, 'node', 'db.nodes')
    await flush()

    await fireEvent.submit(container.querySelector('form')!)
    await flush()

    const payload = vi.mocked(api.createGraphContext).mock.calls[0]?.[0] as any
    expect(payload.datasource_type).toBe('sql_warehouse')
    expect(payload.edge_table_name).toBe('db.edges')
    expect(payload.node_table_name).toBe('db.nodes')
    expect(payload.edge_structure).toBeDefined()
  })
})
