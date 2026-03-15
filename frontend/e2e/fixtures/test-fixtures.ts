import { test as base, type Page } from '@playwright/test';
import { setupAPIMocks } from '../helpers/api-mocks';

/**
 * Custom test fixture that provides an authenticated page.
 * - Injects window.__GRAPH_LAGOON_CONFIG__ before any script runs
 * - Sets localStorage userEmail for authentication
 * - Sets up API route interception
 */
export const test = base.extend<{ authenticatedPage: Page }>({
  authenticatedPage: async ({ page }, use) => {
    // Inject config BEFORE any script runs
    await page.addInitScript(() => {
      (window as any).__GRAPH_LAGOON_CONFIG__ = {
        dev_mode: true,
        database_enabled: false,
      };
    });

    // Set authentication in localStorage
    await page.addInitScript(() => {
      localStorage.setItem('userEmail', 'e2e@test.com');
    });

    // Set up API mocks
    await setupAPIMocks(page);

    await use(page);
  },
});

/**
 * Unauthenticated page fixture (dev mode, but no email in localStorage).
 */
export const unauthenticatedTest = base.extend<{ unauthenticatedPage: Page }>({
  unauthenticatedPage: async ({ page }, use) => {
    await page.addInitScript(() => {
      (window as any).__GRAPH_LAGOON_CONFIG__ = {
        dev_mode: true,
        database_enabled: false,
      };
    });

    await setupAPIMocks(page);

    await use(page);
  },
});

export { expect } from '@playwright/test';
