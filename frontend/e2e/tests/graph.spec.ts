import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT, MOCK_EXPLORATION } from '../fixtures/mock-data';
import { seedContexts, seedExplorations } from '../helpers/api-mocks';

test.describe('Graph Visualization', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
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
      await expect(page.locator('h3', { hasText: 'Graph Query' })).toBeVisible();
      // Mode toggle buttons
      await expect(page.getByRole('button', { name: 'OpenCypher' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'SQL' })).toBeVisible();

      await page.getByTitle('Query', { exact: true }).click();
    });

    test('Metrics panel shows compute and mapping tabs', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTitle('Metrics')).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Metrics').click();
      await expect(page.locator('h3', { hasText: 'Graph Metrics' })).toBeVisible();
      await expect(page.getByText('Visual Mapping')).toBeVisible();

      await page.getByTitle('Metrics').click();
    });

    test('Query Templates panel shows template controls', async ({ authenticatedPage: page }) => {
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTitle('Query Templates')).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Query Templates').click();
      await expect(page.locator('h3', { hasText: 'Query Templates' })).toBeVisible();

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
      await expect(page.getByText('Default Templates')).toBeVisible();
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
});
