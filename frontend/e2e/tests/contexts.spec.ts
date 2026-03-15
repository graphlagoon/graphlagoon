import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts } from '../helpers/api-mocks';

test.describe('Contexts', () => {
  // ---------------------------------------------------------------------------
  // Empty and list states
  // ---------------------------------------------------------------------------
  test('shows empty state when no contexts exist', async ({ authenticatedPage: page }) => {
    await page.goto('/contexts');
    await expect(page.getByText('No Graph Contexts')).toBeVisible();
    await expect(page.getByText('Create your first graph context')).toBeVisible();
  });

  test('shows contexts list with title, tables, and tags', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);

    await page.goto('/contexts');
    await expect(page.getByTestId('contexts-list')).toBeVisible();
    await expect(page.getByText('Test Context')).toBeVisible();
    await expect(page.getByText('test_db.edges')).toBeVisible();
    await expect(page.getByText('test_db.nodes')).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------
  test('search filters contexts by title', async ({ authenticatedPage: page }) => {
    const context2 = { ...MOCK_CONTEXT, id: 'ctx-test-2', title: 'Another Graph' };
    await seedContexts(page, [MOCK_CONTEXT, context2]);

    await page.goto('/contexts');
    await expect(page.getByTestId('contexts-list')).toBeVisible();

    await page.getByTestId('contexts-search').fill('Another');
    await expect(page.getByText('Another Graph')).toBeVisible();
    await expect(page.getByText('Test Context')).not.toBeVisible();

    // Clear search restores all
    await page.getByTestId('contexts-search').clear();
    await expect(page.getByText('Test Context')).toBeVisible();
    await expect(page.getByText('Another Graph')).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Create context modal
  // ---------------------------------------------------------------------------
  test('opens create context modal with required form fields', async ({ authenticatedPage: page }) => {
    await page.goto('/contexts');
    await page.getByTestId('create-context-btn').click();
    await expect(page.getByTestId('create-context-modal')).toBeVisible();
    await expect(page.getByText('Create Graph Context')).toBeVisible();

    // Core form labels are present (labels use "Title *", "Edge Table *", etc.)
    await expect(page.getByText('Title *')).toBeVisible();
    await expect(page.getByText('Edge Table *')).toBeVisible();
    await expect(page.getByText('Node Table *')).toBeVisible();
  });

  test('create context modal populates table dropdowns from API', async ({ authenticatedPage: page }) => {
    await page.goto('/contexts');
    await page.getByTestId('create-context-btn').click();
    await expect(page.getByTestId('create-context-modal')).toBeVisible();

    // MOCK_DATASETS returns edge_tables: ['test_db.edges', 'test_db.relationships']
    // Wait for the datasets API to respond and populate the dropdown options
    const edgeSelect = page.getByTestId('create-context-modal').locator('select').first();
    await expect(edgeSelect).toBeVisible();
    // The select options should contain our mock tables
    await expect(edgeSelect.locator('option', { hasText: 'test_db.edges' })).toBeAttached();
  });

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------
  test('navigates to graph when clicking Open button', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);

    await page.goto('/contexts');
    await expect(page.getByText('Test Context')).toBeVisible();
    await page.getByRole('button', { name: 'Open' }).click();
    await page.waitForURL(`**/graph/${MOCK_CONTEXT.id}`);
    await expect(page).toHaveURL(new RegExp(`/graph/${MOCK_CONTEXT.id}`));
  });

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------
  test('deletes context with confirmation', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);

    await page.goto('/contexts');
    await expect(page.getByText('Test Context')).toBeVisible();

    page.on('dialog', (dialog) => dialog.accept());

    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('No Graph Contexts')).toBeVisible();
  });
});
