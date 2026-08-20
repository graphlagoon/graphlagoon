/**
 * A REST-connection context, end to end.
 *
 * The journey: the picker offers the named connection with its own copy,
 * creating a context sends type + name and no tables, queries run in the
 * connection's language, and — for a query-only connection — the operations
 * it never declared stay hidden.
 */

import { test, expect } from '../fixtures/test-fixtures';
import {
  MOCK_GRAPH_RESPONSE,
  MOCK_REST_CONNECTION,
  MOCK_REST_CONTEXT,
} from '../fixtures/mock-data';
import {
  enableDatasources,
  mockNeptuneQueries,
  seedContexts,
} from '../helpers/api-mocks';

const QUERY_ONLY_CONNECTION = {
  ...MOCK_REST_CONNECTION,
  capabilities: {
    expand: false,
    subgraph: false,
    fetch_nodes: false,
    schema_discovery: false,
  },
};

test.describe('REST context creation', () => {
  test('the picker offers the connection with its own copy', async ({
    authenticatedPage: page,
  }) => {
    await enableDatasources(page, { sql_warehouse: true, neptune: false }, [
      MOCK_REST_CONNECTION,
    ]);

    await page.goto('/contexts');
    await page.getByTestId('create-context-btn').click();
    await expect(page.getByTestId('datasource-picker')).toBeVisible();

    const card = page.getByTestId('datasource-option-rest:fraud-api');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Fraud Graph Service');
    await expect(card).toContainText('Carries only the curated fraud subgraph.');
  });

  test('creating sends the connection name and no tables', async ({
    authenticatedPage: page,
  }) => {
    await enableDatasources(page, { sql_warehouse: true, neptune: false }, [
      MOCK_REST_CONNECTION,
    ]);

    let created: any = null;
    await page.route('**/graphlagoon/api/graph-contexts', (route) => {
      if (route.request().method() === 'POST') {
        created = JSON.parse(route.request().postData() || '{}');
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...MOCK_REST_CONTEXT, ...created }),
        });
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
    });

    await page.goto('/contexts');
    await page.getByTestId('create-context-btn').click();
    await page.getByTestId('datasource-option-rest:fraud-api').click();

    // The table half of the form is gone.
    await expect(page.getByRole('heading', { name: 'Edge Table Columns' })).toBeHidden();

    await page.locator('input[placeholder="My Graph Context"]').fill('My fraud graph');
    await page.getByTestId('create-context-submit').click();

    await expect.poll(() => created?.datasource_type).toBe('rest');
    expect(created.datasource_name).toBe('fraud-api');
    expect(created).not.toHaveProperty('edge_table_name');
    expect(created).not.toHaveProperty('node_table_name');
  });
});

test.describe('REST context listing', () => {
  test('shows the connection label as the badge', async ({
    authenticatedPage: page,
  }) => {
    await enableDatasources(page, { sql_warehouse: true, neptune: false }, [
      MOCK_REST_CONNECTION,
    ]);
    await seedContexts(page, [MOCK_REST_CONTEXT]);
    await page.goto('/contexts');

    const row = page.locator('.list-item', { hasText: 'Fraud REST Graph' });
    await expect(row.getByText('Fraud Graph Service')).toBeVisible();
    await expect(row.getByText('Operational · curated subgraph')).toBeVisible();
    // No stored table schema to drift.
    await expect(row.getByTestId('check-schema-btn')).toBeHidden();
  });
});

test.describe('Querying a REST context', () => {
  test('runs the connection query language directly', async ({
    authenticatedPage: page,
  }) => {
    await enableDatasources(page, { sql_warehouse: true, neptune: false }, [
      MOCK_REST_CONNECTION,
    ]);
    await seedContexts(page, [MOCK_REST_CONTEXT]);
    // Same wire contract as any native-Cypher backend: no transpiled SQL,
    // inline results.
    await mockNeptuneQueries(page, MOCK_GRAPH_RESPONSE);

    await page.goto(`/graph/${MOCK_REST_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('toolbar-query').click();

    // Direct run, labeled with the connection's language, no SQL affordances.
    await expect(page.getByTestId('graph-query-run')).toHaveText('Run Query');
    await expect(page.getByText('FraudQL', { exact: false })).toBeVisible();
    await expect(page.getByTestId('graph-query-mode-sql')).toBeHidden();
    await expect(page.getByTestId('graph-query-settings')).toBeHidden();

    await page.getByTestId('graph-query-run').click();
    await expect(page.getByTestId('graph-container')).toBeVisible();
  });

  test('a query-only connection hides expansion affordances', async ({
    authenticatedPage: page,
  }) => {
    await enableDatasources(page, { sql_warehouse: true, neptune: false }, [
      QUERY_ONLY_CONNECTION,
    ]);
    await seedContexts(page, [MOCK_REST_CONTEXT]);
    await mockNeptuneQueries(page, MOCK_GRAPH_RESPONSE);

    await page.goto(`/graph/${MOCK_REST_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    // Load a graph, select a node, open the side panel: the expand section
    // must not be offered.
    await page.getByTestId('toolbar-query').click();
    await page.getByTestId('graph-query-run').click();
    await expect(page.getByTestId('graph-container')).toBeVisible();

    await expect(page.getByText('Expand from Node')).toBeHidden();
  });
});
