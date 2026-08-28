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

  test('creates a nodeless (triple-store-only) context via the checkbox', async ({
    authenticatedPage: page,
  }) => {
    // A warehouse that only has triple/edge tables — no node tables at all.
    await page.route('**/graphlagoon/api/datasets', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ edge_tables: ['test_db.triples'], node_tables: [] }),
      });
    });

    let createdPayload: Record<string, unknown> | null = null;
    await page.route('**/graphlagoon/api/graph-contexts', (route) => {
      if (route.request().method() === 'POST') {
        createdPayload = JSON.parse(route.request().postData() || '{}');
        route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'ctx-nodeless', ...createdPayload }),
        });
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
    });

    await page.goto('/contexts');
    await page.getByTestId('create-context-btn').click();
    await expect(page.getByTestId('create-context-modal')).toBeVisible();

    // With no node tables in the warehouse, the checkbox comes pre-checked.
    await expect(page.getByTestId('no-node-table-checkbox')).toBeChecked();

    await page.getByPlaceholder('My Graph Context').fill('Triple Store');
    const edgeSelect = page.getByTestId('create-context-modal').locator('select').first();
    await edgeSelect.selectOption('test_db.triples');

    await page.getByTestId('create-context-submit').click();
    await expect(page.getByTestId('create-context-modal')).not.toBeVisible();

    expect(createdPayload).not.toBeNull();
    expect(createdPayload!.edge_table_name).toBe('test_db.triples');
    expect(createdPayload!.node_table_name).toBeUndefined();
    expect(createdPayload!.node_properties).toBeUndefined();
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

    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('Test Context');
    await page.getByTestId('confirm-dialog-accept').click();
    await expect(page.getByText('No Graph Contexts')).toBeVisible();
  });
});
