/**
 * Mock data for E2E tests.
 * Used by API route interception to simulate backend responses.
 */

export const MOCK_CONFIG = {
  database_enabled: false,
  dev_mode: true,
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
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
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
