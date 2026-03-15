/**
 * Integration tests: Sharing & access control via real PostgreSQL backend.
 *
 * Tests share/unshare endpoints for both contexts and explorations.
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

test.describe('Context sharing', () => {
  test('share and unshare a context', async ({ api }) => {
    // Create context as user A
    const ctxRes = await api.post('api/graph-contexts', {
      data: {
        title: 'Shared Context',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
      },
    });
    const context = await ctxRes.json();
    const contextId = context.id;

    // Initially not shared
    expect(context.shared_with).toEqual([]);

    // Share with user B (read access)
    const shareRes = await api.post(`api/graph-contexts/${contextId}/share`, {
      data: { email: TEST_USER_B, permission: 'read' },
    });
    expect(shareRes.ok()).toBeTruthy();

    // Verify shared_with includes user B
    const afterShare = await (
      await api.get(`api/graph-contexts/${contextId}`)
    ).json();
    expect(afterShare.shared_with).toContain(TEST_USER_B);

    // Unshare
    const unshareRes = await api.delete(
      `api/graph-contexts/${contextId}/share/${TEST_USER_B}`
    );
    expect(unshareRes.ok()).toBeTruthy();

    // Verify shared_with is empty again
    const afterUnshare = await (
      await api.get(`api/graph-contexts/${contextId}`)
    ).json();
    expect(afterUnshare.shared_with).not.toContain(TEST_USER_B);
  });

  test('update share permission from read to write', async ({ api }) => {
    const ctxRes = await api.post('api/graph-contexts', {
      data: {
        title: 'Permission Test',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
      },
    });
    const contextId = (await ctxRes.json()).id;

    // Share as read
    await api.post(`api/graph-contexts/${contextId}/share`, {
      data: { email: TEST_USER_B, permission: 'read' },
    });

    // Update to write
    const updateShareRes = await api.post(
      `api/graph-contexts/${contextId}/share`,
      {
        data: { email: TEST_USER_B, permission: 'write' },
      }
    );
    expect(updateShareRes.ok()).toBeTruthy();

    // Verify user B still in shared_with
    const ctx = await (
      await api.get(`api/graph-contexts/${contextId}`)
    ).json();
    expect(ctx.shared_with).toContain(TEST_USER_B);
  });

  test('non-owner cannot share a context', async ({ api, playwright }) => {
    const ctxRes = await api.post('api/graph-contexts', {
      data: {
        title: 'Ownership Test',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
      },
    });
    const contextId = (await ctxRes.json()).id;

    // User B tries to share (not owner)
    const apiB = await apiAs(playwright, TEST_USER_B);
    const shareRes = await apiB.post(
      `api/graph-contexts/${contextId}/share`,
      {
        data: { email: 'other@test.com', permission: 'read' },
      }
    );
    // Might be 403 (no access) since B doesn't own and isn't shared with
    expect(shareRes.status()).toBeGreaterThanOrEqual(403);
    await apiB.dispose();
  });

  test('shared user can read context', async ({ api, playwright }) => {
    const ctxRes = await api.post('api/graph-contexts', {
      data: {
        title: 'Read Access Test',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
      },
    });
    const contextId = (await ctxRes.json()).id;

    // Share with user B
    await api.post(`api/graph-contexts/${contextId}/share`, {
      data: { email: TEST_USER_B, permission: 'read' },
    });

    // User B can read the context
    const apiB = await apiAs(playwright, TEST_USER_B);
    const getRes = await apiB.get(`api/graph-contexts/${contextId}`);
    expect(getRes.ok()).toBeTruthy();
    expect((await getRes.json()).title).toBe('Read Access Test');
    await apiB.dispose();
  });

  test('non-owner cannot delete context', async ({ api, playwright }) => {
    const ctxRes = await api.post('api/graph-contexts', {
      data: {
        title: 'Delete Protection',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
      },
    });
    const contextId = (await ctxRes.json()).id;

    // Share with user B (even with write access)
    await api.post(`api/graph-contexts/${contextId}/share`, {
      data: { email: TEST_USER_B, permission: 'write' },
    });

    // User B cannot delete
    const apiB = await apiAs(playwright, TEST_USER_B);
    const delRes = await apiB.delete(`api/graph-contexts/${contextId}`);
    expect(delRes.status()).toBe(403);
    await apiB.dispose();
  });
});

test.describe('Exploration sharing', () => {
  test('share and unshare an exploration', async ({ api }) => {
    // Create context
    const ctxRes = await api.post('api/graph-contexts', {
      data: {
        title: 'Exp Share Context',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
      },
    });
    const contextId = (await ctxRes.json()).id;

    // Create exploration
    const expRes = await api.post(
      `api/graph-contexts/${contextId}/explorations`,
      {
        data: {
          title: 'Shared Exploration',
          state: {
            nodes: [],
            edges: [],
            filters: { node_types: [], edge_types: [] },
            viewport: { zoom: 1, center_x: 0, center_y: 0 },
            layout_algorithm: 'force-atlas-2',
          },
        },
      }
    );
    const exploration = await expRes.json();
    const explorationId = exploration.id;

    // Initially not shared
    expect(exploration.shared_with).toEqual([]);

    // SHARE
    const shareRes = await api.post(
      `api/explorations/${explorationId}/share`,
      {
        data: { email: TEST_USER_B, permission: 'read' },
      }
    );
    expect(shareRes.ok()).toBeTruthy();

    // Verify shared_with
    const afterShare = await (
      await api.get(`api/explorations/${explorationId}`)
    ).json();
    expect(afterShare.shared_with).toContain(TEST_USER_B);

    // UNSHARE (new endpoint!)
    const unshareRes = await api.delete(
      `api/explorations/${explorationId}/share/${TEST_USER_B}`
    );
    expect(unshareRes.ok()).toBeTruthy();

    // Verify unshared
    const afterUnshare = await (
      await api.get(`api/explorations/${explorationId}`)
    ).json();
    expect(afterUnshare.shared_with).not.toContain(TEST_USER_B);
  });

  test('non-owner cannot share exploration', async ({ api, playwright }) => {
    const ctxRes = await api.post('api/graph-contexts', {
      data: {
        title: 'Exp Owner Test',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
      },
    });
    const contextId = (await ctxRes.json()).id;

    // Share context with user B so they have access
    await api.post(`api/graph-contexts/${contextId}/share`, {
      data: { email: TEST_USER_B, permission: 'write' },
    });

    const expRes = await api.post(
      `api/graph-contexts/${contextId}/explorations`,
      {
        data: {
          title: 'Owner Only Share',
          state: {
            nodes: [],
            edges: [],
            filters: { node_types: [], edge_types: [] },
            viewport: { zoom: 1, center_x: 0, center_y: 0 },
            layout_algorithm: 'force-atlas-2',
          },
        },
      }
    );
    const explorationId = (await expRes.json()).id;

    // User B tries to share (not owner of exploration)
    const apiB = await apiAs(playwright, TEST_USER_B);
    const shareRes = await apiB.post(
      `api/explorations/${explorationId}/share`,
      {
        data: { email: 'other@test.com', permission: 'read' },
      }
    );
    expect(shareRes.status()).toBe(403);
    await apiB.dispose();
  });

  test('non-owner cannot unshare exploration', async ({
    api,
    playwright,
  }) => {
    const ctxRes = await api.post('api/graph-contexts', {
      data: {
        title: 'Unshare Protection',
        edge_table_name: 'dev_catalog.graphs.edges_test',
        node_table_name: 'dev_catalog.graphs.nodes_test',
      },
    });
    const contextId = (await ctxRes.json()).id;

    await api.post(`api/graph-contexts/${contextId}/share`, {
      data: { email: TEST_USER_B, permission: 'write' },
    });

    const expRes = await api.post(
      `api/graph-contexts/${contextId}/explorations`,
      {
        data: {
          title: 'Protected Exploration',
          state: {
            nodes: [],
            edges: [],
            filters: { node_types: [], edge_types: [] },
            viewport: { zoom: 1, center_x: 0, center_y: 0 },
            layout_algorithm: 'force-atlas-2',
          },
        },
      }
    );
    const explorationId = (await expRes.json()).id;

    // Owner shares with user B
    await api.post(`api/explorations/${explorationId}/share`, {
      data: { email: TEST_USER_B, permission: 'read' },
    });

    // User B tries to unshare themselves (not owner)
    const apiB = await apiAs(playwright, TEST_USER_B);
    const unshareRes = await apiB.delete(
      `api/explorations/${explorationId}/share/${TEST_USER_B}`
    );
    expect(unshareRes.status()).toBe(403);
    await apiB.dispose();
  });
});
