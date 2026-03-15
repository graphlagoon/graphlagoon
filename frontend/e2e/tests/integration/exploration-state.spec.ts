/**
 * Integration tests: ExplorationState round-trip through the database.
 *
 * Validates that all state fields survive the Pydantic serialization:
 * - nodePropertyFilters / edgePropertyFilters (BUG FIX)
 * - TextFormatRule with scope="global" (BUG FIX)
 * - clusters, graph_query, textFormat
 */
import { test, expect } from '../../fixtures/integration-fixtures';

/** Helper: create a context and return its id. */
async function createContext(api: any, title: string): Promise<string> {
  const res = await api.post('api/graph-contexts', {
    data: {
      title,
      edge_table_name: 'dev_catalog.graphs.edges_test',
      node_table_name: 'dev_catalog.graphs.nodes_test',
      node_types: ['Person', 'Company'],
      relationship_types: ['KNOWS', 'WORKS_AT'],
      edge_properties: [
        { name: 'weight', data_type: 'float' },
      ],
      node_properties: [
        { name: 'age', data_type: 'int' },
        { name: 'name', data_type: 'string' },
      ],
    },
  });
  return (await res.json()).id;
}

test.describe('ExplorationState round-trip', () => {
  test('nodePropertyFilters survive save and load', async ({ api }) => {
    const contextId = await createContext(api, 'PropertyFilter RT');

    const filters = {
      node_types: ['Person'],
      edge_types: [],
      search_query: 'alice',
      nodePropertyFilters: [
        {
          id: 'pf-1',
          property: 'prop:age',
          operator: 'greater_than',
          value: 25,
          values: null,
          minValue: null,
          maxValue: null,
          enabled: true,
        },
        {
          id: 'pf-2',
          property: 'prop:name',
          operator: 'contains',
          value: 'ali',
          values: null,
          minValue: null,
          maxValue: null,
          enabled: true,
        },
      ],
      edgePropertyFilters: [
        {
          id: 'pf-3',
          property: 'prop:weight',
          operator: 'between',
          value: null,
          values: null,
          minValue: 0.5,
          maxValue: 1.0,
          enabled: false,
        },
      ],
    };

    // CREATE exploration with property filters
    const createRes = await api.post(
      `api/graph-contexts/${contextId}/explorations`,
      {
        data: {
          title: 'With Property Filters',
          state: {
            nodes: [],
            edges: [],
            filters,
            viewport: { zoom: 1, center_x: 0, center_y: 0 },
            layout_algorithm: 'force-atlas-2',
            graph_query: 'SELECT * FROM edges LIMIT 100',
          },
        },
      }
    );
    expect(createRes.ok()).toBeTruthy();
    const explorationId = (await createRes.json()).id;

    // LOAD exploration back
    const getRes = await api.get(`api/explorations/${explorationId}`);
    expect(getRes.ok()).toBeTruthy();
    const loaded = await getRes.json();
    const loadedFilters = loaded.state.filters;

    // nodePropertyFilters preserved
    expect(loadedFilters.nodePropertyFilters).toHaveLength(2);
    expect(loadedFilters.nodePropertyFilters[0].property).toBe('prop:age');
    expect(loadedFilters.nodePropertyFilters[0].operator).toBe('greater_than');
    expect(loadedFilters.nodePropertyFilters[0].value).toBe(25);
    expect(loadedFilters.nodePropertyFilters[1].property).toBe('prop:name');
    expect(loadedFilters.nodePropertyFilters[1].operator).toBe('contains');

    // edgePropertyFilters preserved
    expect(loadedFilters.edgePropertyFilters).toHaveLength(1);
    expect(loadedFilters.edgePropertyFilters[0].operator).toBe('between');
    expect(loadedFilters.edgePropertyFilters[0].minValue).toBe(0.5);
    expect(loadedFilters.edgePropertyFilters[0].maxValue).toBe(1.0);
    expect(loadedFilters.edgePropertyFilters[0].enabled).toBe(false);

    // Other filter fields
    expect(loadedFilters.search_query).toBe('alice');
    expect(loadedFilters.node_types).toEqual(['Person']);
  });

  test('one_of property filter with values array round-trips', async ({
    api,
  }) => {
    const contextId = await createContext(api, 'OneOf RT');

    const createRes = await api.post(
      `api/graph-contexts/${contextId}/explorations`,
      {
        data: {
          title: 'OneOf Filter',
          state: {
            nodes: [],
            edges: [],
            filters: {
              node_types: [],
              edge_types: [],
              nodePropertyFilters: [
                {
                  id: 'pf-oneof',
                  property: 'prop:name',
                  operator: 'one_of',
                  value: null,
                  values: ['Alice', 'Bob', 'Carol'],
                  enabled: true,
                },
              ],
              edgePropertyFilters: [],
            },
            viewport: { zoom: 1, center_x: 0, center_y: 0 },
            layout_algorithm: 'force-atlas-2',
          },
        },
      }
    );
    expect(createRes.ok()).toBeTruthy();
    const explorationId = (await createRes.json()).id;

    const loaded = await (
      await api.get(`api/explorations/${explorationId}`)
    ).json();
    const pf = loaded.state.filters.nodePropertyFilters[0];
    expect(pf.operator).toBe('one_of');
    expect(pf.values).toEqual(['Alice', 'Bob', 'Carol']);
  });

  test('TextFormatState with scope="global" survives round-trip', async ({
    api,
  }) => {
    const contextId = await createContext(api, 'TextFormat RT');

    const textFormat = {
      rules: [
        {
          id: 'tf-1',
          name: 'Show name for Person',
          target: 'node',
          types: ['Person'],
          template: '{name} ({age})',
          priority: 10,
          enabled: true,
          scope: 'exploration',
        },
        {
          id: 'tf-2',
          name: 'Global edge label',
          target: 'edge',
          types: [],
          template: '{relationship_type}',
          priority: 0,
          enabled: true,
          scope: 'global', // This was rejected before the fix
        },
        {
          id: 'tf-3',
          name: 'Context-level rule',
          target: 'node',
          types: [],
          template: '{node_id}',
          priority: 5,
          enabled: false,
          scope: 'context',
        },
      ],
      defaults: {
        nodeTemplate: '{node_id}',
        edgeTemplate: '{relationship_type}',
      },
    };

    const createRes = await api.post(
      `api/graph-contexts/${contextId}/explorations`,
      {
        data: {
          title: 'With TextFormat',
          state: {
            nodes: [],
            edges: [],
            filters: { node_types: [], edge_types: [] },
            viewport: { zoom: 1, center_x: 0, center_y: 0 },
            layout_algorithm: 'force-atlas-2',
            textFormat,
          },
        },
      }
    );
    // Should NOT return 422 (validation error)
    expect(createRes.ok()).toBeTruthy();
    const explorationId = (await createRes.json()).id;

    // Load and verify
    const loaded = await (
      await api.get(`api/explorations/${explorationId}`)
    ).json();
    const tf = loaded.state.textFormat;

    expect(tf.rules).toHaveLength(3);
    expect(tf.rules[0].scope).toBe('exploration');
    expect(tf.rules[1].scope).toBe('global');
    expect(tf.rules[2].scope).toBe('context');
    expect(tf.defaults.nodeTemplate).toBe('{node_id}');
    expect(tf.defaults.edgeTemplate).toBe('{relationship_type}');
  });

  test('clusters state round-trips as opaque JSON', async ({ api }) => {
    const contextId = await createContext(api, 'Clusters RT');

    const clusters = {
      enabled: true,
      groups: {
        'group-1': {
          id: 'group-1',
          name: 'Engineering',
          nodeIds: ['n1', 'n2', 'n3'],
          color: '#ff0000',
        },
      },
      ungroupedLabel: 'Others',
    };

    const createRes = await api.post(
      `api/graph-contexts/${contextId}/explorations`,
      {
        data: {
          title: 'With Clusters',
          state: {
            nodes: [],
            edges: [],
            filters: { node_types: [], edge_types: [] },
            viewport: { zoom: 1, center_x: 0, center_y: 0 },
            layout_algorithm: 'force-atlas-2',
            clusters,
          },
        },
      }
    );
    expect(createRes.ok()).toBeTruthy();
    const explorationId = (await createRes.json()).id;

    const loaded = await (
      await api.get(`api/explorations/${explorationId}`)
    ).json();
    expect(loaded.state.clusters.enabled).toBe(true);
    expect(loaded.state.clusters.groups['group-1'].name).toBe('Engineering');
    expect(loaded.state.clusters.groups['group-1'].nodeIds).toEqual([
      'n1',
      'n2',
      'n3',
    ]);
  });

  test('graph_query with complex SQL round-trips', async ({ api }) => {
    const contextId = await createContext(api, 'Query RT');

    const graphQuery = `
      SELECT NAMED_STRUCT('edge_id', e.edge_id, 'src', e.src, 'dst', e.dst,
                          'relationship_type', e.relationship_type) AS r
      FROM dev_catalog.graphs.edges_test e
      WHERE e.relationship_type IN ('KNOWS', 'WORKS_AT')
      LIMIT 500
    `;

    const createRes = await api.post(
      `api/graph-contexts/${contextId}/explorations`,
      {
        data: {
          title: 'Complex Query',
          state: {
            nodes: [{ node_id: 'n1' }, { node_id: 'n2' }],
            edges: [{ edge_id: 'e1' }],
            filters: { node_types: [], edge_types: [] },
            viewport: { zoom: 3.5, center_x: -200, center_y: 150 },
            layout_algorithm: 'grid',
            graph_query: graphQuery,
          },
        },
      }
    );
    expect(createRes.ok()).toBeTruthy();
    const explorationId = (await createRes.json()).id;

    const loaded = await (
      await api.get(`api/explorations/${explorationId}`)
    ).json();
    expect(loaded.state.graph_query).toContain('NAMED_STRUCT');
    expect(loaded.state.graph_query).toContain("'WORKS_AT'");
    expect(loaded.state.viewport.zoom).toBe(3.5);
    expect(loaded.state.layout_algorithm).toBe('grid');
    expect(loaded.state.nodes).toHaveLength(2);
    expect(loaded.state.edges).toHaveLength(1);
  });
});
