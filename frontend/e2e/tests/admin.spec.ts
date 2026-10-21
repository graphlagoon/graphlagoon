import { expect, superuserTest, test } from '../fixtures/test-fixtures';
import { caseType, seedAdmin, seedCaseTypes } from '../helpers/api-mocks';
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

  superuserTest('case types: the org defines its own, with outcomes, actions and fields (06 §1)', async ({ superuserPage: page }) => {
    await seedAdmin(page);
    const calls = await seedCaseTypes(page, [caseType('credit_review', { label: 'Credit review', outcomes: [{ id: 'approve', label: 'Approve', closes_case: true, requires_review: false }] })]);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-case-types').click();
    const table = page.getByTestId('admin-case-types-table');
    await expect(table.getByTestId('admin-case-type-general')).toContainText('built in');
    await expect(table.getByTestId('admin-case-type-credit_review')).toContainText('Credit review');

    await page.getByTestId('admin-case-type-new').click();
    const editor = page.getByTestId('case-type-editor');
    await editor.getByTestId('ct-label').fill('Merchant review');
    await editor.getByTestId('ct-roles').fill('suspect merchant, front partner');
    await editor.getByTestId('ct-add-outcome').click();
    await editor.getByTestId('ct-outcome-label-0').fill('Terminate the merchant');
    await editor.getByTestId('ct-outcome-review-0').check();
    await editor.getByTestId('ct-add-action').click();
    await editor.getByTestId('ct-action-label-0').fill('Hold the settlements');
    await editor.getByTestId('ct-add-field').click();
    await editor.getByTestId('ct-field-label-0').fill('Amount at risk');
    await editor.getByTestId('ct-field-type-0').selectOption('money');
    await editor.getByTestId('ct-field-queue-0').check();
    await editor.getByTestId('ct-sla-open').fill('24');
    await editor.getByTestId('ct-save').click();

    await expect(table.getByTestId('admin-case-type-merchant_review')).toContainText('Merchant review');
    expect(calls.puts).toHaveLength(1);
    expect(calls.puts[0]).toMatchObject({
      slug: 'merchant_review',
      body: {
        label: 'Merchant review',
        vocabularies: { roles: ['suspect merchant', 'front partner'] },
        outcomes: [{ id: 'terminate_the_merchant', closes_case: true, requires_review: true }],
        actions: [{ id: 'hold_the_settlements', label: 'Hold the settlements' }],
        fields: [{ id: 'amount_at_risk', type: 'money', in_queue: true }],
        sla_hours: { open: 24 },
      },
    });
  });

  superuserTest('case types: help, an AI prompt from the server catalog, and Import JSON fills the form (06)', async ({ superuserPage: page }) => {
    await seedAdmin(page);
    const calls = await seedCaseTypes(page, []);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-case-types').click();
    await page.getByTestId('admin-case-type-new').click();
    const editor = page.getByTestId('case-type-editor');
    await editor.getByTestId('help-ct-actions').click();
    await expect(editor.getByTestId('help-ct-actions-text')).toContainText('becomes a task');
    await editor.getByTestId('ct-ask-ai').click();
    await expect(page.getByTestId('ct-skill-text')).toContainText('write a "case type"');
    await expect(page.getByTestId('ct-skill-text')).toContainText('"starter_queries"'); // the server schema
    await page.getByRole('button', { name: 'Close' }).click();

    await editor.getByTestId('ct-import-json').click();
    await editor.getByTestId('ct-import-text').fill(JSON.stringify({
      label: 'Chargeback dispute',
      outcomes: [{ id: 'accept', label: 'Accept', closes_case: true }, { id: 'represent', label: 'Represent', closes_case: false }],
      fields: [{ id: 'reason_code', label: 'Reason code', type: 'enum', options: ['10.4', '13.1'], required: true, in_queue: true }],
    }));
    await editor.getByTestId('ct-import-apply').click();
    await expect(editor.getByTestId('ct-label')).toHaveValue('Chargeback dispute');
    await editor.getByTestId('ct-save').click();
    await expect.poll(() => calls.puts.length).toBe(1);
    expect(calls.puts[0]).toMatchObject({
      slug: 'chargeback_dispute',
      body: { outcomes: [{ id: 'accept' }, { id: 'represent', closes_case: false }], fields: [{ id: 'reason_code', options: ['10.4', '13.1'] }] },
    });
  });
});
