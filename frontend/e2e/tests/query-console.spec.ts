import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts, mockTableQuery } from '../helpers/api-mocks';

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
});
