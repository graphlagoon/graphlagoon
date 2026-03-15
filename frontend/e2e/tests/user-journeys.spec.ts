/**
 * Cross-flow user journey tests.
 *
 * These tests validate complete workflows that span multiple pages,
 * simulating what a real user would do in a typical session.
 * A PM can read these test names and understand what user flows are covered.
 */
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT, MOCK_EXPLORATION } from '../fixtures/mock-data';
import { seedContexts, seedExplorations } from '../helpers/api-mocks';

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
});
