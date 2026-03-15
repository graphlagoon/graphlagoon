import type { GraphContext, Exploration, ExplorationState } from '@/types/graph'

export function createGraphContext(overrides: Partial<GraphContext> = {}): GraphContext {
  return {
    id: 'ctx-1',
    title: 'Test Context',
    tags: [],
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

export function createExplorationState(overrides: Partial<ExplorationState> = {}): ExplorationState {
  return {
    nodes: [],
    edges: [],
    filters: {
      node_types: [],
      edge_types: [],
      nodePropertyFilters: [],
      edgePropertyFilters: [],
    },
    viewport: { zoom: 1, center_x: 0, center_y: 0 },
    layout_algorithm: 'force-atlas-2',
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
