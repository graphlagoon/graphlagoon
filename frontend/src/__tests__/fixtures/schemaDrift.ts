import type { SchemaDriftFinding, SchemaDriftResponse } from '@/types/graph'

export function createSchemaDriftFinding(
  overrides: Partial<SchemaDriftFinding> = {},
): SchemaDriftFinding {
  return {
    code: 'PROPERTY_COLUMN_MISSING',
    severity: 'error',
    side: 'node',
    kind: 'property',
    name: 'email',
    message: 'Node property column `email` no longer exists in `cat.db.nodes`.',
    stored: { data_type: 'string' },
    live: null,
    auto_fixable: true,
    ...overrides,
  }
}

export function createSchemaDrift(overrides: Partial<SchemaDriftResponse> = {}): SchemaDriftResponse {
  return {
    context_id: 'ctx-1',
    checked_at: '2026-08-11T00:00:00Z',
    status: 'ok',
    types_checked: false,
    counts: { error: 0, warning: 0, info: 0 },
    node_table: { table_name: 'cat.db.nodes', reachable: true, columns: [] },
    edge_table: { table_name: 'cat.db.edges', reachable: true, columns: [] },
    findings: [],
    proposed: {
      node_properties: [],
      edge_properties: [],
      node_types: null,
      relationship_types: null,
    },
    ...overrides,
  }
}
