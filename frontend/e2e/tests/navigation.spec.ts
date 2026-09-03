import { test, expect, superuserTest } from '../fixtures/test-fixtures';
import { seedAdmin } from '../helpers/api-mocks';
import { openUserMenu } from '../helpers/user-menu';

test.describe('Navigation', () => {
  test('toolbar links navigate between pages', async ({ authenticatedPage: page }) => {
    // Start on Contexts
    await page.goto('/contexts');
    await expect(page.getByRole('heading', { level: 1, name: 'Graph Contexts' })).toBeVisible();

    // Navigate to Explorations
    await page.getByTestId('nav-explorations').click();
    await page.waitForURL('**/explorations');
    await expect(page.getByRole('heading', { level: 1, name: 'Explorations' })).toBeVisible();

    // Navigate to DEV (in the account menu)
    await openUserMenu(page);
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
    await openUserMenu(page);
    await expect(page.getByTestId('nav-dev')).toBeVisible();
  });

  test('Admin link is hidden for regular users and /admin redirects', async ({ authenticatedPage: page }) => {
    await page.goto('/contexts');
    await expect(page.getByTestId('nav-contexts')).toBeVisible();
    await openUserMenu(page);
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
    await openUserMenu(page);
    await page.getByTestId('nav-admin').click();
    await page.waitForURL('**/admin');
    await expect(page.getByRole('heading', { level: 1, name: 'Admin' })).toBeVisible();
  });
});

test.describe('Escape closes modals', () => {
  // Not one of the app's 30 modal overlays handled Escape; a single
  // document-level listener now closes the top-most one.
  test('the create-context modal closes on Escape', async ({ authenticatedPage: page }) => {
    await page.goto('/contexts');
    await page.getByTestId('create-context-btn').click();
    await expect(page.getByRole('heading', { name: 'Create Graph Context' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Create Graph Context' })).toHaveCount(0);
  });

  test('opening a modal moves focus into it and closing gives it back', async ({ authenticatedPage: page }) => {
    await page.goto('/contexts');
    const trigger = page.getByTestId('create-context-btn');
    await trigger.focus();

    await trigger.click();
    await expect(page.getByRole('heading', { name: 'Create Graph Context' })).toBeVisible();
    // Focus lands inside the dialog — it used to stay on the button behind it,
    // so Tab walked the page underneath.
    const insideModal = await page.evaluate(
      () => !!document.activeElement?.closest('.modal-overlay'),
    );
    expect(insideModal).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Create Graph Context' })).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('the About modal closes on Escape', async ({ authenticatedPage: page }) => {
    await page.goto('/contexts');
    await page.getByTitle('About Graph Lagoon Studio').click();
    await expect(page.getByRole('heading', { name: 'About Graph Lagoon Studio' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'About Graph Lagoon Studio' })).toHaveCount(0);
  });
});
