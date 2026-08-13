/**
 * A native graph database (Amazon Neptune) context, end to end.
 *
 * The journey a user actually takes — create a context with no tables, open it,
 * run openCypher, read a table projection — plus the absences that make it
 * coherent: no SQL tab, no transpile settings, no schema-drift check.
 */

import { test, expect } from '../fixtures/test-fixtures';
import {
  MOCK_CONTEXT,
  MOCK_GRAPH_RESPONSE,
  MOCK_NEPTUNE_CONTEXT,
} from '../fixtures/mock-data';
import {
  enableDatasources,
  mockNeptuneQueries,
  seedContexts,
} from '../helpers/api-mocks';

test.describe('Neptune context creation', () => {
  test('the datasource picker appears only when the server serves more than one', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/contexts');
    await page.getByTestId('create-context-btn').click();

    // Default config advertises the warehouse only — nothing to pick between.
    await expect(page.getByTestId('datasource-picker')).toBeHidden();
  });

  test('a Neptune context is created without any table configuration', async ({
    authenticatedPage: page,
  }) => {
    await enableDatasources(page, { sql_warehouse: true, neptune: true });

    let created: any = null;
    await page.route('**/graphlagoon/api/graph-contexts', (route) => {
      if (route.request().method() === 'POST') {
        created = JSON.parse(route.request().postData() || '{}');
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...MOCK_NEPTUNE_CONTEXT, ...created }),
        });
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
    });

    await page.goto('/contexts');
    await page.getByTestId('create-context-btn').click();
    await expect(page.getByTestId('datasource-picker')).toBeVisible();

    await page.getByTestId('datasource-option-neptune').click();

    // The table half of the form is gone.
    await expect(page.getByRole('heading', { name: 'Edge Table Columns' })).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Node Table Columns' })).toBeHidden();
    // Types remain — every datasource has them.
    await expect(page.getByRole('heading', { name: 'Schema Types' })).toBeVisible();

    await page.locator('input[placeholder="My Graph Context"]').fill('My Neptune graph');
    await page.getByTestId('create-context-submit').click();

    await expect.poll(() => created?.datasource_type).toBe('neptune');
    expect(created).not.toHaveProperty('edge_table_name');
    expect(created).not.toHaveProperty('node_table_name');
  });
});

test.describe('Neptune context listing', () => {
  test('shows a datasource badge instead of table names', async ({
    authenticatedPage: page,
  }) => {
    await seedContexts(page, [MOCK_CONTEXT, MOCK_NEPTUNE_CONTEXT]);
    await page.goto('/contexts');

    const neptuneRow = page.locator('.list-item', { hasText: 'Neptune Graph' });
    await expect(neptuneRow.getByText('Amazon Neptune')).toBeVisible();
    await expect(neptuneRow.getByText('Operational (OLTP) · low latency')).toBeVisible();

    // The warehouse row still shows its tables.
    const warehouseRow = page.locator('.list-item', { hasText: 'Test Context' });
    await expect(warehouseRow.getByText('test_db.edges')).toBeVisible();
  });

  test('offers no schema check — there is no stored schema to drift', async ({
    authenticatedPage: page,
  }) => {
    await seedContexts(page, [MOCK_CONTEXT, MOCK_NEPTUNE_CONTEXT]);
    await page.goto('/contexts');

    const neptuneRow = page.locator('.list-item', { hasText: 'Neptune Graph' });
    await expect(neptuneRow.getByTestId('check-schema-btn')).toBeHidden();

    const warehouseRow = page.locator('.list-item', { hasText: 'Test Context' });
    await expect(warehouseRow.getByTestId('check-schema-btn')).toBeVisible();
  });
});

test.describe('Querying a Neptune context', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_NEPTUNE_CONTEXT]);
    await mockNeptuneQueries(page, MOCK_GRAPH_RESPONSE);
  });

  test('runs openCypher and renders the result', async ({ authenticatedPage: page }) => {
    await page.goto(`/graph/${MOCK_NEPTUNE_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('toolbar-query').click();
    // Always a direct run: the transpile review step does not exist here.
    await expect(page.getByTestId('graph-query-run')).toHaveText('Run Query');

    await page.getByTestId('graph-query-run').click();
    await expect(page.getByTestId('graph-container')).toBeVisible();
    // The status bar reports the loaded graph once the query lands.
    await expect(page.getByTestId('graph-status-bar')).toBeVisible();
  });

  test('hides every SQL-only affordance', async ({ authenticatedPage: page }) => {
    await page.goto(`/graph/${MOCK_NEPTUNE_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('toolbar-query').click();
    await expect(page.getByTestId('graph-query-run')).toBeVisible();

    await expect(page.getByTestId('graph-query-mode-sql')).toBeHidden();
    await expect(page.getByTestId('graph-query-settings')).toBeHidden();
    await expect(page.getByText('Pre-filter edges (CTE)')).toBeHidden();
    await expect(page.getByText('Trust transpiled SQL')).toBeHidden();
  });

  test('the query console runs openCypher only', async ({ authenticatedPage: page }) => {
    await page.goto(`/graph/${MOCK_NEPTUNE_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('query-console-toggle').click();
    await expect(page.getByTestId('query-console')).toBeVisible();

    await expect(page.getByTestId('query-console-mode-sql')).toBeHidden();
    await expect(page.getByTestId('query-console-settings')).toBeHidden();

    await page.getByTestId('query-console-run').click();
    await expect(page.getByText('Alice')).toBeVisible();
  });
});
