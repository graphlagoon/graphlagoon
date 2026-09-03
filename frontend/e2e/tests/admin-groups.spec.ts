import { expect, superuserTest } from '../fixtures/test-fixtures';
import { seedAdmin } from '../helpers/api-mocks';

/**
 * Groups & permissions tab — superuser management surface. The backend is
 * the boundary; these specs cover the UX and assert the request bodies the
 * UI sends (recorded by seedAdmin).
 */

superuserTest.describe('Admin: groups & permissions', () => {
  superuserTest('tab lists groups, the matrix and the inspector', async ({ superuserPage: page }) => {
    await seedAdmin(page);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-groups').click();

    const panel = page.getByTestId('admin-groups');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('admin-groups-list')).toContainText('analysts');
    await expect(page.getByTestId('admin-groups-list')).toContainText('1 email · 1 Databricks group');

    const matrix = page.getByTestId('admin-permissions-matrix');
    await expect(matrix).toContainText('Create graph contexts');
    await expect(matrix).toContainText('Save explorations');
    // The seeded deny rule renders on the restricted-demo chip.
    await expect(
      page.getByTestId('admin-permission-chip-context.create-restricted-demo'),
    ).toContainText('deny');
  });

  superuserTest('creating a group sends the normalized payload', async ({ superuserPage: page }) => {
    const calls = await seedAdmin(page);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-groups').click();

    await page.getByTestId('admin-group-create').click();
    await page.getByTestId('admin-group-name').fill('viewers');
    await page.getByTestId('admin-group-member-value').fill('Viewer@Example.com');
    await page.getByTestId('admin-group-member-add').click();
    await page.getByTestId('admin-group-member-kind').selectOption('databricks_group');
    await page.getByTestId('admin-group-member-value').fill('read-only');
    await page.getByTestId('admin-group-member-add').click();
    await page.getByTestId('admin-group-confirm').click();

    await expect(page.getByTestId('admin-group-modal')).toHaveCount(0);
    expect(calls.groupSaves).toHaveLength(1);
    expect(calls.groupSaves[0].method).toBe('POST');
    expect(calls.groupSaves[0].body).toMatchObject({
      name: 'viewers',
      members: [
        { kind: 'email', value: 'viewer@example.com' },
        { kind: 'databricks_group', value: 'read-only' },
      ],
    });
    await expect(page.getByTestId('admin-groups-list')).toContainText('viewers');
  });

  superuserTest('restricting a permission sends a full-replacement PUT', async ({ superuserPage: page }) => {
    const calls = await seedAdmin(page);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-groups').click();

    await page.getByTestId('admin-permission-mode-exploration.save').selectOption('restricted');
    // Cycle the analysts chip to ALLOW.
    await page.getByTestId('admin-permission-chip-exploration.save-analysts').click();
    // restricted + one allow ⇒ no lockout warning
    await expect(page.getByTestId('admin-permission-lockout')).toHaveCount(0);
    await page.getByTestId('admin-permission-save-exploration.save').click();

    expect(calls.permissionPuts).toHaveLength(1);
    expect(calls.permissionPuts[0].url).toContain('/admin/permissions/exploration.save');
    expect(calls.permissionPuts[0].body).toEqual({
      mode: 'restricted',
      rules: [{ group_id: 'grp-1', effect: 'allow' }],
    });
  });

  superuserTest('restricted without an allow rule warns about lockout', async ({ superuserPage: page }) => {
    await seedAdmin(page);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-groups').click();

    await page.getByTestId('admin-permission-mode-exploration.save').selectOption('restricted');
    await expect(page.getByTestId('admin-permission-lockout')).toBeVisible();
  });

  superuserTest('inspector explains a deny with the matched group', async ({ superuserPage: page }) => {
    await seedAdmin(page);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-groups').click();

    await page.getByTestId('admin-inspect-email').fill('restricted-demo@example.com');
    await page.getByTestId('admin-inspect-run').click();

    const report = page.getByTestId('admin-inspect-report');
    await expect(report).toBeVisible();
    await expect(page.getByTestId('admin-inspect-context.create')).toHaveText('denied');
    await expect(report).toContainText('deny · group restricted-demo');
    await expect(page.getByTestId('admin-inspect-exploration.save')).toHaveText('allowed');
  });
});
