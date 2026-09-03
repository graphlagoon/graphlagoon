import { test as base, type Page } from '@playwright/test';
import { expect } from '../fixtures/test-fixtures';
import { setupAPIMocks, seedContexts } from '../helpers/api-mocks';
import { MOCK_CONTEXT } from '../fixtures/mock-data';

/**
 * What a user WITHOUT a permission sees: the affordance is gone (hide model,
 * not disable), and empty states still say what to do. The backend 403 is the
 * real boundary — covered by api/tests/test_permission_routes.py.
 */

const restrictedTest = base.extend<{ restrictedPage: Page }>({
  restrictedPage: async ({ page }, use) => {
    await page.addInitScript(() => {
      (window as any).__GRAPH_LAGOON_CONFIG__ = {
        dev_mode: true,
        database_enabled: false,
        permissions: [], // holds neither context.create nor exploration.save
      };
    });
    await page.addInitScript(() => {
      localStorage.setItem('userEmail', 'restricted@test.com');
    });
    await setupAPIMocks(page);
    await use(page);
  },
});

restrictedTest.describe('Without permissions', () => {
  restrictedTest('the create-context button does not render', async ({ restrictedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await page.goto('/contexts');
    await expect(page.getByText(MOCK_CONTEXT.title)).toBeVisible();
    await expect(page.getByTestId('create-context-btn')).toHaveCount(0);
  });

  restrictedTest('the empty state explains instead of dead-ending', async ({ restrictedPage: page }) => {
    await seedContexts(page, []);
    await page.goto('/contexts');
    await expect(page.getByTestId('contexts-empty-no-permission')).toContainText(
      'ask an administrator',
    );
    await expect(page.getByTestId('create-context-btn')).toHaveCount(0);
  });
});

restrictedTest.describe('With the permissions array present and full', () => {
  restrictedTest('the create button renders as before', async ({ restrictedPage: page }) => {
    await page.addInitScript(() => {
      (window as any).__GRAPH_LAGOON_CONFIG__ = {
        dev_mode: true,
        database_enabled: false,
        permissions: ['context.create', 'exploration.save'],
      };
    });
    await seedContexts(page, [MOCK_CONTEXT]);
    await page.goto('/contexts');
    await expect(page.getByTestId('create-context-btn')).toBeVisible();
  });
});
