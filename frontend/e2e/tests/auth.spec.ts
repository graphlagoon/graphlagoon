import { test, expect, unauthenticatedTest } from '../fixtures/test-fixtures';
import type { Page } from '@playwright/test';

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

/**
 * Workspace-verified sign-in (GRAPH_LAGOON_AUTH_MODE=databricks): with no
 * session the SPA offers "Sign in with Databricks", which starts the OAuth
 * flow at the backend's login_url; with a session (the backend injects the
 * e-mail) the login page is skipped.
 */
const databricksTest = unauthenticatedTest.extend<{ databricksPage: Page }>({
  databricksPage: async ({ unauthenticatedPage: page }, use) => {
    await page.addInitScript(() => {
      (window as any).__GRAPH_LAGOON_CONFIG__ = {
        ...((window as any).__GRAPH_LAGOON_CONFIG__ || {}),
        dev_mode: false,
        auth_mode: 'databricks',
        login_url: '/api/auth/login',
      };
    });
    await page.route('**/api/auth/login**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<h1 data-testid="workspace-consent">Workspace sign-in</h1>' }),
    );
    await use(page);
  },
});

databricksTest.describe('Sign in with Databricks (auth_mode=databricks)', () => {
  databricksTest('a visitor without a session lands on the sign-in page, not the e-mail form', async ({ databricksPage: page }) => {
    await page.goto('/contexts');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId('login-databricks')).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveCount(0);
  });

  databricksTest('the button starts the backend sign-in with the contexts page as next', async ({ databricksPage: page }) => {
    await page.goto('/login');
    const started = page.waitForRequest((request) => request.url().includes('/api/auth/login'));
    await page.getByTestId('login-databricks').click();
    const request = await started;
    expect(new URL(request.url()).searchParams.get('next')).toMatch(/\/contexts$/);
    await expect(page.getByTestId('workspace-consent')).toBeVisible();
  });

  databricksTest('with a session the login page goes straight to contexts', async ({ databricksPage: page }) => {
    await page.addInitScript(() => {
      (window as any).__GRAPH_LAGOON_CONFIG__.databricks_user_email = 'ana@example.com';
    });
    await page.goto('/login');
    await expect(page).toHaveURL(/\/contexts/);
  });
});
