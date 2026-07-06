import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts, mockTableQuery, mockCancellableTableQuery, seedQueryTemplates } from '../helpers/api-mocks';

test.describe('Query Console', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
  });

  async function openGraph(page: any) {
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    // Wait for the context/graph to load (status bar appears once loaded).
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
  }

  test('toggle opens the console with editor controls', async ({ authenticatedPage: page }) => {
    await openGraph(page);

    await page.getByTestId('query-console-toggle').click();

    const console = page.getByTestId('query-console');
    await expect(console).toBeVisible();
    await expect(page.getByTestId('query-console-mode-cypher')).toBeVisible();
    await expect(page.getByTestId('query-console-mode-sql')).toBeVisible();
    await expect(page.getByTestId('query-console-run')).toBeVisible();
  });

  test('running a query populates the results grid', async ({ authenticatedPage: page }) => {
    await mockTableQuery(page, {
      columns: ['node_id', 'name'],
      rows: [
        ['n1', 'Alice'],
        ['n2', 'Bob'],
      ],
      transpiled_sql: 'SELECT node_id, name FROM nodes',
    });
    await openGraph(page);

    await page.getByTestId('query-console-toggle').click();
    await page.getByTestId('query-console-run').click();

    const grid = page.getByTestId('data-grid-table');
    await expect(grid).toBeVisible();
    // Column headers come from the raw column names.
    await expect(grid.getByText('node_id')).toBeVisible();
    await expect(grid.getByText('name')).toBeVisible();
    // Cell values render.
    await expect(grid.getByText('Alice')).toBeVisible();
    await expect(grid.getByText('Bob')).toBeVisible();
    // Footer row count.
    await expect(page.getByTestId('query-console')).toContainText('2 rows');
  });

  test('switching to SQL after a cypher run shows the real transpiled SQL, not stale text', async ({ authenticatedPage: page }) => {
    await mockTableQuery(page, {
      columns: ['node_id'],
      rows: [['n1']],
      transpiled_sql: 'SELECT node_id FROM cat.schema.nodes',
    });
    await openGraph(page);
    await page.getByTestId('query-console-toggle').click();

    // Switch to SQL mode first to see the default placeholder text...
    await page.getByTestId('query-console-mode-sql').click();
    const sqlBox = page.getByTestId('query-console-sql');
    await expect(sqlBox).toHaveValue(/SELECT \* FROM/);

    // ...then run a cypher query and confirm the SQL tab now reflects the
    // actual transpiled SQL instead of that stale placeholder.
    await page.getByTestId('query-console-mode-cypher').click();
    await page.getByTestId('query-console-run').click();
    await expect(page.getByTestId('data-grid-table')).toBeVisible();

    await page.getByTestId('query-console-mode-sql').click();
    await expect(sqlBox).toHaveValue('SELECT node_id FROM cat.schema.nodes');
  });

  test('opening the console collapses the edge data table', async ({ authenticatedPage: page }) => {
    await openGraph(page);

    // Open the edge Data Table first.
    await page.getByTitle('Data Table').click();
    await expect(page.locator('.data-table-drawer')).toBeVisible();

    // Opening the Query Console should collapse the Data Table (shared bottom region).
    await page.getByTestId('query-console-toggle').click();
    await expect(page.getByTestId('query-console')).toBeVisible();
    await expect(page.locator('.data-table-drawer')).toHaveCount(0);
  });

  test('shows an error message when the query fails', async ({ authenticatedPage: page }) => {
    await mockTableQuery(page, {
      status: 400,
      body: { detail: { error: { code: 'INVALID_SQL_QUERY', message: 'Only SELECT statements are allowed' } } },
    });
    await openGraph(page);

    await page.getByTestId('query-console-toggle').click();
    await page.getByTestId('query-console-run').click();

    await expect(page.getByTestId('query-console-error')).toBeVisible();
    await expect(page.getByTestId('query-console-error')).toContainText('Only SELECT statements are allowed');
  });

  test('footer shows row/column count and execution time', async ({ authenticatedPage: page }) => {
    await openGraph(page);
    await page.getByTestId('query-console-toggle').click();
    await page.getByTestId('query-console-run').click();

    const footer = page.getByTestId('query-console-footer');
    await expect(footer).toContainText('2 rows');
    await expect(footer).toContainText('2 cols');
    await expect(footer).toContainText('ms');
  });

  test('a long-running query exposes a Cancel button that stops execution', async ({ authenticatedPage: page }) => {
    const statementId = await mockCancellableTableQuery(page);
    await openGraph(page);

    await page.getByTestId('query-console-toggle').click();
    await page.getByTestId('query-console-run').click();

    // Submit returned "running" → the shared running state shows a Cancel
    // button (the table path is INLINE, so no chunk bar here).
    const cancelBtn = page.getByTestId('query-running-cancel');
    await expect(cancelBtn).toBeVisible();

    // Clicking Cancel hits the Databricks cancel endpoint and shows the notice.
    const cancelReq = page.waitForRequest((req) =>
      req.url().endsWith(`/query/table/${statementId}/cancel`) && req.method() === 'POST',
    );
    await cancelBtn.click();
    await cancelReq;

    await expect(page.getByTestId('query-console-canceled')).toBeVisible();
    await expect(page.getByTestId('query-console-loading')).toHaveCount(0);
  });

  test('node_id cells render as clickable graph links', async ({ authenticatedPage: page }) => {
    await openGraph(page);
    await page.getByTestId('query-console-toggle').click();
    await page.getByTestId('query-console-run').click();

    await expect(page.getByTestId('data-grid-table')).toBeVisible();
    // The 'node_id' column becomes a bridge to the 3D graph.
    const links = page.locator('.cell-node-link');
    await expect(links.first()).toBeVisible();
    await expect(links).toHaveCount(2);
    // Clicking must not throw (selects the node in the graph store).
    await links.first().click();
  });

  test('exposes CSV / Copy / Save actions once there are results', async ({ authenticatedPage: page }) => {
    await openGraph(page);
    await page.getByTestId('query-console-toggle').click();
    await page.getByTestId('query-console-run').click();
    await expect(page.getByTestId('data-grid-table')).toBeVisible();

    await expect(page.getByRole('button', { name: 'CSV' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Copy' })).toBeEnabled();
    await expect(page.getByTestId('query-console-save-template')).toBeEnabled();
  });

  test('error "Details" opens the full error modal', async ({ authenticatedPage: page }) => {
    await mockTableQuery(page, {
      status: 400,
      body: {
        detail: {
          error: {
            code: 'INVALID_SQL_QUERY',
            message: 'Only SELECT statements are allowed',
            details: { transpiled_sql: 'DROP TABLE x', traceback: ['frame 1', 'frame 2'] },
          },
        },
      },
    });
    await openGraph(page);
    await page.getByTestId('query-console-toggle').click();
    await page.getByTestId('query-console-run').click();

    await page.getByTestId('query-console-error-details').click();
    // QueryErrorModal (Teleported to body) shows the code + a stack-trace toggle.
    await expect(page.getByText('Query Execution Error')).toBeVisible();
    await expect(page.locator('code.detail-value', { hasText: 'INVALID_SQL_QUERY' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Stack Trace/ })).toBeVisible();
  });

  test('Save as template opens the editor seeded with the console query', async ({ authenticatedPage: page }) => {
    await openGraph(page);
    await page.getByTestId('query-console-toggle').click();
    await page.getByTestId('query-console-save-template').click();

    await expect(page.getByRole('heading', { name: 'New Template' })).toBeVisible();
    // No Graph/Table split at save time — that's chosen when the template runs.
    await expect(page.locator('input[type=radio][value="table"]')).toHaveCount(0);
  });

  test('a template runs as Graph by default (no console involved)', async ({ authenticatedPage: page }) => {
    await seedQueryTemplates(page, MOCK_CONTEXT.id, [
      {
        id: 't1',
        graph_context_id: MOCK_CONTEXT.id,
        owner_email: 'someone@example.com',
        name: 'BFS query',
        description: '',
        query_type: 'cypher',
        query: 'MATCH (n) RETURN n',
        parameters: [],
        options: { procedural_bfs: false, large_results_mode: false },
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);
    await openGraph(page);

    await page.getByTitle('Query Templates').click();
    await page.getByRole('button', { name: 'Use', exact: true }).click();
    // "Run as" defaults to Graph — execute without touching the selector.
    await expect(page.locator('input[type=radio][value="graph"]')).toBeChecked();
    await page.getByRole('button', { name: 'Execute', exact: true }).click();

    await expect(page.getByTestId('query-console')).toHaveCount(0);
  });

  test('picking Table when running a template opens the console with results', async ({ authenticatedPage: page }) => {
    await seedQueryTemplates(page, MOCK_CONTEXT.id, [
      {
        id: 't1',
        graph_context_id: MOCK_CONTEXT.id,
        owner_email: 'someone@example.com',
        name: 'Table query',
        description: '',
        query_type: 'cypher',
        query: 'MATCH (n) RETURN n.node_id',
        parameters: [],
        options: { procedural_bfs: false, large_results_mode: false },
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);
    await openGraph(page);

    await page.getByTitle('Query Templates').click();
    await page.getByRole('button', { name: 'Use', exact: true }).click();
    await page.locator('.execute-modal').locator('input[type=radio][value="table"]').check();
    await page.getByRole('button', { name: 'Execute', exact: true }).click();

    await expect(page.getByTestId('query-console')).toBeVisible();
    await expect(page.getByTestId('data-grid-table')).toBeVisible();
  });

  test('gear opens the shared transpile settings modal', async ({ authenticatedPage: page }) => {
    await openGraph(page);

    await page.getByTestId('query-console-toggle').click();
    await expect(page.getByTestId('query-console')).toBeVisible();

    await page.getByTestId('query-console-settings').click();
    await expect(page.getByTestId('transpile-settings-modal')).toBeVisible();
    // The "Large results mode" toggle (a non-transpiler option) is always present.
    await expect(page.getByTestId('opt-large-results')).toBeVisible();

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('transpile-settings-modal')).toHaveCount(0);
  });
});
