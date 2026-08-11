import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts, mockSchemaDrift } from '../helpers/api-mocks';

const OK_DRIFT = {
  context_id: MOCK_CONTEXT.id,
  checked_at: '2026-08-11T00:00:00Z',
  status: 'ok',
  types_checked: true,
  counts: { error: 0, warning: 0, info: 0 },
  node_table: { table_name: MOCK_CONTEXT.node_table_name, reachable: true, columns: [] },
  edge_table: { table_name: MOCK_CONTEXT.edge_table_name, reachable: true, columns: [] },
  findings: [],
  proposed: { node_properties: [], edge_properties: [], node_types: null, relationship_types: null },
};

const DRIFT_WITH_DROPPED_COLUMN = {
  ...OK_DRIFT,
  status: 'error',
  counts: { error: 1, warning: 0, info: 0 },
  findings: [
    {
      code: 'PROPERTY_COLUMN_MISSING',
      severity: 'error',
      side: 'node',
      kind: 'property',
      name: 'email',
      message: 'Node property column `email` no longer exists in `test_db.nodes`.',
      stored: { data_type: 'string', display_name: 'E-mail' },
      live: null,
      auto_fixable: true,
    },
  ],
  proposed: {
    node_properties: [{ name: 'name', data_type: 'string' }],
    edge_properties: [],
    node_types: null,
    relationship_types: null,
  },
};

test.describe('Schema drift', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
  });

  test('a read-only user can check schema, but Apply stays disabled', async ({ authenticatedPage: page }) => {
    const readOnlyContext = { ...MOCK_CONTEXT, has_write_access: false };
    await seedContexts(page, [readOnlyContext]);
    await mockSchemaDrift(page, MOCK_CONTEXT.id, DRIFT_WITH_DROPPED_COLUMN);

    await page.goto('/contexts');
    // Checking is available regardless of write access — it's read-only.
    await expect(page.getByTestId('check-schema-btn')).toBeEnabled();
    // Editing requires write access.
    await expect(page.getByTestId('edit-context-btn')).toHaveCount(0);

    await page.getByTestId('check-schema-btn').click();
    await page.getByTestId('schema-drift-review-btn').click();
    await expect(page.getByTestId('schema-drift-modal')).toBeVisible();

    // Applying the fix still requires write access.
    await expect(page.getByTestId('schema-drift-apply')).toBeDisabled();
  });

  test('banner appears on the context row after "Check schema"', async ({ authenticatedPage: page }) => {
    await mockSchemaDrift(page, MOCK_CONTEXT.id, DRIFT_WITH_DROPPED_COLUMN);

    await page.goto('/contexts');
    await expect(page.getByText('Test Context')).toBeVisible();

    await page.getByTestId('check-schema-btn').click();
    await expect(page.getByTestId('schema-drift-banner')).toBeVisible();
    await expect(page.getByTestId('schema-drift-banner')).toContainText('1 error');
  });

  test('the check asks for type discovery, so types are never silently skipped', async ({ authenticatedPage: page }) => {
    await mockSchemaDrift(page, MOCK_CONTEXT.id, OK_DRIFT);

    await page.goto('/contexts');
    const driftReq = page.waitForRequest((req) => req.url().includes('/schema-drift'));
    await page.getByTestId('check-schema-btn').click();
    const req = await driftReq;

    expect(new URL(req.url()).searchParams.get('check_types')).toBe('true');
  });

  test('review modal lists the dropped column', async ({ authenticatedPage: page }) => {
    await mockSchemaDrift(page, MOCK_CONTEXT.id, DRIFT_WITH_DROPPED_COLUMN);

    await page.goto('/contexts');
    await page.getByTestId('check-schema-btn').click();
    await page.getByTestId('schema-drift-review-btn').click();

    await expect(page.getByTestId('schema-drift-modal')).toBeVisible();
    await expect(page.getByTestId('schema-drift-modal')).toContainText('email');
    await expect(page.getByTestId('schema-drift-modal')).toContainText('no longer exists');
  });

  test('Apply issues a PUT whose body omits the dropped column', async ({ authenticatedPage: page }) => {
    await mockSchemaDrift(page, MOCK_CONTEXT.id, DRIFT_WITH_DROPPED_COLUMN);

    await page.goto('/contexts');
    await page.getByTestId('check-schema-btn').click();
    await page.getByTestId('schema-drift-review-btn').click();
    await expect(page.getByTestId('schema-drift-modal')).toBeVisible();

    const putReq = page.waitForRequest(
      (req) => req.url().includes(`/graph-contexts/${MOCK_CONTEXT.id}`) && req.method() === 'PUT',
    );
    await page.getByTestId('schema-drift-apply').click();
    const req = await putReq;

    const body = req.postDataJSON();
    const names = (body.node_properties ?? []).map((p: any) => p.name);
    expect(names).not.toContain('email');
    expect(names).toContain('name');
  });

  test('a stale-schema query error shows the CTA and opens the review modal', async ({ authenticatedPage: page }) => {
    await mockSchemaDrift(page, MOCK_CONTEXT.id, OK_DRIFT);
    await page.route(`**/graphlagoon/api/graph-contexts/${MOCK_CONTEXT.id}/subgraph`, (route) => {
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          detail: {
            error: {
              code: 'STALE_CONTEXT_SCHEMA',
              message: '[UNRESOLVED_COLUMN.WITH_SUGGESTION] cannot resolve `email`',
              details: {
                hint: "This context's stored schema may be out of date — run a schema check and resync.",
                unresolved_name: 'email',
                context_id: MOCK_CONTEXT.id,
              },
            },
          },
        }),
      });
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);

    await expect(page.getByTestId('review-schema-btn')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="stale-schema-hint"]')).toContainText('out of date');

    await page.getByTestId('review-schema-btn').click();
    await expect(page.getByTestId('schema-drift-modal')).toBeVisible();
  });

  test('schema is not checked automatically on graph open, only via the manual action', async ({ authenticatedPage: page }) => {
    let driftRequested = false;
    await page.route(`**/graphlagoon/api/graph-contexts/${MOCK_CONTEXT.id}/schema-drift**`, (route) => {
      driftRequested = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OK_DRIFT) });
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    expect(driftRequested).toBe(false);

    // Open the Context Info panel and trigger the manual check.
    await page.getByTitle('Context Info').click();
    await page.getByTestId('context-info-check-schema').click();
    await expect(page.getByTestId('schema-drift-banner')).toBeVisible();
    expect(driftRequested).toBe(true);
  });
});
