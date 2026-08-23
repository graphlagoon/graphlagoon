/**
 * Cross-flow user journey tests.
 *
 * These tests validate complete workflows that span multiple pages,
 * simulating what a real user would do in a typical session.
 * A PM can read these test names and understand what user flows are covered.
 */
import { test, superuserTest, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT, MOCK_EXPLORATION } from '../fixtures/mock-data';
import { seedContexts, seedExplorations, mockSchemaDrift, seedPrecomputedGraphs } from '../helpers/api-mocks';

test.describe('User Journeys', () => {
  // ---------------------------------------------------------------------------
  // Journey: Contexts → Graph
  // ---------------------------------------------------------------------------
  test('user opens a context and sees the graph load with correct data', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);

    // Start at contexts page
    await page.goto('/contexts');
    await expect(page.getByText('Test Context')).toBeVisible();

    // Click Open button to navigate to graph
    await page.getByRole('button', { name: 'Open' }).click();
    await page.waitForURL(`**/graph/${MOCK_CONTEXT.id}`);

    // Verify graph loaded with correct data
    const statusBar = page.getByTestId('graph-status-bar');
    await expect(statusBar).toBeVisible({ timeout: 15_000 });
    await expect(statusBar).toContainText('5 nodes');
    await expect(statusBar).toContainText('6 edges');

    // Verify context title shows in toolbar
    await expect(page.getByTestId('toolbar-context-title')).toHaveText('Test Context');

    // Verify toolbar panels are available
    await expect(page.getByTitle('Filters', { exact: true })).toBeVisible();
    await expect(page.getByTitle('Query', { exact: true })).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Journey: Explorations → Graph
  // ---------------------------------------------------------------------------
  test('user opens an exploration from the list and lands on graph', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedExplorations(page, [MOCK_EXPLORATION]);

    // Start at explorations page
    await page.goto('/explorations');
    await expect(page.getByText('Test Exploration')).toBeVisible();

    // Open the exploration
    await page.getByRole('button', { name: 'Open' }).click();
    await page.waitForURL(`**/graph/${MOCK_CONTEXT.id}**`);

    // Verify graph page loaded
    await expect(page.getByTestId('graph-container')).toBeVisible();
    await expect(page.getByTestId('toolbar-context-title')).toHaveText('Test Context', { timeout: 15_000 });
  });

  // ---------------------------------------------------------------------------
  // Journey: Navigate between all main pages
  // ---------------------------------------------------------------------------
  test('user navigates through all main pages via toolbar', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);

    // Start at contexts
    await page.goto('/contexts');
    await expect(page.getByRole('heading', { level: 1, name: 'Graph Contexts' })).toBeVisible();

    // Go to explorations
    await page.getByTestId('nav-explorations').click();
    await page.waitForURL('**/explorations');
    await expect(page.getByRole('heading', { level: 1, name: 'Explorations' })).toBeVisible();

    // Go to DEV
    await page.getByTestId('nav-dev').click();
    await page.waitForURL('**/dev/generator');

    // Go to contexts, open graph
    await page.getByTestId('nav-contexts').click();
    await page.waitForURL('**/contexts');
    await page.getByRole('button', { name: 'Open' }).click();
    await page.waitForURL(`**/graph/${MOCK_CONTEXT.id}`);

    // Graph toolbar appears
    await expect(page.getByTitle('Filters', { exact: true })).toBeVisible({ timeout: 15_000 });

    // Navigate back to contexts from graph
    await page.getByTestId('nav-contexts').click();
    await page.waitForURL('**/contexts');
    await expect(page.getByRole('heading', { level: 1, name: 'Graph Contexts' })).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Journey: Graph → open panels → verify data
  // ---------------------------------------------------------------------------
  test('user opens graph and inspects data through multiple panels', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTitle('Filters', { exact: true })).toBeVisible({ timeout: 15_000 });

    // Open Filters — verify node types from data
    await page.getByTitle('Filters', { exact: true }).click();
    await expect(page.getByText('Person')).toBeVisible();
    await expect(page.getByText('Company')).toBeVisible();
    await page.getByTitle('Filters', { exact: true }).click();

    // Open Query — verify editor is available
    await page.getByTitle('Query', { exact: true }).click();
    await expect(page.getByText('Graph Query')).toBeVisible();
    await page.getByTitle('Query', { exact: true }).click();

    // Open Metrics — verify compute controls
    await page.getByTitle('Metrics').click();
    await expect(page.getByText('Graph Metrics')).toBeVisible();
    await page.getByTitle('Metrics').click();
  });

  // ---------------------------------------------------------------------------
  // Journey: Contexts → check schema → review & resync → Graph loads clean
  // ---------------------------------------------------------------------------
  test('user finds and fixes a stale context schema, then the graph loads', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await mockSchemaDrift(page, MOCK_CONTEXT.id, {
      context_id: MOCK_CONTEXT.id,
      checked_at: '2026-08-11T00:00:00Z',
      status: 'error',
      types_checked: true,
      counts: { error: 1, warning: 0, info: 0 },
      node_table: { table_name: MOCK_CONTEXT.node_table_name, reachable: true, columns: [] },
      edge_table: { table_name: MOCK_CONTEXT.edge_table_name, reachable: true, columns: [] },
      findings: [
        {
          code: 'PROPERTY_COLUMN_MISSING',
          severity: 'error',
          side: 'node',
          kind: 'property',
          name: 'legacy_score',
          message: 'Node property column `legacy_score` no longer exists.',
          stored: { data_type: 'string' },
          live: null,
          auto_fixable: true,
        },
      ],
      proposed: {
        node_properties: [{ name: 'name', data_type: 'string' }],
        edge_properties: [],
        node_types: null,
        relationship_types: null,
      },
    });

    // Start at contexts, notice drift, review and apply the fix
    await page.goto('/contexts');
    await page.getByTestId('check-schema-btn').click();
    await expect(page.getByTestId('schema-drift-banner')).toContainText('1 error');

    await page.getByTestId('schema-drift-review-btn').click();
    await expect(page.getByTestId('schema-drift-modal')).toContainText('legacy_score');
    await page.getByTestId('schema-drift-apply').click();
    await expect(page.getByTestId('schema-drift-modal')).not.toBeVisible();

    // Then continue on to open the graph — the fixed context loads normally
    await page.getByRole('button', { name: 'Open' }).click();
    await page.waitForURL(`**/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// Journey: Graph → publish it → share its link → open it fresh
// ---------------------------------------------------------------------------
// A separate describe block: Playwright requires every test in one describe
// to share the same test object, and this journey needs the superuser fixture
// — publishing a precomputed graph, unlike a style preset, is restricted to superusers
// (GRAPH_LAGOON_SUPERUSER_EMAILS).
superuserTest.describe('User Journeys (superuser)', () => {
  superuserTest('user publishes the current graph and reopens it from its own link', async ({ superuserPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {});

    // Open the context normally — a live graph, not a published one yet.
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    const statusBar = page.getByTestId('graph-status-bar');
    await expect(statusBar).toBeVisible({ timeout: 15_000 });
    await expect(statusBar).toContainText('5 nodes');
    await expect(page.getByTestId('graph-status-precomputed')).toHaveCount(0);

    // Publish it under a name.
    await page.getByTestId('toolbar-precomputed').click();
    await page.getByTestId('precomputed-graph-name-input').fill('investigacao-agosto');
    await page.getByTestId('precomputed-graph-save-button').click();
    // The panel hands back the link at publish time — nothing lists them later.
    await expect(page.getByTestId('precomputed-graph-last-saved')).toContainText(
      '?precomputed=investigacao-agosto',
    );

    // Reopen from the URL alone, as a colleague following a shared link would.
    await page.goto(`/graph/${MOCK_CONTEXT.id}?precomputed=investigacao-agosto`);

    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('graph-status-bar')).toContainText('5 nodes');
    await expect(page.getByTestId('graph-status-precomputed')).toContainText('investigacao-agosto');
  });
});


