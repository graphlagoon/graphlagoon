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
    getExplorations: vi.fn(),
    listStylePresets: vi.fn(),
    getStylePreset: vi.fn(),
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

/**
 * Pick a table through `TableSelect` (open the menu, click the row). The form
 * used to render native `<select>`s; the picker is a button + menu so a 90-table
 * workspace can be filtered.
 */
async function pickTable(container: Element, role: 'edge' | 'node', table: string) {
  // Roles are assigned on the table's own row in WarehouseTablePicker.
  await fireEvent.click(container.querySelector(`[data-testid="assign-${role}-${table}"]`)!)
}

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

      await pickTable(container, 'edge', 'db.edges')
      await flush()

      await pickTable(container, 'node', 'db.nodes')
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

    it('nodeless checkbox omits node table, properties and types from the payload', async () => {
      vi.mocked(api.createGraphContext).mockResolvedValue(createGraphContext())

      const { getByTestId, container } = renderModal({ open: true, mode: 'create' })
      await flush()

      await fireEvent.update(titleInput(container), 'Triples')
      await pickTable(container, 'edge', 'db.edges')
      await flush()

      // First pick a node table, then check the box — the stale selection
      // must not leak into the payload.
      await pickTable(container, 'node', 'db.nodes')
      await flush()
      await fireEvent.click(getByTestId('no-node-table-checkbox'))
      await flush()

      await fireEvent.click(getByTestId('create-context-submit'))
      await flush()

      expect(api.createGraphContext).toHaveBeenCalledTimes(1)
      const payload = vi.mocked(api.createGraphContext).mock.calls[0][0]
      expect(payload.node_table_name).toBeUndefined()
      expect(payload.node_properties).toBeUndefined()
      expect(payload.node_types).toBeUndefined()
      expect(payload.edge_table_name).toBe('db.edges')
      // node_structure still names the derived virtual table's columns.
      expect(payload.node_structure).toEqual({
        node_id_col: 'node_id',
        node_type_col: 'node_type',
      })
    })

    it('typeless columns: None selections post "" and disable the types inputs', async () => {
      vi.mocked(api.createGraphContext).mockResolvedValue(createGraphContext())

      const { getByTestId, container } = renderModal({ open: true, mode: 'create' })
      await flush()

      await fireEvent.update(titleInput(container), 'Typeless')
      const selects = () => container.querySelectorAll('select')
      await pickTable(container, 'edge', 'db.edges')
      await flush()
      await pickTable(container, 'node', 'db.nodes')
      await flush()

      // Column-mapping selects render once live schema is loaded. Pick None
      // for both type columns. Order: edge src, dst, rel type, edge id, then
      // node id, node type. (The table pickers are no longer <select>s, so
      // these indices count only the column-mapping ones.)
      const relTypeSelect = selects()[2] as HTMLSelectElement
      await fireEvent.update(relTypeSelect, '')
      const nodeTypeSelect = selects()[5] as HTMLSelectElement
      await fireEvent.update(nodeTypeSelect, '')
      await flush()

      // Types inputs are disabled and annotated (backend stores constants).
      const typeInputs = container.querySelectorAll(
        'input[placeholder*="constant"]',
      ) as NodeListOf<HTMLInputElement>
      expect(typeInputs).toHaveLength(2)
      expect(typeInputs[0].disabled).toBe(true)
      expect(typeInputs[1].disabled).toBe(true)

      await fireEvent.click(getByTestId('create-context-submit'))
      await flush()

      const payload = vi.mocked(api.createGraphContext).mock.calls[0][0]
      expect(payload.node_structure?.node_type_col).toBe('')
      expect(payload.edge_structure?.relationship_type_col).toBe('')
    })

    it('pre-checks the nodeless option when the warehouse has no node tables', async () => {
      vi.mocked(api.getDatasets).mockResolvedValue({
        edge_tables: ['db.triples'],
        node_tables: [],
      } as any)

      const { getByTestId } = renderModal({ open: true, mode: 'create' })
      await flush()

      const checkbox = getByTestId('no-node-table-checkbox') as HTMLInputElement
      expect(checkbox.checked).toBe(true)
    })

    it('emits saved with the created context', async () => {
      const created = createGraphContext({ id: 'new-ctx' })
      vi.mocked(api.createGraphContext).mockResolvedValue(created)

      const { getByTestId, container, emitted } = renderModal({ open: true, mode: 'create' })
      await flush()
      await fireEvent.update(titleInput(container), 'X')
      // Edge/Node Table are required: the submit button stays disabled until
      // both are set (the native selects used to enforce this via HTML5
      // constraint validation; the picker is a button, so the form states it).
      expect((getByTestId('create-context-submit') as HTMLButtonElement).disabled).toBe(true)
      await pickTable(container, 'edge', 'db.edges')
      await pickTable(container, 'node', 'db.nodes')
      await flush()
      expect((getByTestId('create-context-submit') as HTMLButtonElement).disabled).toBe(false)
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

      const selects = container.querySelectorAll('select:not([data-testid="semantics-unit"])')
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

    it('offers type Discover, using the context\'s own tables and structural columns', async () => {
      const context = createGraphContext({
        edge_table_name: 'db.edges',
        node_table_name: 'db.nodes',
      })
      vi.mocked(api.discoverSchema).mockResolvedValue({
        node_types: ['Person', 'Company'],
        relationship_types: ['KNOWS'],
      })

      const { getByTestId } = renderModal({ open: true, mode: 'edit', context })
      await flush()

      await fireEvent.click(getByTestId('discover-types-btn'))
      await flush()

      expect(api.discoverSchema).toHaveBeenCalledTimes(1)
      const [request] = vi.mocked(api.discoverSchema).mock.calls[0]
      expect(request.edge_table).toBe('db.edges')
      expect(request.node_table).toBe('db.nodes')
      expect(request.columns?.node_type_col).toBe(context.node_structure.node_type_col)
    })

    it('discovered types land in the payload, and properties still do not', async () => {
      const context = createGraphContext({ id: 'ctx-edit' })
      vi.mocked(api.updateGraphContext).mockResolvedValue(context)
      vi.mocked(api.discoverSchema).mockResolvedValue({
        node_types: ['Person', 'Company'],
        relationship_types: ['KNOWS'],
      })

      const { getByTestId } = renderModal({ open: true, mode: 'edit', context })
      await flush()

      await fireEvent.click(getByTestId('discover-types-btn'))
      await flush()
      await fireEvent.click(getByTestId('create-context-submit'))
      await flush()

      const [, payload] = vi.mocked(api.updateGraphContext).mock.calls[0]
      expect(payload.node_types).toEqual(['Person', 'Company'])
      expect(payload.relationship_types).toEqual(['KNOWS'])
      // Discovery must not have pulled property columns in as a side effect.
      expect(payload).not.toHaveProperty('node_properties')
      expect(payload).not.toHaveProperty('edge_properties')
    })

    it('loads identity keys and saves an added one', async () => {
      const person = {
        node_type: 'Person',
        entity: 'Customer',
        source: { kind: 'prop' as const, name: 'national_id' },
        normalize: 'digits' as const,
      }
      const context = createGraphContext({ id: 'ctx-edit', identity_keys: [person] })
      vi.mocked(api.updateGraphContext).mockResolvedValue(context)

      const { getByTestId, getAllByTestId } = renderModal({ open: true, mode: 'edit', context })
      await flush()
      expect(getByTestId('identity-key-chips').textContent).toContain('Customer')

      await fireEvent.click(getByTestId('identity-key-add'))
      await fireEvent.update(getAllByTestId('identity-key-node-type')[1], 'Account')
      await fireEvent.update(getAllByTestId('identity-key-entity')[1], 'BankAccount')
      await fireEvent.update(getAllByTestId('identity-key-normalize')[1], 'account')
      await fireEvent.click(getByTestId('create-context-submit'))
      await flush()

      const [, payload] = vi.mocked(api.updateGraphContext).mock.calls[0]
      expect(payload.identity_keys).toEqual([
        person,
        { node_type: 'Account', entity: 'BankAccount', source: 'node_id', normalize: 'account' },
      ])
    })

    it('attaches an enrichment table', async () => {
      const context = createGraphContext({ id: 'ctx-edit' })
      vi.mocked(api.updateGraphContext).mockResolvedValue(context)

      const { getByTestId } = renderModal({ open: true, mode: 'edit', context })
      await flush()
      await fireEvent.click(getByTestId('enrichment-add'))
      await fireEvent.update(getByTestId('enrichment-label'), 'Login devices')
      await fireEvent.update(getByTestId('enrichment-table'), 'main.risk.devices')
      await fireEvent.update(getByTestId('enrichment-key'), 'account_id')
      await fireEvent.update(getByTestId('enrichment-node-types'), 'Conta')
      await fireEvent.update(getByTestId('enrichment-columns'), 'device_id, ip')
      await fireEvent.update(getByTestId('enrichment-cardinality'), 'many')
      await fireEvent.click(getByTestId('create-context-submit'))
      await flush()

      const [, payload] = vi.mocked(api.updateGraphContext).mock.calls[0]
      expect(payload.enrichment_tables).toEqual([
        {
          name: 'login_devices',
          label: 'Login devices',
          table: 'main.risk.devices',
          key_column: 'account_id',
          match_node_types: ['Conta'],
          match_source: 'node_id',
          cardinality: 'many',
          columns: ['device_id', 'ip'],
          promote: null,
        },
      ])
    })

    it('attaches a table with only an edge enrichment query', async () => {
      const context = createGraphContext({ id: 'ctx-edit' })
      vi.mocked(api.updateGraphContext).mockResolvedValue(context)

      const { getByTestId } = renderModal({ open: true, mode: 'edit', context })
      await flush()
      await fireEvent.click(getByTestId('enrichment-add'))
      await fireEvent.update(getByTestId('enrichment-label'), 'Tx risk')
      await fireEvent.update(getByTestId('enrichment-table'), 'main.fraud.transactions')
      await fireEvent.update(getByTestId('enrichment-query-sql'), '  SELECT e.edge_id, t.risk FROM graph_edges e JOIN main.fraud.transactions t ON t.id = e.edge_id ')
      await fireEvent.update(getByTestId('enrichment-query-run'), 'manual')
      await fireEvent.click(getByTestId('enrichment-query-overwrite'))
      await fireEvent.click(getByTestId('create-context-submit'))
      await flush()

      const [, payload] = vi.mocked(api.updateGraphContext).mock.calls[0]
      expect(payload.enrichment_tables).toEqual([
        {
          name: 'tx_risk',
          label: 'Tx risk',
          table: 'main.fraud.transactions',
          query: {
            sql: 'SELECT e.edge_id, t.risk FROM graph_edges e JOIN main.fraud.transactions t ON t.id = e.edge_id',
            target: 'edges',
            run: 'manual',
            overwrite: true,
            node_props: false,
          },
        },
      ])
    })

    it('keeps a stored lookup and query, and holds back an unfinished lookup', async () => {
      const stored = {
        name: 'devices', label: 'Devices', table: 'main.risk.devices', key_column: 'account_id',
        match_node_types: ['Conta'], match_source: 'node_id' as const, cardinality: 'one' as const,
        columns: ['ip'], promote: null,
        query: { sql: 'SELECT node_id FROM graph_nodes', target: 'nodes' as const, run: 'auto' as const, overwrite: false, node_props: true },
      }
      const context = createGraphContext({ id: 'ctx-edit', enrichment_tables: [stored] })
      vi.mocked(api.updateGraphContext).mockResolvedValue(context)

      const { getByTestId, getAllByTestId, queryByTestId } = renderModal({ open: true, mode: 'edit', context })
      await flush()
      expect(queryByTestId('enrichment-lookup-incomplete')).toBeNull()
      await fireEvent.click(getByTestId('enrichment-add'))
      await fireEvent.update(getAllByTestId('enrichment-table')[1], 'main.risk.kyc')
      await fireEvent.update(getAllByTestId('enrichment-key')[1], 'cpf')
      expect(getByTestId('enrichment-lookup-incomplete')).toBeTruthy()
      await fireEvent.click(getByTestId('create-context-submit'))
      await flush()

      const [, payload] = vi.mocked(api.updateGraphContext).mock.calls[0]
      expect(payload.enrichment_tables).toEqual([stored])
    })

    it('imports entries from YAML, replacing by name, and shows what is wrong', async () => {
      const stored = { name: 'kyc', label: 'KYC', table: 'main.risk.kyc' }
      const context = createGraphContext({ id: 'ctx-edit', enrichment_tables: [stored] })
      vi.mocked(api.updateGraphContext).mockResolvedValue(context)

      const { getByTestId, getAllByTestId } = renderModal({ open: true, mode: 'edit', context })
      await flush()
      await fireEvent.click(getByTestId('enrichment-import-toggle'))
      await fireEvent.update(
        getByTestId('enrichment-import-text'),
        [
          'enrichment_tables:',
          '  - {name: kyc, label: KYC v2, table: main.risk.kyc2}',
          '  - name: activity',
          '    label: Account activity',
          '    table: main.risk.ledger',
          '    query: {target: nodes, sql: "SELECT node_id, count(*) AS n FROM graph_nodes GROUP BY node_id"}',
          '  - {label: broken, table: ledger}',
        ].join('\n'),
      )
      await fireEvent.click(getByTestId('enrichment-import-apply'))
      expect(getByTestId('enrichment-import-done').textContent).toContain('1 added, 1 replaced')
      expect(getByTestId('enrichment-import-errors').textContent).toContain('catalog.schema.table')
      expect(getAllByTestId('enrichment-row')).toHaveLength(2)
      await fireEvent.click(getByTestId('create-context-submit'))
      await flush()

      const [, payload] = vi.mocked(api.updateGraphContext).mock.calls[0]
      expect(payload.enrichment_tables).toEqual([
        { name: 'kyc', label: 'KYC v2', table: 'main.risk.kyc2' },
        {
          name: 'activity', label: 'Account activity', table: 'main.risk.ledger',
          query: { sql: 'SELECT node_id, count(*) AS n FROM graph_nodes GROUP BY node_id', target: 'nodes', run: 'auto', overwrite: false, node_props: false },
        },
      ])
    })

    it('the AI prompt knows the context and its current entries', async () => {
      const context = createGraphContext({
        id: 'ctx-edit',
        enrichment_tables: [{ name: 'kyc', label: 'KYC', table: 'main.risk.kyc' }],
      })
      const { getByTestId } = renderModal({ open: true, mode: 'edit', context })
      await flush()
      await fireEvent.click(getByTestId('enrichment-ask-ai'))
      const text = getByTestId('enrichment-skill-text').textContent ?? ''
      expect(text).toContain(context.title)
      expect(text).toContain(`Edge table \`${context.edge_table_name}\``)
      expect(text).toContain('table: main.risk.kyc')
    })

    it('adds a second query on the same table, for the nodes', async () => {
      const stored = { name: 'tx', label: 'Tx', table: 'main.fraud.tx', query: { sql: 'SELECT edge_id FROM graph_edges', target: 'edges' as const, run: 'auto' as const, overwrite: false, node_props: false } }
      const context = createGraphContext({ id: 'ctx-edit', enrichment_tables: [stored] })
      vi.mocked(api.updateGraphContext).mockResolvedValue(context)

      const { getByTestId, getAllByTestId } = renderModal({ open: true, mode: 'edit', context })
      await flush()
      await fireEvent.click(getByTestId('enrichment-add-query'))
      await fireEvent.update(getAllByTestId('enrichment-query-sql')[1], 'SELECT node_id FROM graph_nodes')
      await fireEvent.update(getAllByTestId('enrichment-query-target')[1], 'nodes')
      await fireEvent.click(getByTestId('create-context-submit'))
      await flush()

      const [, payload] = vi.mocked(api.updateGraphContext).mock.calls[0]
      expect(payload.enrichment_tables).toEqual([
        stored,
        { name: 'tx_2', label: 'Tx (2)', table: 'main.fraud.tx', query: { sql: 'SELECT node_id FROM graph_nodes', target: 'nodes', run: 'auto', overwrite: false, node_props: false } },
      ])
    })

    it('saves the edge amount and time semantics', async () => {
      const context = createGraphContext({ id: 'ctx-edit', edge_semantics: { amount_prop: 'valor', currency: 'BRL' } })
      vi.mocked(api.updateGraphContext).mockResolvedValue(context)

      const { getByTestId } = renderModal({ open: true, mode: 'edit', context })
      await flush()
      await fireEvent.update(getByTestId('semantics-unit'), 'cents')
      await fireEvent.update(getByTestId('semantics-time'), 'data')
      await fireEvent.click(getByTestId('create-context-submit'))
      await flush()

      const [, payload] = vi.mocked(api.updateGraphContext).mock.calls[0]
      expect(payload.edge_semantics).toEqual({
        amount_prop: 'valor', amount_unit: 'cents', time_prop: 'data', currency: 'BRL',
      })
    })
  })
  describe('default look (default_behaviors.look)', () => {
    const LOOK = { nodeTypeColors: { Person: '#ff0000' }, layout_algorithm: 'circular' }

    beforeEach(() => {
      vi.mocked(api.getExplorations).mockResolvedValue([
        { id: 'exp-1', title: 'Styled', state: { ...LOOK, behaviors: { viewMode: '2d-proj' } } },
        { id: 'exp-2', title: 'Plain', state: {} },
      ] as any)
      vi.mocked(api.listStylePresets).mockResolvedValue([{ name: 'dark' }] as any)
      vi.mocked(api.getStylePreset).mockResolvedValue({ name: 'dark', settings: { nodeTypeColors: { Person: '#000' } } } as any)
    })

    async function submitted() {
      await flush()
      return vi.mocked(api.updateGraphContext).mock.calls[0][1]
    }

    it('keeps the look out of the behaviors textarea and saves both back', async () => {
      const context = createGraphContext({ id: 'ctx', default_behaviors: { viewMode: '3d', look: { ...LOOK, source: 'json' } } })
      vi.mocked(api.updateGraphContext).mockResolvedValue(context)
      const { getByTestId } = renderModal({ open: true, mode: 'edit', context })
      await flush()

      expect((getByTestId('create-context-default-behaviors') as HTMLTextAreaElement).value).not.toContain('look')
      expect(getByTestId('context-default-look-summary').textContent).toContain('1 type color')
      await fireEvent.click(getByTestId('create-context-submit'))
      expect((await submitted()).default_behaviors).toEqual({ viewMode: '3d', look: { ...LOOK, source: 'json' } })
    })

    it('imports the look of an exploration, listing only explorations that have one', async () => {
      const context = createGraphContext({ id: 'ctx' })
      vi.mocked(api.updateGraphContext).mockResolvedValue(context)
      const { getByTestId } = renderModal({ open: true, mode: 'edit', context })
      await flush()

      await fireEvent.click(getByTestId('context-default-look-open-import'))
      await flush()
      const select = getByTestId('context-default-look-source') as HTMLSelectElement
      const values = [...select.options].map((o) => o.value)
      expect(values).toContain('exploration:exp-1')
      expect(values).not.toContain('exploration:exp-2')
      expect(values).toContain('preset:dark')

      await fireEvent.update(select, 'exploration:exp-1')
      await fireEvent.click(getByTestId('context-default-look-import'))
      await flush()
      await fireEvent.click(getByTestId('create-context-submit'))
      const payload = await submitted()
      expect(payload.default_behaviors?.look).toEqual({ ...LOOK, source: 'exploration:Styled' })
    })

    it('imports the behaviors of an exploration into the textarea', async () => {
      const context = createGraphContext({ id: 'ctx', default_behaviors: { autoLoadOnOpen: true } })
      const { getByTestId } = renderModal({ open: true, mode: 'edit', context })
      await flush()
      await fireEvent.click(getByTestId('context-default-look-open-import'))
      await flush()
      await fireEvent.update(getByTestId('context-default-look-source'), 'exploration:exp-1')
      await fireEvent.click(getByTestId('context-default-behaviors-import'))
      await flush()
      expect(JSON.parse((getByTestId('create-context-default-behaviors') as HTMLTextAreaElement).value)).toEqual({
        autoLoadOnOpen: true,
        viewMode: '2d-proj',
      })
    })

    it('imports a preset and pasted JSON; Clear removes the look', async () => {
      const context = createGraphContext({ id: 'ctx', default_behaviors: { viewMode: '3d' } })
      vi.mocked(api.updateGraphContext).mockResolvedValue(context)
      const { getByTestId, queryByTestId } = renderModal({ open: true, mode: 'edit', context })
      await flush()

      await fireEvent.click(getByTestId('context-default-look-open-import'))
      await flush()
      await fireEvent.update(getByTestId('context-default-look-source'), 'preset:dark')
      await fireEvent.click(getByTestId('context-default-look-import'))
      await flush()
      expect(getByTestId('context-default-look-summary').textContent).toContain('preset “dark”')

      await fireEvent.click(getByTestId('context-default-look-open-import'))
      await flush()
      await fireEvent.update(getByTestId('context-default-look-source'), 'json')
      await fireEvent.update(getByTestId('context-default-look-json'), 'not json')
      await fireEvent.click(getByTestId('context-default-look-import'))
      await flush()
      expect(getByTestId('context-default-look-error').textContent).toContain('Not valid JSON')

      await fireEvent.click(queryByTestId('context-default-look-clear')!)
      await fireEvent.click(getByTestId('create-context-submit'))
      expect((await submitted()).default_behaviors).toEqual({ viewMode: '3d' })
    })
  })
})
