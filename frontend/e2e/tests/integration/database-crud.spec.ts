/**
 * Integration tests: Context & Exploration CRUD via real PostgreSQL backend.
 *
 * Requires full stack running (docker-compose + warehouse + api + frontend).
 * Skipped in CI.
 */
import {
  test,
  expect,
  TEST_USER_A,
  TEST_USER_B,
  API_BASE,
} from '../../fixtures/integration-fixtures';

/** Helper to create an API context for a different user. */
async function apiAs(playwright: any, email: string) {
  return playwright.request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: {
      'X-Forwarded-Email': email,
      'Content-Type': 'application/json',
    },
  });
}

test.describe('Graph Context CRUD (database mode)', () => {
  test('create, read, update, delete a graph context', async ({ api }) => {
    // CREATE
    const createRes = await api.post('api/graph-contexts', {
      data: {
        title: 'Integration Test Context',
        description: 'Created by integration test',
        tags: ['test'],
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
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
        node_types: ['Person', 'Company'],
        relationship_types: ['KNOWS', 'WORKS_AT'],
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const context = await createRes.json();
    expect(context.id).toBeTruthy();
    expect(context.title).toBe('Integration Test Context');
    expect(context.owner_email).toBe(TEST_USER_A);
    expect(context.node_types).toEqual(['Person', 'Company']);
    expect(context.created_at).toBeTruthy();

    const contextId = context.id;

    // READ (single)
    const getRes = await api.get(`api/graph-contexts/${contextId}`);
    expect(getRes.ok()).toBeTruthy();
    const fetched = await getRes.json();
    expect(fetched.title).toBe('Integration Test Context');
    expect(fetched.edge_structure.src_col).toBe('src');

    // READ (list)
    const listRes = await api.get('api/graph-contexts');
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.some((c: any) => c.id === contextId)).toBeTruthy();

    // UPDATE
    const updateRes = await api.put(`api/graph-contexts/${contextId}`, {
      data: {
        title: 'Updated Title',
        tags: ['test', 'updated'],
        node_types: ['Person', 'Company', 'Product'],
      },
    });
    expect(updateRes.ok()).toBeTruthy();
    const updated = await updateRes.json();
    expect(updated.title).toBe('Updated Title');
    expect(updated.tags).toEqual(['test', 'updated']);
    expect(updated.node_types).toContain('Product');

    // DELETE
    const deleteRes = await api.delete(`api/graph-contexts/${contextId}`);
    expect(deleteRes.ok()).toBeTruthy();

    // Confirm deleted
    const getAfterDelete = await api.get(`api/graph-contexts/${contextId}`);
    expect(getAfterDelete.status()).toBe(404);
  });

  test('context shows in the UI after creation', async ({
    api,
    authenticatedPage: page,
  }) => {
    // Create a context via API
    const res = await api.post('api/graph-contexts', {
      data: {
        title: 'UI Visible Context',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
      },
    });
    expect(res.ok()).toBeTruthy();

    // Navigate to contexts page and verify
    await page.goto('/contexts');
    await expect(page.getByText('UI Visible Context')).toBeVisible();
  });
});

test.describe('Exploration CRUD (database mode)', () => {
  test('create, read, update, delete an exploration', async ({ api }) => {
    // Setup: create a context first
    const ctxRes = await api.post('api/graph-contexts', {
      data: {
        title: 'Exploration Test Context',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
        node_types: ['Person'],
        relationship_types: ['KNOWS'],
      },
    });
    const context = await ctxRes.json();
    const contextId = context.id;

    // CREATE exploration
    const createRes = await api.post(
      `api/graph-contexts/${contextId}/explorations`,
      {
        data: {
          title: 'Test Exploration',
          state: {
            nodes: [],
            edges: [],
            filters: {
              node_types: ['Person'],
              edge_types: [],
              nodePropertyFilters: [],
              edgePropertyFilters: [],
            },
            viewport: { zoom: 1.0, center_x: 0, center_y: 0 },
            layout_algorithm: 'force-atlas-2',
            graph_query: 'SELECT * FROM edges LIMIT 10',
          },
        },
      }
    );
    expect(createRes.ok()).toBeTruthy();
    const exploration = await createRes.json();
    expect(exploration.id).toBeTruthy();
    expect(exploration.title).toBe('Test Exploration');
    expect(exploration.graph_context_id).toBe(contextId);

    const explorationId = exploration.id;

    // READ (single)
    const getRes = await api.get(`api/explorations/${explorationId}`);
    expect(getRes.ok()).toBeTruthy();
    const fetched = await getRes.json();
    expect(fetched.state.graph_query).toBe('SELECT * FROM edges LIMIT 10');

    // READ (list by context)
    const listRes = await api.get(
      `api/graph-contexts/${contextId}/explorations`
    );
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    expect(list.length).toBe(1);
    expect(list[0].title).toBe('Test Exploration');

    // UPDATE title
    const updateRes = await api.put(`api/explorations/${explorationId}`, {
      data: { title: 'Renamed Exploration' },
    });
    expect(updateRes.ok()).toBeTruthy();
    expect((await updateRes.json()).title).toBe('Renamed Exploration');

    // UPDATE state
    const updateStateRes = await api.put(
      `api/explorations/${explorationId}`,
      {
        data: {
          state: {
            nodes: [{ node_id: 'n1' }],
            edges: [],
            filters: {
              node_types: [],
              edge_types: [],
              nodePropertyFilters: [],
              edgePropertyFilters: [],
            },
            viewport: { zoom: 2.0, center_x: 100, center_y: 50 },
            layout_algorithm: 'circular',
          },
        },
      }
    );
    expect(updateStateRes.ok()).toBeTruthy();
    const updatedState = (await updateStateRes.json()).state;
    expect(updatedState.layout_algorithm).toBe('circular');
    expect(updatedState.viewport.zoom).toBe(2.0);
    expect(updatedState.nodes).toHaveLength(1);

    // DELETE
    const deleteRes = await api.delete(`api/explorations/${explorationId}`);
    expect(deleteRes.ok()).toBeTruthy();

    const getAfterDelete = await api.get(`api/explorations/${explorationId}`);
    expect(getAfterDelete.status()).toBe(404);
  });

  test('duplicate exploration title in same context returns 409', async ({
    api,
  }) => {
    const ctxRes = await api.post('api/graph-contexts', {
      data: {
        title: 'Dup Test Context',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
      },
    });
    const contextId = (await ctxRes.json()).id;

    const state = {
      nodes: [],
      edges: [],
      filters: { node_types: [], edge_types: [] },
      viewport: { zoom: 1, center_x: 0, center_y: 0 },
      layout_algorithm: 'force-atlas-2',
    };

    // First exploration
    await api.post(`api/graph-contexts/${contextId}/explorations`, {
      data: { title: 'Same Name', state },
    });

    // Duplicate title
    const dupRes = await api.post(
      `api/graph-contexts/${contextId}/explorations`,
      {
        data: { title: 'Same Name', state },
      }
    );
    expect(dupRes.status()).toBe(409);
  });

  test('deleting context cascades to explorations', async ({ api }) => {
    const ctxRes = await api.post('api/graph-contexts', {
      data: {
        title: 'Cascade Test',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
      },
    });
    const contextId = (await ctxRes.json()).id;

    const state = {
      nodes: [],
      edges: [],
      filters: { node_types: [], edge_types: [] },
      viewport: { zoom: 1, center_x: 0, center_y: 0 },
      layout_algorithm: 'force-atlas-2',
    };

    const expRes = await api.post(
      `api/graph-contexts/${contextId}/explorations`,
      {
        data: { title: 'Will Be Deleted', state },
      }
    );
    const explorationId = (await expRes.json()).id;

    // Delete context
    await api.delete(`api/graph-contexts/${contextId}`);

    // Exploration should be gone too
    const getExp = await api.get(`api/explorations/${explorationId}`);
    expect(getExp.status()).toBe(404);
  });
});

test.describe('Multi-user name collisions', () => {
  const EXPLORATION_STATE = {
    nodes: [],
    edges: [],
    filters: { node_types: [], edge_types: [] },
    viewport: { zoom: 1, center_x: 0, center_y: 0 },
    layout_algorithm: 'force-atlas-2',
  };

  test('two users can create contexts with the same title', async ({
    api,
    playwright,
  }) => {
    // User A creates context
    const resA = await api.post('api/graph-contexts', {
      data: {
        title: 'Shared Name',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
      },
    });
    expect(resA.ok()).toBeTruthy();
    const ctxA = await resA.json();

    // User B creates context with same title
    const apiB = await apiAs(playwright, TEST_USER_B);
    const resB = await apiB.post('api/graph-contexts', {
      data: {
        title: 'Shared Name',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
      },
    });
    expect(resB.ok()).toBeTruthy();
    const ctxB = await resB.json();

    // Both exist with distinct IDs
    expect(ctxA.id).not.toBe(ctxB.id);
    expect(ctxA.owner_email).toBe(TEST_USER_A);
    expect(ctxB.owner_email).toBe(TEST_USER_B);

    // Both appear in the global list
    const listRes = await api.get('api/graph-contexts');
    const list = await listRes.json();
    const matches = list.filter((c: any) => c.title === 'Shared Name');
    expect(matches.length).toBe(2);

    await apiB.dispose();
  });

  test('same exploration title allowed in different contexts', async ({
    api,
  }) => {
    // Create two contexts
    const ctx1Res = await api.post('api/graph-contexts', {
      data: {
        title: 'Context Alpha',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
      },
    });
    const ctx1Id = (await ctx1Res.json()).id;

    const ctx2Res = await api.post('api/graph-contexts', {
      data: {
        title: 'Context Beta',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
      },
    });
    const ctx2Id = (await ctx2Res.json()).id;

    // Create exploration with same title in both contexts
    const exp1 = await api.post(
      `api/graph-contexts/${ctx1Id}/explorations`,
      { data: { title: 'My Analysis', state: EXPLORATION_STATE } }
    );
    expect(exp1.ok()).toBeTruthy();

    const exp2 = await api.post(
      `api/graph-contexts/${ctx2Id}/explorations`,
      { data: { title: 'My Analysis', state: EXPLORATION_STATE } }
    );
    expect(exp2.ok()).toBeTruthy();

    // Both exist independently
    expect((await exp1.json()).id).not.toBe((await exp2.json()).id);
  });

  test('duplicate exploration title in same context returns 409 even for different users', async ({
    api,
    playwright,
  }) => {
    // User A creates context and shares with B (write access)
    const ctxRes = await api.post('api/graph-contexts', {
      data: {
        title: 'Shared Write Context',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
      },
    });
    const contextId = (await ctxRes.json()).id;

    await api.post(`api/graph-contexts/${contextId}/share`, {
      data: { email: TEST_USER_B, permission: 'write' },
    });

    // User A creates exploration
    const exp1 = await api.post(
      `api/graph-contexts/${contextId}/explorations`,
      { data: { title: 'Conflict Name', state: EXPLORATION_STATE } }
    );
    expect(exp1.ok()).toBeTruthy();

    // User B tries to create exploration with same title in same context
    const apiB = await apiAs(playwright, TEST_USER_B);
    const exp2 = await apiB.post(
      `api/graph-contexts/${contextId}/explorations`,
      { data: { title: 'Conflict Name', state: EXPLORATION_STATE } }
    );
    expect(exp2.status()).toBe(409);

    await apiB.dispose();
  });
});
