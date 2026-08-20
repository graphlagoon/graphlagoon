/**
 * Mock data for E2E tests.
 * Used by API route interception to simulate backend responses.
 */

export const MOCK_CONFIG = {
  database_enabled: false,
  dev_mode: true,
  datasources: { sql_warehouse: true, neptune: false },
};

/** Server that can also serve Neptune-backed contexts. */
export const MOCK_CONFIG_WITH_NEPTUNE = {
  database_enabled: false,
  dev_mode: true,
  datasources: { sql_warehouse: true, neptune: true },
};

export const MOCK_CONFIG_PROD = {
  database_enabled: false,
  dev_mode: false,
};

export const MOCK_GRAPH_RESPONSE = {
  nodes: [
    { node_id: 'n1', node_type: 'Person', name: 'Alice', age: 30 },
    { node_id: 'n2', node_type: 'Person', name: 'Bob', age: 25 },
    { node_id: 'n3', node_type: 'Person', name: 'Carol', age: 35 },
    { node_id: 'n4', node_type: 'Company', name: 'Acme Corp', industry: 'Tech' },
    { node_id: 'n5', node_type: 'Company', name: 'Globex', industry: 'Finance' },
  ],
  edges: [
    { edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'KNOWS' },
    { edge_id: 'e2', src: 'n1', dst: 'n3', relationship_type: 'KNOWS' },
    { edge_id: 'e3', src: 'n2', dst: 'n3', relationship_type: 'KNOWS' },
    { edge_id: 'e4', src: 'n1', dst: 'n4', relationship_type: 'WORKS_AT' },
    { edge_id: 'e5', src: 'n2', dst: 'n5', relationship_type: 'WORKS_AT' },
    { edge_id: 'e6', src: 'n3', dst: 'n4', relationship_type: 'WORKS_AT' },
  ],
};

export const MOCK_DATASETS = {
  edge_tables: ['test_db.edges', 'test_db.relationships'],
  node_tables: ['test_db.nodes', 'test_db.entities'],
};

export const MOCK_DEV_RANDOM_GRAPH = {
  edge_table: 'dev_db.random_edges',
  node_table: 'dev_db.random_nodes',
  num_nodes: 50,
  num_edges: 100,
};

export const MOCK_CONTEXT = {
  id: 'ctx-test-1',
  title: 'Test Context',
  description: 'A test context for E2E',
  tags: ['env:test', 'team:qa'],
  datasource_type: 'sql_warehouse',
  edge_table_name: 'test_db.edges',
  node_table_name: 'test_db.nodes',
  owner_email: 'e2e@test.com',
  shared_with: [],
  has_write_access: true,
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
  // Opting in keeps the existing specs meaningful: opening a context fetches nothing by
  // default now, and most of these tests are about what you can do *with* a loaded graph.
  // MOCK_CONTEXT_NO_AUTOLOAD below covers the default (empty) path.
  default_behaviors: { autoLoadOnOpen: true },
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

/** A context with no opt-in — opening it fetches nothing (the default). */
export const MOCK_CONTEXT_NO_AUTOLOAD = {
  ...MOCK_CONTEXT,
  id: 'ctx-test-empty',
  title: 'Empty On Open',
  default_behaviors: {},
};

/**
 * A context backed by a native graph database.
 *
 * No tables, no column mapping, no property columns — that absence is what the
 * UI branches on, so filling any of it in would defeat the point.
 */
export const MOCK_NEPTUNE_CONTEXT = {
  ...MOCK_CONTEXT,
  id: 'ctx-neptune-1',
  title: 'Neptune Graph',
  description: 'A native graph database context',
  datasource_type: 'neptune',
  edge_table_name: null,
  node_table_name: null,
  edge_properties: [],
  node_properties: [],
};

/** What the server advertises for a registered REST connection. */
export const MOCK_REST_CONNECTION = {
  type: 'rest',
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
};

export const MOCK_REST_CONTEXT = {
  ...MOCK_CONTEXT,
  id: 'ctx-rest-1',
  title: 'Fraud REST Graph',
  description: 'A context backed by a named REST connection',
  datasource_type: 'rest',
  datasource_name: 'fraud-api',
  edge_table_name: null,
  node_table_name: null,
  edge_properties: [],
  node_properties: [],
};

export const MOCK_EXPLORATION = {
  id: 'exp-test-1',
  title: 'Test Exploration',
  graph_context_id: 'ctx-test-1',
  owner_email: 'e2e@test.com',
  shared_with: [],
  has_write_access: true,
  state: {
    nodes: [],
    edges: [],
    filters: { nodeTypes: [], relationshipTypes: [] },
    viewport: { x: 0, y: 0, zoom: 1 },
    layout_algorithm: 'forceAtlas2',
    graph_query: 'SELECT * FROM nodes LIMIT 10',
  },
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};
