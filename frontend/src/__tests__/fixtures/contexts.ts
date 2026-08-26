import type { GraphContext, Exploration, ExplorationState } from '@/types/graph'

export function createGraphContext(overrides: Partial<GraphContext> = {}): GraphContext {
  return {
    id: 'ctx-1',
    title: 'Test Context',
    tags: [],
    datasource_type: 'sql_warehouse',
    edge_table_name: 'test_edges',
    node_table_name: 'test_nodes',
    edge_structure: {
      edge_id_col: 'edge_id',
      src_col: 'src',
      dst_col: 'dst',
      relationship_type_col: 'relationship_type',
    },
    node_structure: {
      node_id_col: 'node_id',
      node_type_col: 'node_type',
    },
    edge_properties: [],
    node_properties: [],
    node_types: ['Person', 'Company'],
    relationship_types: ['KNOWS', 'WORKS_AT'],
    owner_email: 'test@example.com',
    shared_with: [],
    has_write_access: true,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

/**
 * A context backed by a native graph database.
 *
 * Deliberately carries no tables and no property columns — that absence is the
 * point: it is what the UI branches on, so a fixture that quietly filled them
 * in would let table-shaped bugs pass.
 */
export function createNeptuneGraphContext(
  overrides: Partial<GraphContext> = {},
): GraphContext {
  return createGraphContext({
    id: 'ctx-neptune-1',
    title: 'Neptune Context',
    datasource_type: 'neptune',
    edge_table_name: null,
    node_table_name: null,
    edge_properties: [],
    node_properties: [],
    ...overrides,
  })
}

/** A context backed by a named REST connection — no tables, no columns. */
export function createRestGraphContext(
  overrides: Partial<GraphContext> = {},
): GraphContext {
  return createGraphContext({
    id: 'ctx-rest-1',
    title: 'REST Context',
    datasource_type: 'rest',
    datasource_name: 'fraud-api',
    edge_table_name: null,
    node_table_name: null,
    edge_properties: [],
    node_properties: [],
    ...overrides,
  })
}

/** The config entry the server advertises for the fixture connection above. */
export function createRestConnectionConfig(overrides: Record<string, any> = {}) {
  return {
    type: 'rest' as const,
    name: 'fraud-api',
    label: 'Fraud Graph Service',
    kind: 'REST API',
    tagline: 'Operational · curated subgraph',
    description: 'Precomputed fraud neighborhoods served by the fraud team.',
    caveat: 'Carries only the curated fraud subgraph.',
    query_language: 'FraudQL',
    query_placeholder: 'accounts linked to case…',
    example_query: 'accounts linked to case 42',
    capabilities: {
      expand: true,
      subgraph: true,
      fetch_nodes: true,
      schema_discovery: true,
    },
    ...overrides,
  }
}

export function createExplorationState(overrides: Partial<ExplorationState> = {}): ExplorationState {
  return {
    nodes: [],
    edges: [],
    filters: {
      node_types: [],
      edge_types: [],
    },
    viewport: { zoom: 1, center_x: 0, center_y: 0 },
    layout_algorithm: 'force',
    ...overrides,
  }
}

export function createExploration(overrides: Partial<Exploration> = {}): Exploration {
  return {
    id: 'exp-1',
    graph_context_id: 'ctx-1',
    title: 'Test Exploration',
    owner_email: 'test@example.com',
    shared_with: [],
    has_write_access: true,
    state: createExplorationState(),
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}
