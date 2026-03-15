import { test, expect, unauthenticatedTest } from '../fixtures/test-fixtures';

unauthenticatedTest.describe('Authentication', () => {
  unauthenticatedTest('redirects to /login when not authenticated', async ({ unauthenticatedPage: page }) => {
    await page.goto('/contexts');
    await page.waitForURL('**/login');
    await expect(page).toHaveURL(/\/login/);
  });

  unauthenticatedTest('form prevents submission with invalid email (browser validation)', async ({ unauthenticatedPage: page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('not-an-email');
    await page.getByTestId('login-submit').click();

    // Browser's native email validation prevents form submission
    // so we should still be on the login page
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText('Graph Lagoon')).toBeVisible();
  });

  unauthenticatedTest('logs in with valid email and redirects to /contexts', async ({ unauthenticatedPage: page }) => {
    await page.goto('/login');
    await expect(page.getByText('Graph Lagoon')).toBeVisible();
    await expect(page.getByText('Dev Mode: Enter any email to login')).toBeVisible();

    await page.getByLabel('Email').fill('user@test.com');
    await page.getByTestId('login-submit').click();

    await page.waitForURL('**/contexts');
    await expect(page).toHaveURL(/\/contexts/);
  });
});

test.describe('Session persistence', () => {
  test('maintains session after page reload', async ({ authenticatedPage: page }) => {
    await page.goto('/contexts');
    await expect(page).toHaveURL(/\/contexts/);

    // Reload should stay on contexts (not redirect to login)
    await page.reload();
    await expect(page).toHaveURL(/\/contexts/);
  });

  test('logout clears session and redirects to login', async ({ authenticatedPage: page }) => {
    await page.goto('/contexts');
    await expect(page).toHaveURL(/\/contexts/);

    // Open user menu, then click Logout
    await page.locator('.btn-user-icon').click();
    await page.getByRole('button', { name: 'Logout' }).click();

    await page.waitForURL('**/login');
    await expect(page).toHaveURL(/\/login/);
  });
});
