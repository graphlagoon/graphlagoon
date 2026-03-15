/**
 * E2E tests: Sharing UI for contexts and explorations.
 *
 * Uses a custom fixture with database_enabled: true so the sharing
 * UI (buttons, modals) is visible. All API calls are mocked.
 */
import { test as base, type Page, expect } from '@playwright/test';
import { setupAPIMocks, seedContexts, seedExplorations } from '../helpers/api-mocks';
import { MOCK_CONTEXT, MOCK_EXPLORATION } from '../fixtures/mock-data';

const LOGGED_IN_USER = 'e2e@test.com';
const OTHER_USER = 'alice@other.com';

/**
 * Fixture with database_enabled: true so sharing UI is visible.
 * The default authenticatedPage uses database_enabled: false.
 */
const test = base.extend<{ authenticatedPage: Page }>({
  authenticatedPage: async ({ page }, use) => {
    await page.addInitScript(() => {
      (window as any).__GRAPH_LAGOON_CONFIG__ = {
        dev_mode: true,
        database_enabled: true,
        allowed_share_domains: ['company.com'],
      };
    });
    await page.addInitScript(() => {
      localStorage.setItem('userEmail', 'e2e@test.com');
    });
    await setupAPIMocks(page);
    // Override config mock to enable sharing
    await page.route('**/graphlagoon/api/config', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          database_enabled: true,
          dev_mode: true,
          allowed_share_domains: ['company.com'],
        }),
      });
    });
    await use(page);
  },
});

// ---------------------------------------------------------------------------
// Context Sharing
// ---------------------------------------------------------------------------
test.describe('Context sharing', () => {
  test('shows Share button for owned context', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]); // owner_email: e2e@test.com
    await page.goto('/contexts');
    await expect(page.getByTestId('contexts-list')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share' })).toBeVisible();
  });

  test('hides Share button and shows badge for non-owned context', async ({ authenticatedPage: page }) => {
    const sharedContext = {
      ...MOCK_CONTEXT,
      owner_email: OTHER_USER,
      shared_with: [LOGGED_IN_USER],
      has_write_access: false,
    };
    await seedContexts(page, [sharedContext]);
    await page.goto('/contexts');
    await expect(page.getByTestId('contexts-list')).toBeVisible();

    // Non-owner should NOT see Share or Delete buttons
    await expect(page.getByRole('button', { name: 'Share' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete' })).not.toBeVisible();
    // But should see the badge
    await expect(page.getByText('Read only')).toBeVisible();
  });

  test('opens share modal with form and wildcard hint', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await page.goto('/contexts');
    await page.getByRole('button', { name: 'Share' }).click();

    // Modal title
    await expect(page.getByText(`Share "${MOCK_CONTEXT.title}"`)).toBeVisible();
    // Email input
    await expect(page.locator('.share-modal input[type="text"]')).toBeVisible();
    // Permission select
    await expect(page.locator('.share-modal select')).toBeVisible();
    // Wildcard hint for allowed domain
    await expect(page.getByText('*@company.com')).toBeVisible();
  });

  test('share modal shows existing shared emails', async ({ authenticatedPage: page }) => {
    const contextWithShares = {
      ...MOCK_CONTEXT,
      shared_with: ['bob@test.com', '*@company.com'],
    };
    await seedContexts(page, [contextWithShares]);
    await page.goto('/contexts');
    await page.getByRole('button', { name: 'Share' }).click();

    const sharedList = page.locator('.shared-list');
    await expect(sharedList.getByText('Currently shared with:')).toBeVisible();
    await expect(sharedList.getByText('bob@test.com')).toBeVisible();
    await expect(sharedList.getByText('*@company.com')).toBeVisible();
    // Domain badge for wildcard
    await expect(sharedList.getByText('Domain')).toBeVisible();
  });

  test('submitting share form calls API and closes modal', async ({ authenticatedPage: page }) => {
    // Mutable state to simulate server-side updates
    let sharedWith: string[] = [];

    // Override GET contexts with dynamic shared_with
    await page.route('**/graphlagoon/api/graph-contexts', (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ ...MOCK_CONTEXT, shared_with: [...sharedWith] }]),
        });
      } else {
        route.fallback();
      }
    });

    // Intercept share POST — capture payload and update state
    let sharePayload: any = null;
    await page.route(`**/graphlagoon/api/graph-contexts/${MOCK_CONTEXT.id}/share`, (route) => {
      if (route.request().method() === 'POST') {
        sharePayload = JSON.parse(route.request().postData() || '{}');
        sharedWith.push(sharePayload.email);
        route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      } else {
        route.fallback();
      }
    });

    await page.goto('/contexts');
    await expect(page.getByText(MOCK_CONTEXT.title)).toBeVisible();

    // Open share modal
    await page.getByRole('button', { name: 'Share' }).click();
    await expect(page.getByText(`Share "${MOCK_CONTEXT.title}"`)).toBeVisible();

    // Fill form
    await page.locator('.share-modal input[type="text"]').fill('newuser@test.com');
    await page.locator('.share-modal select').selectOption('write');

    // Submit via the modal's Share button
    await page.locator('.modal-footer').getByRole('button', { name: 'Share' }).click();

    // Verify API was called correctly
    expect(sharePayload).toEqual({ email: 'newuser@test.com', permission: 'write' });
    // Modal should close
    await expect(page.getByText(`Share "${MOCK_CONTEXT.title}"`)).not.toBeVisible();
  });

  test('unshare removes email from shared list', async ({ authenticatedPage: page }) => {
    let sharedWith = ['bob@test.com'];

    await page.route('**/graphlagoon/api/graph-contexts', (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ ...MOCK_CONTEXT, shared_with: [...sharedWith] }]),
        });
      } else {
        route.fallback();
      }
    });

    // Intercept unshare DELETE
    let unshareCalled = false;
    await page.route('**/graphlagoon/api/graph-contexts/*/share/*', (route) => {
      if (route.request().method() === 'DELETE') {
        // Remove the email from state
        const url = route.request().url();
        const email = decodeURIComponent(url.split('/share/')[1]);
        sharedWith = sharedWith.filter(e => e !== email);
        unshareCalled = true;
        route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      } else {
        route.fallback();
      }
    });

    await page.goto('/contexts');
    await page.getByRole('button', { name: 'Share' }).click();

    // Verify bob is listed
    await expect(page.getByText('bob@test.com')).toBeVisible();

    // Click remove button (×)
    await page.locator('.shared-list .btn-remove').click();

    // Verify API was called
    expect(unshareCalled).toBe(true);

    // After refresh, bob should no longer be in the modal
    await expect(page.getByText('bob@test.com')).not.toBeVisible({ timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// Exploration Sharing
// ---------------------------------------------------------------------------
test.describe('Exploration sharing', () => {
  test('shows Share button for owned exploration', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedExplorations(page, [MOCK_EXPLORATION]);
    await page.goto('/explorations');
    await expect(page.getByText(MOCK_EXPLORATION.title)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share' })).toBeVisible();
  });

  test('hides Share button and shows badge for non-owned exploration', async ({ authenticatedPage: page }) => {
    const sharedExploration = {
      ...MOCK_EXPLORATION,
      owner_email: OTHER_USER,
      shared_with: [LOGGED_IN_USER],
    };
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedExplorations(page, [sharedExploration]);
    await page.goto('/explorations');
    await expect(page.getByText(MOCK_EXPLORATION.title)).toBeVisible();

    // Non-owner: no Share or Delete buttons
    await expect(page.getByRole('button', { name: 'Share' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete' })).not.toBeVisible();
    // Shows "Shared by" badge with owner email
    await expect(page.getByText(OTHER_USER)).toBeVisible();
  });

  test('submitting share form calls exploration share API', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);

    // Dynamic exploration mock with mutable shared_with
    let sharedWith: string[] = [];
    await page.route('**/graphlagoon/api/explorations', (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ ...MOCK_EXPLORATION, shared_with: [...sharedWith] }]),
        });
      } else {
        route.fallback();
      }
    });

    // Also mock context-specific explorations list
    await page.route(`**/graphlagoon/api/graph-contexts/${MOCK_CONTEXT.id}/explorations`, (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ ...MOCK_EXPLORATION, shared_with: [...sharedWith] }]),
        });
      } else {
        route.fallback();
      }
    });

    // Intercept share POST
    let sharePayload: any = null;
    await page.route(`**/graphlagoon/api/explorations/${MOCK_EXPLORATION.id}/share`, (route) => {
      if (route.request().method() === 'POST') {
        sharePayload = JSON.parse(route.request().postData() || '{}');
        sharedWith.push(sharePayload.email);
        route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      } else {
        route.fallback();
      }
    });

    await page.goto('/explorations');
    await expect(page.getByText(MOCK_EXPLORATION.title)).toBeVisible();

    // Open share modal
    await page.getByRole('button', { name: 'Share' }).click();
    await expect(page.getByText(`Share "${MOCK_EXPLORATION.title}"`)).toBeVisible();

    // Fill form
    await page.locator('.modal input[type="text"]').fill('colleague@company.com');
    await page.locator('.modal select').selectOption('read');

    // Submit
    await page.locator('.modal-footer').getByRole('button', { name: 'Share' }).click();

    expect(sharePayload).toEqual({ email: 'colleague@company.com', permission: 'read' });
    // Form should be cleared after successful share
    await expect(page.locator('.modal input[type="text"]')).toHaveValue('');
  });
});

// ---------------------------------------------------------------------------
// Cross-user visibility
// ---------------------------------------------------------------------------
test.describe('Cross-user visibility', () => {
  test('user sees both owned and shared contexts', async ({ authenticatedPage: page }) => {
    const sharedContext = {
      ...MOCK_CONTEXT,
      id: 'ctx-shared-1',
      title: 'Shared From Alice',
      owner_email: OTHER_USER,
      shared_with: [LOGGED_IN_USER],
      has_write_access: false,
    };
    await seedContexts(page, [MOCK_CONTEXT, sharedContext]);
    await page.goto('/contexts');

    // Both contexts visible
    await expect(page.getByText('Test Context')).toBeVisible();
    await expect(page.getByText('Shared From Alice')).toBeVisible();

    // Only the shared context has the badge
    await expect(page.getByText('Read only')).toBeVisible();

    // Only the owned context has Share and Delete buttons
    // (two buttons: one Share, one Delete for owned; none for shared)
    const shareButtons = page.getByRole('button', { name: 'Share' });
    await expect(shareButtons).toHaveCount(1);
    const deleteButtons = page.getByRole('button', { name: 'Delete' });
    await expect(deleteButtons).toHaveCount(1);
  });

  test('user sees both owned and shared explorations', async ({ authenticatedPage: page }) => {
    const sharedContext = {
      ...MOCK_CONTEXT,
      id: 'ctx-shared-1',
      title: 'Alice Context',
      owner_email: OTHER_USER,
      shared_with: [LOGGED_IN_USER],
    };
    await seedContexts(page, [MOCK_CONTEXT, sharedContext]);

    const sharedExploration = {
      ...MOCK_EXPLORATION,
      id: 'exp-shared-1',
      title: 'Alice Exploration',
      graph_context_id: 'ctx-shared-1',
      owner_email: OTHER_USER,
      shared_with: [LOGGED_IN_USER],
    };
    await seedExplorations(page, [MOCK_EXPLORATION, sharedExploration]);

    await page.goto('/explorations');

    // Both explorations visible
    await expect(page.getByText('Test Exploration')).toBeVisible();
    await expect(page.getByText('Alice Exploration')).toBeVisible();

    // Shared exploration shows owner badge
    await expect(page.getByText(OTHER_USER)).toBeVisible();

    // Only the owned exploration has Share and Delete buttons
    const shareButtons = page.getByRole('button', { name: 'Share' });
    await expect(shareButtons).toHaveCount(1);
    const deleteButtons = page.getByRole('button', { name: 'Delete' });
    await expect(deleteButtons).toHaveCount(1);
  });
});
