import { expect, superuserTest, test } from '../fixtures/test-fixtures';
import { seedAdmin } from '../helpers/api-mocks';
import { MOCK_ADMIN_AUDIT } from '../fixtures/mock-data';

/**
 * Admin area — superuser only.
 *
 * The backend is the security boundary (/api/admin/* answers 403 to anyone
 * else); these specs cover the UX: the link/guard, each tab rendering the
 * mocked environment, the ownership transfer flow and the danger zone.
 */

test.describe('Admin area (regular user)', () => {
  test('is unreachable by URL and shows nothing admin-ish', async ({ authenticatedPage: page }) => {
    await seedAdmin(page, { forbidden: true });
    await page.goto('/admin');
    await page.waitForURL('**/contexts');
    await expect(page.getByTestId('admin-view')).toHaveCount(0);
  });
});

superuserTest.describe('Admin area (superuser)', () => {
  superuserTest('overview shows environment, counts, superusers and flags', async ({ superuserPage: page }) => {
    await seedAdmin(page);
    await page.goto('/admin');
    await expect(page.getByTestId('admin-view')).toBeVisible();
    await expect(page.getByTestId('admin-dev-banner')).toBeVisible();
    await expect(page.getByTestId('admin-persistence')).toHaveText('memory');
    await expect(page.getByTestId('admin-counts')).toContainText('60');
    await expect(page.getByTestId('admin-counts')).toContainText('explorations');
    await expect(page.getByTestId('admin-superusers')).toContainText('dev@graphlagoon.local');
    await expect(page.getByTestId('admin-flags')).toContainText('style_presets_enabled');

    // Warehouse probe is on demand only.
    await page.getByTestId('admin-probe-warehouse').click();
    await expect(page.getByTestId('admin-overview')).toContainText('12.5 ms');
  });

  superuserTest('config tab redacts secrets and filters', async ({ superuserPage: page }) => {
    await seedAdmin(page);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-config').click();
    const config = page.getByTestId('admin-config');
    await expect(config).toContainText('GRAPH_LAGOON_DATABRICKS_TOKEN');
    await expect(config.locator('tr[data-kind="secret"]').first()).toContainText(/set|not set/);
    await expect(config).not.toContainText('postgresql://');
    await page.getByTestId('admin-config-search').fill('token');
    await expect(config.locator('tbody tr')).toHaveCount(1);
  });

  superuserTest('users tab lists users with badges and drills into their contexts', async ({ superuserPage: page }) => {
    await seedAdmin(page);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-users').click();
    const list = page.getByTestId('admin-users-list');
    await expect(list).toContainText('zoe.garcia@example.com');
    await expect(page.getByTestId('admin-superuser-badge')).toHaveCount(1);
    await expect(list.locator('[data-email="dave.moore@example.com"]')).toContainText('owns nothing');

    await list.locator('[data-email="zoe.garcia@example.com"]').getByRole('button', { name: /contexts/ }).click();
    await expect(page.getByTestId('admin-contexts')).toBeVisible();
    await expect(page.getByTestId('admin-contexts-list').locator('.list-item')).toHaveCount(1);
    await expect(page.getByTestId('admin-contexts-list')).toContainText('Fraud ring #1');
  });

  superuserTest('transfers a context to another user', async ({ superuserPage: page }) => {
    const calls = await seedAdmin(page);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-contexts').click();
    const row = page.getByTestId('admin-contexts-list').locator('[data-context-id="ctx-admin-2"]');
    await expect(row).toContainText('bob.silva@example.com');
    await row.getByTestId('admin-transfer-btn').click();

    const modal = page.getByTestId('admin-transfer-modal');
    await expect(modal).toBeVisible();
    const confirm = page.getByTestId('admin-transfer-confirm');
    await expect(confirm).toBeDisabled();
    await page.getByTestId('admin-transfer-input').fill('*@example.com');
    await expect(page.getByTestId('admin-transfer-error')).toContainText('wildcard');
    await page.getByTestId('admin-transfer-input').fill('dave.moore@example.com');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(modal).toHaveCount(0);
    await expect(row).toContainText('dave.moore@example.com');
    expect(calls.transfers).toHaveLength(1);
    expect(calls.transfers[0].url).toContain('/api/admin/contexts/ctx-admin-2/transfer');
    expect(calls.transfers[0].body).toEqual({ new_owner_email: 'dave.moore@example.com' });
  });

  superuserTest('audit tab renders entries and the action filter', async ({ superuserPage: page }) => {
    await seedAdmin(page);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-audit').click();
    const table = page.getByTestId('admin-audit-table');
    await expect(table.locator('tbody tr')).toHaveCount(MOCK_ADMIN_AUDIT.items.length);
    await expect(table).toContainText('context.transfer');
    await expect(table).toContainText('from carol.lee@example.com to bob.silva@example.com');
    await expect(page.getByTestId('admin-audit-action').locator('option')).toHaveCount(MOCK_ADMIN_AUDIT.actions.length + 1);
  });

  superuserTest('danger zone needs the exact confirmation', async ({ superuserPage: page }) => {
    const calls = await seedAdmin(page);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-danger').click();
    const button = page.getByTestId('admin-clear-env');
    await expect(button).toBeDisabled();
    await page.getByTestId('admin-clear-input').fill('clear all');
    await expect(button).toBeDisabled();
    await page.getByTestId('admin-clear-input').fill('CLEAR ALL');
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.getByTestId('admin-overview')).toBeVisible();
    expect(calls.clears).toEqual([{ confirm: 'CLEAR ALL' }]);
  });
});
