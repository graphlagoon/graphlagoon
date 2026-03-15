import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT, MOCK_EXPLORATION } from '../fixtures/mock-data';
import { seedContexts, seedExplorations } from '../helpers/api-mocks';

test.describe('Explorations', () => {
  // ---------------------------------------------------------------------------
  // Empty state
  // ---------------------------------------------------------------------------
  test('shows empty state when no explorations exist', async ({ authenticatedPage: page }) => {
    await page.goto('/explorations');
    await expect(page.getByText('No Explorations')).toBeVisible();
    await expect(page.getByText('Save your first exploration')).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // List rendering
  // ---------------------------------------------------------------------------
  test('shows explorations grouped by context', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedExplorations(page, [MOCK_EXPLORATION]);

    await page.goto('/explorations');
    await expect(page.getByText('Test Exploration')).toBeVisible();
    // Context name appears as group heading
    await expect(page.getByRole('heading', { name: 'Test Context' })).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------
  test('search filters explorations by title', async ({ authenticatedPage: page }) => {
    const exp2 = { ...MOCK_EXPLORATION, id: 'exp-test-2', title: 'Another Exploration' };
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedExplorations(page, [MOCK_EXPLORATION, exp2]);

    await page.goto('/explorations');

    await page.getByTestId('explorations-search').fill('Another');
    await expect(page.getByText('Another Exploration')).toBeVisible();
    await expect(page.getByText('Test Exploration')).not.toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Context filter dropdown
  // ---------------------------------------------------------------------------
  test('filters explorations by context using dropdown', async ({ authenticatedPage: page }) => {
    const context2 = { ...MOCK_CONTEXT, id: 'ctx-test-2', title: 'Second Context' };
    const exp2 = {
      ...MOCK_EXPLORATION,
      id: 'exp-test-2',
      title: 'Second Exploration',
      graph_context_id: 'ctx-test-2',
    };
    await seedContexts(page, [MOCK_CONTEXT, context2]);
    await seedExplorations(page, [MOCK_EXPLORATION, exp2]);

    await page.goto('/explorations');
    // Both explorations visible initially
    await expect(page.getByText('Test Exploration')).toBeVisible();
    await expect(page.getByText('Second Exploration')).toBeVisible();

    // Filter to only show explorations from "Second Context"
    await page.getByTestId('explorations-context-filter').selectOption({ label: 'Second Context' });
    await expect(page.getByText('Second Exploration')).toBeVisible();
    await expect(page.getByText('Test Exploration')).not.toBeVisible();

    // Reset filter to "All Contexts"
    await page.getByTestId('explorations-context-filter').selectOption({ label: 'All Contexts' });
    await expect(page.getByText('Test Exploration')).toBeVisible();
    await expect(page.getByText('Second Exploration')).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------
  test('deletes exploration with confirmation', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedExplorations(page, [MOCK_EXPLORATION]);

    await page.goto('/explorations');
    await expect(page.getByText('Test Exploration')).toBeVisible();

    page.on('dialog', (dialog) => dialog.accept());

    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('No Explorations')).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Navigation from exploration to graph
  // ---------------------------------------------------------------------------
  test('navigates to graph from exploration list', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedExplorations(page, [MOCK_EXPLORATION]);

    await page.goto('/explorations');
    await expect(page.getByText('Test Exploration')).toBeVisible();

    // Click the exploration title/open to navigate to the graph
    await page.getByRole('button', { name: 'Open' }).click();
    await page.waitForURL(`**/graph/${MOCK_CONTEXT.id}**`);
    await expect(page).toHaveURL(new RegExp(`/graph/${MOCK_CONTEXT.id}`));
  });
});
