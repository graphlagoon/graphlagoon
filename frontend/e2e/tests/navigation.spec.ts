import { test, expect, superuserTest } from '../fixtures/test-fixtures';
import { seedAdmin } from '../helpers/api-mocks';

test.describe('Navigation', () => {
  test('toolbar links navigate between pages', async ({ authenticatedPage: page }) => {
    // Start on Contexts
    await page.goto('/contexts');
    await expect(page.getByRole('heading', { level: 1, name: 'Graph Contexts' })).toBeVisible();

    // Navigate to Explorations
    await page.getByTestId('nav-explorations').click();
    await page.waitForURL('**/explorations');
    await expect(page.getByRole('heading', { level: 1, name: 'Explorations' })).toBeVisible();

    // Navigate to DEV
    await page.getByTestId('nav-dev').click();
    await page.waitForURL('**/dev/generator');

    // Navigate back to Contexts
    await page.getByTestId('nav-contexts').click();
    await page.waitForURL('**/contexts');
    await expect(page.getByRole('heading', { level: 1, name: 'Graph Contexts' })).toBeVisible();
  });

  test('browser back/forward works', async ({ authenticatedPage: page }) => {
    await page.goto('/contexts');
    await expect(page).toHaveURL(/\/contexts/);

    // Navigate to Explorations
    await page.getByTestId('nav-explorations').click();
    await page.waitForURL('**/explorations');

    // Go back
    await page.goBack();
    await expect(page).toHaveURL(/\/contexts/);

    // Go forward
    await page.goForward();
    await expect(page).toHaveURL(/\/explorations/);
  });

  test('direct URL access works for /contexts', async ({ authenticatedPage: page }) => {
    await page.goto('/contexts');
    await expect(page.getByRole('heading', { level: 1, name: 'Graph Contexts' })).toBeVisible();
  });

  test('direct URL access works for /explorations', async ({ authenticatedPage: page }) => {
    await page.goto('/explorations');
    await expect(page.getByRole('heading', { level: 1, name: 'Explorations' })).toBeVisible();
  });

  test('DEV link is visible in dev mode', async ({ authenticatedPage: page }) => {
    await page.goto('/contexts');
    await expect(page.getByTestId('nav-dev')).toBeVisible();
  });

  test('Admin link is hidden for regular users and /admin redirects', async ({ authenticatedPage: page }) => {
    await page.goto('/contexts');
    await expect(page.getByTestId('nav-contexts')).toBeVisible();
    await expect(page.getByTestId('nav-admin')).toHaveCount(0);
    await page.goto('/admin');
    await page.waitForURL('**/contexts');
    await expect(page.getByTestId('admin-view')).toHaveCount(0);
  });
});

superuserTest.describe('Navigation (superuser)', () => {
  superuserTest('Admin link is visible and opens the admin area', async ({ superuserPage: page }) => {
    await seedAdmin(page);
    await page.goto('/contexts');
    await page.getByTestId('nav-admin').click();
    await page.waitForURL('**/admin');
    await expect(page.getByRole('heading', { level: 1, name: 'Admin' })).toBeVisible();
  });
});
