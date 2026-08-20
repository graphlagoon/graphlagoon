/**
 * REST-connection contexts across the UI: the picker offers named
 * connections, the query panel treats the language as opaque, and canned
 * operations only surface when the connection declared them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import GraphContextFormModal from '@/components/GraphContextFormModal.vue'
import GraphQueryPanel from '@/components/GraphQueryPanel.vue'
import { useGraphStore } from '@/stores/graph'
import { generateBfsExampleQuery } from '@/utils/exampleQuery'
import {
  createGraphContext,
  createRestConnectionConfig,
  createRestGraphContext,
} from '@/__tests__/fixtures/contexts'

vi.mock('@/services/api', () => ({
  api: {
    getDatasets: vi.fn(),
    getTableSchema: vi.fn(),
    discoverSchema: vi.fn(),
    createGraphContext: vi.fn(),
    updateGraphContext: vi.fn(),
    getGraphContext: vi.fn(),
    executeCypherQuery: vi.fn(),
    transpileCypher: vi.fn(),
    expandFromNode: vi.fn(),
  },
}))

import { api } from '@/services/api'

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await nextTick()
}

function serveConnections(connections = [createRestConnectionConfig()]) {
  ;(window as any).__GRAPH_LAGOON_CONFIG__ = {
    datasources: { sql_warehouse: true, neptune: false },
    datasource_connections: connections,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(api.getDatasets).mockResolvedValue({
    edge_tables: ['db.edges'],
    node_tables: ['db.nodes'],
  } as any)
  vi.mocked(api.getTableSchema).mockResolvedValue({
    table_name: 'db.edges',
    database: 'db',
    catalog: 'spark_catalog',
    columns: [{ name: 'src', data_type: 'string', nullable: true, comment: null }],
  } as any)
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
  document.body.innerHTML = ''
})

describe('context creation with a REST connection', () => {
  it('offers a card per registered connection', async () => {
    serveConnections([
      createRestConnectionConfig(),
      createRestConnectionConfig({ name: 'scores-api', label: 'Scores API' }),
    ])
    const { container } = render(GraphContextFormModal, {
      props: { open: true, mode: 'create' } as any,
    })
    await flush()

    expect(
      container.querySelector('[data-testid="datasource-option-rest:fraud-api"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="datasource-option-rest:scores-api"]'),
    ).not.toBeNull()
    expect(container.textContent).toContain('Fraud Graph Service')
    expect(container.textContent).toContain('Scores API')
  })

  it('submits datasource_type + datasource_name and no tables', async () => {
    serveConnections()
    const { container } = render(GraphContextFormModal, {
      props: { open: true, mode: 'create' } as any,
    })
    await flush()

    await fireEvent.click(
      container.querySelector('[data-testid="datasource-option-rest:fraud-api"]')!,
    )
    await flush()

    const title = container.querySelector(
      'input[placeholder="My Graph Context"]',
    ) as HTMLInputElement
    await fireEvent.update(title, 'My REST graph')
    await fireEvent.submit(container.querySelector('form')!)
    await flush()

    const payload = vi.mocked(api.createGraphContext).mock.calls[0]?.[0] as any
    expect(payload.datasource_type).toBe('rest')
    expect(payload.datasource_name).toBe('fraud-api')
    expect(payload).not.toHaveProperty('edge_table_name')
    expect(payload).not.toHaveProperty('node_table_name')
  })

  it('sends the connection name with discovery', async () => {
    serveConnections()
    const { container } = render(GraphContextFormModal, {
      props: { open: true, mode: 'create' } as any,
    })
    await flush()
    await fireEvent.click(
      container.querySelector('[data-testid="datasource-option-rest:fraud-api"]')!,
    )
    await flush()

    await fireEvent.click(
      container.querySelector('[data-testid="discover-types-btn"]')!,
    )
    await flush()

    expect(api.discoverSchema).toHaveBeenCalledWith({
      datasource_type: 'rest',
      datasource_name: 'fraud-api',
    })
  })

  it('hides the Discover button when the connection has no discovery', async () => {
    serveConnections([
      createRestConnectionConfig({
        capabilities: {
          expand: false,
          subgraph: false,
          fetch_nodes: false,
          schema_discovery: false,
        },
      }),
    ])
    const { container } = render(GraphContextFormModal, {
      props: { open: true, mode: 'create' } as any,
    })
    await flush()
    await fireEvent.click(
      container.querySelector('[data-testid="datasource-option-rest:fraud-api"]')!,
    )
    await flush()

    expect(container.querySelector('[data-testid="discover-types-btn"]')).toBeNull()
  })
})

describe('query panel on a REST context', () => {
  async function renderPanel() {
    const graphStore = useGraphStore()
    graphStore.currentContext = createRestGraphContext()
    await nextTick()
    const rendered = render(GraphQueryPanel, { props: {} as any })
    await flush()
    return { ...rendered, graphStore }
  }

  it('accepts a saved non-Cypher query — no MATCH heuristics', async () => {
    serveConnections()
    const graphStore = useGraphStore()
    graphStore.currentContext = createRestGraphContext()
    // A saved exploration query in the connection's own language: the Cypher
    // panels would discard this for not starting with MATCH.
    graphStore.graphQuery = 'accounts linked to case 7'
    await nextTick()
    const { container } = render(GraphQueryPanel, { props: {} as any })
    await flush()

    const run = container.querySelector(
      '[data-testid="graph-query-run"]',
    ) as HTMLButtonElement
    expect(run.disabled).toBe(false)
    expect(container.textContent).not.toContain('Query must start with MATCH')
  })

  it('seeds the connection example query and shows its language', async () => {
    serveConnections()
    const { container } = await renderPanel()

    // With no saved query, the connection's example seeds the editor — the
    // run button being enabled is the observable proof (an empty editor
    // disables it), without reaching into CodeMirror.
    const run = container.querySelector(
      '[data-testid="graph-query-run"]',
    ) as HTMLButtonElement
    expect(run.disabled).toBe(false)
    expect(container.textContent).toContain('FraudQL')
  })

  it('hides every SQL affordance', async () => {
    serveConnections()
    const { container } = await renderPanel()
    expect(container.querySelector('[data-testid="graph-query-mode-sql"]')).toBeNull()
    expect(container.querySelector('[data-testid="graph-query-settings"]')).toBeNull()
  })
})

describe('operation gates', () => {
  it('supportsExpand/supportsSubgraph follow the connection flags', async () => {
    serveConnections([
      createRestConnectionConfig({
        capabilities: {
          expand: false,
          subgraph: false,
          fetch_nodes: false,
          schema_discovery: false,
        },
      }),
    ])
    const graphStore = useGraphStore()
    graphStore.currentContext = createRestGraphContext()
    await nextTick()

    expect(graphStore.supportsExpand).toBe(false)
    expect(graphStore.supportsSubgraph).toBe(false)

    // expandFromNode is a guarded no-op — no API call goes out.
    await graphStore.expandFromNode('a', 1)
    expect(api.expandFromNode).not.toHaveBeenCalled()
  })

  it('static datasources keep every operation', async () => {
    const graphStore = useGraphStore()
    graphStore.currentContext = createGraphContext()
    await nextTick()
    expect(graphStore.supportsExpand).toBe(true)
    expect(graphStore.supportsSubgraph).toBe(true)
  })
})

describe('example query for a REST context', () => {
  it('returns the connection example instead of Cypher', () => {
    serveConnections()
    expect(generateBfsExampleQuery(createRestGraphContext(), [])).toBe(
      'accounts linked to case 42',
    )
  })

  it('returns empty for an orphaned connection rather than gibberish', () => {
    serveConnections([])
    expect(generateBfsExampleQuery(createRestGraphContext(), [])).toBe('')
  })
})
