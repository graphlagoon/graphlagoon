import {
  test as base,
  type Page,
  type APIRequestContext,
} from '@playwright/test';

/**
 * Integration test fixtures.
 * NO API mocking — all requests go to the real backend.
 *
 * Requires: PostgreSQL + sql-warehouse + REST API (database_enabled=true)
 */

const API_BASE = 'http://localhost:8000/graphlagoon/';
const TEST_USER_A = 'integration-a@test.com';
const TEST_USER_B = 'integration-b@test.com';

export const test = base.extend<{
  /** Playwright API request context (calls the REST API directly). */
  api: APIRequestContext;
  /** Authenticated browser page (user A). */
  authenticatedPage: Page;
}>({
  api: async ({ playwright }, use) => {
    const ctx = await playwright.request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: {
        'X-Forwarded-Email': TEST_USER_A,
        'Content-Type': 'application/json',
      },
    });

    // Clean slate before the test
    await ctx.delete('api/dev/clear-all');

    await use(ctx);

    // Clean up after the test
    await ctx.delete('api/dev/clear-all');
    await ctx.dispose();
  },

  authenticatedPage: async ({ page }, use) => {
    // Set auth email — the frontend will send X-Forwarded-Email in dev mode
    await page.addInitScript((email: string) => {
      localStorage.setItem('userEmail', email);
    }, TEST_USER_A);

    await use(page);
  },
});

export { expect } from '@playwright/test';
export { TEST_USER_A, TEST_USER_B, API_BASE };
