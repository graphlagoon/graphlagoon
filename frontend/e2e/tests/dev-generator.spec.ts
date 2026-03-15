import { test as base, expect } from '../fixtures/test-fixtures';
import { setupAPIMocks } from '../helpers/api-mocks';

// Custom fixture for prod mode (dev_mode=false)
const prodTest = base.extend({
  prodPage: async ({ page }, use) => {
    await page.addInitScript(() => {
      (window as any).__GRAPH_LAGOON_CONFIG__ = {
        dev_mode: false,
        database_enabled: false,
      };
      localStorage.setItem('userEmail', 'e2e@test.com');
    });
    await setupAPIMocks(page);
    await use(page);
  },
});

base.describe('DEV Generator', () => {
  base('DEV link is visible in dev mode', async ({ authenticatedPage: page }) => {
    await page.goto('/contexts');
    await expect(page.getByTestId('nav-dev')).toBeVisible();
    await expect(page.getByTestId('nav-dev')).toHaveText('DEV');
  });

  base('navigates to DEV generator page', async ({ authenticatedPage: page }) => {
    await page.goto('/dev/generator');
    await expect(page.getByText('Graph Generator')).toBeVisible();
  });

  base('generator form shows model selection and node count', async ({ authenticatedPage: page }) => {
    await page.goto('/dev/generator');
    await expect(page.getByText('Graph Generator')).toBeVisible();

    // Model selection dropdown is present
    await expect(page.getByText('Graph Model')).toBeVisible();
    // Number of nodes label and input
    await expect(page.getByText('Number of Nodes')).toBeVisible();
  });

  base('generates a graph and shows result', async ({ authenticatedPage: page }) => {
    await page.goto('/dev/generator');
    await expect(page.getByText('Graph Generator')).toBeVisible();

    // Click generate (uses default form values)
    await page.getByRole('button', { name: /generate/i }).click();

    // Result should show success with node/edge counts from MOCK_DEV_RANDOM_GRAPH
    await expect(page.getByText(/generated successfully/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('50')).toBeVisible(); // num_nodes
    await expect(page.getByText('100')).toBeVisible(); // num_edges
  });

  base('result shows "Create Graph Context" button after generation', async ({ authenticatedPage: page }) => {
    await page.goto('/dev/generator');
    await page.getByRole('button', { name: /generate/i }).click();
    await expect(page.getByText(/generated successfully/i)).toBeVisible({ timeout: 10_000 });

    // "Create Graph Context from this Graph" button navigates to /contexts
    const createBtn = page.getByRole('button', { name: /create.*context/i });
    await expect(createBtn).toBeVisible();
  });
});

prodTest.describe('DEV Generator - Production Mode', () => {
  prodTest('DEV link is NOT visible in production mode', async ({ prodPage: page }) => {
    await page.goto('/contexts');
    await expect(page.getByTestId('nav-dev')).not.toBeVisible();
  });
});
