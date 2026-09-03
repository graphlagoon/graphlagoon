import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT, MOCK_CONTEXT_NO_AUTOLOAD, MOCK_EXPLORATION } from '../fixtures/mock-data';
import { seedContexts, seedExplorations, mockCancellableGraphJob, seedQueryTemplates } from '../helpers/api-mocks';

test.describe('Graph Visualization', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
  });

  // ---------------------------------------------------------------------------
  // Cancellable graph query with chunk progress (graph overlay)
  // ---------------------------------------------------------------------------
  test.describe('Query overlay: cancel + chunk progress', () => {
    test('running a graph query shows chunk progress + a Cancel button that stops it', async ({ authenticatedPage: page }) => {
      const jobId = await mockCancellableGraphJob(page);
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

      // Open the Query panel, switch to SQL (plain textarea), enter a query, run.
      await page.getByTestId('toolbar-query').click();
      await page.getByTestId('graph-query-mode-sql').click();
      await page.getByTestId('graph-query-sql').fill('SELECT * FROM edges');
      await page.getByTestId('graph-query-run').click();

      // The graph overlay shows the shared running state with a chunk progress
      // bar (percentage + loaded/total) and a Cancel button.
      const running = page.getByTestId('query-running');
      await expect(running).toBeVisible();
      await expect(page.getByTestId('query-running-chunks')).toBeVisible();
      await expect(page.getByTestId('query-running-count')).toContainText('/4 chunks');
      await expect(page.getByTestId('query-running-pct')).toContainText('%');

      const cancelBtn = page.getByTestId('query-running-cancel');
      await expect(cancelBtn).toBeVisible();

      // Perform a REAL click (not dispatchEvent). A real click exercises
      // Playwright's pointer-events/hit-test actionability check, so it fails if
      // the loading overlay is `pointer-events: none` — the exact regression
      // that made the Cancel button unclickable for users.
      const cancelReq = page.waitForRequest((req) =>
        req.url().endsWith(`/query/job/${jobId}/cancel`) && req.method() === 'POST',
      );
      await cancelBtn.click();
      await cancelReq;
      await expect(page.getByTestId('graph-loading')).toHaveCount(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Graph loading
  // ---------------------------------------------------------------------------
  test.describe('Graph loading', () => {
    test('shows node and edge counts in status bar', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);

      const statusBar = page.getByTestId('graph-status-bar');
      await expect(statusBar).toBeVisible({ timeout: 15_000 });
      await expect(statusBar).toContainText('5 nodes');
      await expect(statusBar).toContainText('6 edges');
    });

    test('a context without autoLoadOnOpen opens empty and fetches nothing', async ({ authenticatedPage: page }) => {
      await seedContexts(page, [MOCK_CONTEXT_NO_AUTOLOAD]);

      // Watch for the implicit fetch we are supposed to have suppressed.
      let subgraphRequested = false;
      page.on('request', (req) => {
        if (req.url().includes('/subgraph')) subgraphRequested = true;
      });

      await page.goto(`/graph/${MOCK_CONTEXT_NO_AUTOLOAD.id}`);

      const statusBar = page.getByTestId('graph-status-bar');
      await expect(statusBar).toBeVisible({ timeout: 15_000 });
      await expect(statusBar).toContainText('0 nodes');
      await expect(statusBar).toContainText('0 edges');

      // The empty state guides the user to run a query.
      await expect(page.getByText('No nodes to display')).toBeVisible();

      expect(subgraphRequested).toBe(false);
    });

    test('shows context title in toolbar', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTestId('toolbar-context-title')).toHaveText('Test Context', { timeout: 15_000 });
    });

    test('graph container is visible', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTestId('graph-container')).toBeVisible();
    });

    test('shows error when API fails', async ({ authenticatedPage: page }) => {
      // Override the subgraph route to return 500
      await page.route('**/graphlagoon/api/graph-contexts/*/subgraph', (route) => {
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Internal server error' }),
        });
      });

      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      // When API fails, the status bar should NOT show node/edge counts
      // (graph didn't load), and an error overlay or message should appear
      const errorOverlay = page.locator('.error-overlay, .error-message');
      await expect(errorOverlay.first()).toBeVisible({ timeout: 15_000 });
    });
  });

  // ---------------------------------------------------------------------------
  // Toolbar buttons
  // ---------------------------------------------------------------------------
  test.describe('Toolbar buttons', () => {
    test('all panel buttons are visible after graph loads', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      // Wait for loading to finish
      await expect(page.getByTitle('Filters', { exact: true })).toBeVisible({ timeout: 15_000 });

      // All panel buttons + Load button
      await expect(page.getByTitle('Behaviors')).toBeVisible();
      await expect(page.getByTitle('Query', { exact: true })).toBeVisible();
      await expect(page.getByTitle('Query Templates')).toBeVisible();
      await expect(page.getByTitle('Metrics')).toBeVisible();
      await expect(page.getByTitle('Style')).toBeVisible();
      await expect(page.getByTitle('Labels')).toBeVisible();
      await expect(page.getByTitle('Clusters')).toBeVisible();
      await expect(page.getByTitle('Load Exploration')).toBeVisible();
    });
  });

  // ---------------------------------------------------------------------------
  // Panel content — verifies each panel opens with meaningful content
  // ---------------------------------------------------------------------------
  test.describe('Panel content', () => {
    test('Filters panel shows node types and edge types from graph data', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTitle('Filters', { exact: true })).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Filters', { exact: true }).click();
      await expect(page.getByText('Node Types')).toBeVisible();
      // Mock data has Person and Company node types
      await expect(page.getByText('Person')).toBeVisible();
      await expect(page.getByText('Company')).toBeVisible();
      await expect(page.getByText('Edge Types')).toBeVisible();

      // Close
      await page.getByTitle('Filters', { exact: true }).click();
      await expect(page.getByText('Node Types')).not.toBeVisible();
    });

    test('Behaviors panel shows behavior settings', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTitle('Behaviors')).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Behaviors').click();
      await expect(page.getByText('Graph Lens')).toBeVisible();
      await expect(page.getByText('Degree Dimming')).toBeVisible();

      await page.getByTitle('Behaviors').click();
      await expect(page.getByText('Graph Lens')).not.toBeVisible();
    });

    test('Query panel shows query editor with mode toggle', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTitle('Query', { exact: true })).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Query', { exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Query', exact: true })).toBeVisible();
      // Mode toggle buttons
      await expect(page.getByRole('button', { name: 'OpenCypher' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'SQL' })).toBeVisible();

      await page.getByTitle('Query', { exact: true }).click();
    });

    test('Metrics panel shows compute and mapping tabs', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTitle('Metrics')).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Metrics').click();
      await expect(page.getByRole('heading', { name: 'Metrics', exact: true })).toBeVisible();
      await expect(page.getByText('Visual Mapping')).toBeVisible();

      await page.getByTitle('Metrics').click();
    });

    test('metric checkbox adds and removes a Data Table column', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTitle('Metrics')).toBeVisible({ timeout: 15_000 });

      // The built-in Degree metric always exists once the graph has edges, and
      // its id is stable — flag it as a Data Table column.
      await page.getByTitle('Metrics').click();
      const toggle = page.getByTestId('metric-table-toggle-__builtin_degree');
      await expect(toggle).toBeVisible();
      await toggle.check();

      // The Nodes tab of the drawer now carries a numeric Degree column.
      await page.getByTitle('Data Table').click();
      const drawer = page.locator('.data-table-drawer');
      await expect(drawer.locator('th', { hasText: 'Degree' })).toBeVisible();

      // Unchecking removes the column again.
      await toggle.uncheck();
      await expect(drawer.locator('th', { hasText: 'Degree' })).toHaveCount(0);
    });

    test('mapping tab offers color-by-metric with the built-in Degree metric', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTitle('Metrics')).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Metrics').click();
      await page.getByText('Visual Mapping').click();

      const colorSelect = page.getByTestId('node-color-metric-select');
      await expect(colorSelect).toBeVisible();
      // Off by default; picking the built-in degree metric turns it on and
      // reveals the gradient controls.
      await colorSelect.selectOption('__builtin_degree');
      await expect(colorSelect).toHaveValue('__builtin_degree');
      await expect(page.getByTestId('node-color-min')).toBeVisible();
      await expect(page.getByTestId('node-color-max')).toBeVisible();
    });

    test('Query Templates panel shows template controls', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTitle('Query Templates')).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Query Templates').click();
      await expect(page.locator('h3', { hasText: 'Query Templates' })).toBeVisible();

      await page.getByTitle('Query Templates').click();
    });

    test('Query Templates panel groups private and shared templates', async ({ authenticatedPage: page }) => {
      await seedQueryTemplates(page, MOCK_CONTEXT.id, [
        {
          id: 'tpl-private',
          graph_context_id: MOCK_CONTEXT.id,
          owner_email: 'e2e@test.com',
          name: 'My private query',
          description: '',
          query_type: 'cypher',
          query: 'MATCH (n) RETURN n',
          parameters: [],
          options: { procedural_bfs: false, large_results_mode: false },
          visibility: 'private',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 'tpl-shared',
          graph_context_id: MOCK_CONTEXT.id,
          owner_email: 'someone@example.com',
          name: 'Team query',
          description: '',
          query_type: 'sql',
          query: 'SELECT 1',
          parameters: [],
          options: { procedural_bfs: false, large_results_mode: false },
          visibility: 'shared',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ]);
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTitle('Query Templates')).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Query Templates').click();
      await expect(page.getByRole('heading', { name: 'My templates' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Shared templates' })).toBeVisible();
      await expect(page.getByText('My private query')).toBeVisible();
      await expect(page.getByText('Team query')).toBeVisible();

      await page.getByTitle('Query Templates').click();
    });

    test('Style panel shows visual controls for nodes and edges', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTitle('Style')).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Style').click();
      // "Edges" and "Nodes" as h5 headings inside the panel (avoid matching status bar "6 edges")
      await expect(page.getByRole('heading', { name: 'Edges' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Nodes' })).toBeVisible();

      await page.getByTitle('Style').click();
    });

    test('Labels panel shows template settings', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTitle('Labels')).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Labels').click();
      // exact: the Custom Rules hint mentions "default templates" too
      await expect(page.getByText('Default Templates', { exact: true })).toBeVisible();
      // "Custom Rules" exact to avoid matching "No custom rules defined..."
      await expect(page.getByText('Custom Rules', { exact: true })).toBeVisible();

      await page.getByTitle('Labels').click();
    });

    test('Clusters panel opens and closes', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTitle('Clusters')).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Clusters').click();
      await expect(page.getByRole('button', { name: 'Communities' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Programs' })).toBeVisible();

      await page.getByTitle('Clusters').click();
    });
  });

  // ---------------------------------------------------------------------------
  // Clusters
  // ---------------------------------------------------------------------------
  test.describe('Clusters', () => {
    test('a program run lands in the Results tab, reachable from the status bar', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

      // No clusters yet: nothing claims there are.
      await expect(page.getByTestId('graph-status-clusters')).toHaveCount(0);

      await page.getByTitle('Clusters', { exact: true }).click();
      await page.getByRole('button', { name: 'Programs' }).click();
      // Group by Node Type always produces clusters; Orphan Clusters would not
      // on this fixture graph.
      await page.getByTestId('cluster-program-run-default-group-by-node-type').click();

      // The clusters produced live in this panel's Results tab — they used to
      // be a separate floating panel with its own toolbar button.
      const chip = page.getByTestId('graph-status-clusters');
      await expect(chip).toBeVisible({ timeout: 15_000 });

      await page.getByTestId('clusters-tab-results').click();
      await expect(page.getByTestId('clusters-results-pane')).toBeVisible();

      // The status-bar count opens that same tab.
      await page.getByRole('button', { name: 'Communities' }).click();
      await chip.click();
      await expect(page.getByTestId('clusters-results-pane')).toBeVisible();
    });

    test('deleting a cluster is undoable instead of asking first', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Clusters', { exact: true }).click();
      await page.getByRole('button', { name: 'Programs' }).click();
      await page.getByTestId('cluster-program-run-default-group-by-node-type').click();
      await page.getByTestId('clusters-tab-results').click();

      const chip = page.getByTestId('graph-status-clusters');
      await expect(chip).toBeVisible({ timeout: 15_000 });
      const before = (await chip.textContent())!.trim();

      // No confirmation for client-side state the app can put back.
      await page.getByRole('button', { name: /^Delete cluster/ }).first().click();
      await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
      await expect(chip).not.toHaveText(before);

      await page.getByTestId('toast-action-undo').click();
      await expect(chip).toHaveText(before);
    });
  });

  // ---------------------------------------------------------------------------
  // Panels
  // ---------------------------------------------------------------------------
  test.describe('Panel chrome', () => {
    test('the Layout panel closes from its own header', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

      await page.getByTestId('graph-toolbar-layout').click();
      const closeBtn = page.getByTestId('layout-panel-close');
      // It was the only panel in the app without a close button.
      await expect(closeBtn).toBeVisible();
      await closeBtn.click();
      await expect(closeBtn).toHaveCount(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Save state
  // ---------------------------------------------------------------------------
  test.describe('Save state', () => {
    test('an opened exploration flags unsaved changes once the view moves', async ({ authenticatedPage: page }) => {
      await seedExplorations(page, [MOCK_EXPLORATION]);
      await page.goto(`/graph/${MOCK_CONTEXT.id}?exploration=${MOCK_EXPLORATION.id}`);
      await expect(page.getByTestId('toolbar-exploration-name')).toContainText('Test Exploration', {
        timeout: 15_000,
      });
      // Freshly loaded: the view still matches what was saved.
      await expect(page.getByTestId('toolbar-exploration-dirty')).toHaveCount(0);

      // Change something the exploration stores, via the UI.
      await page.getByTitle('Filters', { exact: true }).click();
      await page.locator('.filter-panel input[type="checkbox"]').first().uncheck();

      await expect(page.getByTestId('toolbar-exploration-dirty')).toBeVisible();
      await expect(page.getByTestId('toolbar-exploration-name')).toHaveAttribute(
        'title',
        /unsaved changes/,
      );
    });

    test('the Unsaved marker is the control that saves the view', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

      // It used to be inert text, with the only Save button in another group
      // at the far end of the toolbar.
      await page.getByTestId('toolbar-exploration-unsaved').click();
      await expect(page.getByRole('heading', { name: 'Save Exploration' })).toBeVisible();
    });
  });

  // ---------------------------------------------------------------------------
  // Load exploration from graph page
  // ---------------------------------------------------------------------------
  test.describe('Load exploration', () => {
    test('Load button opens modal showing saved explorations', async ({ authenticatedPage: page }) => {
      // Seed an exploration via API mock
      await seedExplorations(page, [MOCK_EXPLORATION]);

      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTitle('Load Exploration')).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Load Exploration').click();
      await expect(page.getByText('Load Exploration')).toBeVisible();
      await expect(page.getByText('Test Exploration')).toBeVisible();
    });

    test('Load button shows empty state when no explorations exist', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTitle('Load Exploration')).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Load Exploration').click();
      await expect(page.getByText('No saved explorations')).toBeVisible();
    });
  });

  // ---------------------------------------------------------------------------
  // Advanced transpile & optimization settings modal (shared with Query Console)
  // ---------------------------------------------------------------------------
  test.describe('Transpile settings modal', () => {
    async function openQueryPanel(page: any) {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('toolbar-query').click();
      await expect(page.getByRole('heading', { name: 'Query', exact: true })).toBeVisible();
    }

    test('options live in a modal, not inline in the side panel', async ({ authenticatedPage: page }) => {
      await openQueryPanel(page);

      // The gear entry point exists...
      await expect(page.getByTestId('graph-query-settings')).toBeVisible();
      // ...and the transpile options are NOT rendered inline (they only exist
      // inside the modal, which is closed on load). Regression guard for the
      // "options still show in the side panel, no modal" report.
      await expect(page.getByTestId('transpile-settings-modal')).toHaveCount(0);
      await expect(page.getByTestId('opt-procedural-bfs')).toHaveCount(0);
    });

    test('gear opens the modal and shows per-optimization flags (procedural on by default)', async ({ authenticatedPage: page }) => {
      await openQueryPanel(page);

      await page.getByTestId('graph-query-settings').click();
      const modal = page.getByTestId('transpile-settings-modal');
      await expect(modal).toBeVisible();

      // Procedural BFS is enabled by default → the per-optimization flags render.
      await expect(page.getByTestId('opt-procedural-bfs')).toBeChecked();
      await expect(page.getByTestId('opt-visited_not_exists')).toBeVisible();
      await expect(page.getByTestId('opt-undirected_union_all')).toBeVisible();

      // Toggling Procedural BFS off hides the flags.
      await page.getByTestId('opt-procedural-bfs').click();
      await expect(page.getByTestId('opt-visited_not_exists')).toHaveCount(0);
    });

    test('enforces mutual exclusivity of the undirected strategies', async ({ authenticatedPage: page }) => {
      await openQueryPanel(page);
      await page.getByTestId('graph-query-settings').click();

      // Procedural on by default: doubled_adjacency ON, union_all OFF.
      await expect(page.getByTestId('opt-undirected_doubled_adjacency')).toBeChecked();
      await page.getByTestId('opt-undirected_union_all').click();
      await expect(page.getByTestId('opt-undirected_union_all')).toBeChecked();
      await expect(page.getByTestId('opt-undirected_doubled_adjacency')).not.toBeChecked();
    });

    test('disables out-of-scope flags per materialization strategy', async ({ authenticatedPage: page }) => {
      await openQueryPanel(page);
      await page.getByTestId('graph-query-settings').click();

      // numbered_views: temp_tables-only flags disabled, numbered_views-only enabled.
      await page.getByTestId('opt-materialization').selectOption('numbered_views');
      await expect(page.getByTestId('opt-deferred_edge_payload')).toBeDisabled();
      await expect(page.getByTestId('opt-barrier_precompute')).toBeDisabled();
      await expect(page.getByTestId('opt-loop_control_into')).toBeEnabled();

      // temp_tables: the scope flips.
      await page.getByTestId('opt-materialization').selectOption('temp_tables');
      await expect(page.getByTestId('opt-loop_control_into')).toBeDisabled();
      await expect(page.getByTestId('opt-deferred_edge_payload')).toBeEnabled();
    });

    test('gear reopens the modal after closing', async ({ authenticatedPage: page }) => {
      await openQueryPanel(page);
      await page.getByTestId('graph-query-settings').click();
      await expect(page.getByTestId('transpile-settings-modal')).toBeVisible();

      await page.getByRole('button', { name: 'Done' }).click();
      await expect(page.getByTestId('transpile-settings-modal')).toHaveCount(0);

      await page.getByTestId('graph-query-settings').click();
      await expect(page.getByTestId('transpile-settings-modal')).toBeVisible();
    });
  });
});
