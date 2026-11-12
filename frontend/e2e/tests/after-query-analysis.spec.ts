/**
 * Behaviors → "After a query": communities and a cluster program run on their
 * own once a query you ran loads — and not on the context's auto-load.
 * Planning rules are unit tested in src/utils/__tests__/afterQueryAnalysis.test.ts.
 */
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts } from '../helpers/api-mocks';

const PROGRAM = 'default-group-by-node-type';

test.describe('After a query: communities and clusters', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [
      {
        ...MOCK_CONTEXT,
        default_behaviors: {
          ...MOCK_CONTEXT.default_behaviors,
          afterQueryCommunities: `cluster-program:${PROGRAM}`,
          afterQueryClusterProgram: PROGRAM,
        },
      },
    ]);
  });

  test('a query you run gets communities and clusters; the auto-load does not', async ({
    authenticatedPage: page,
  }) => {
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    const statusBar = page.getByTestId('graph-status-bar');
    await expect(statusBar).toContainText('5 nodes', { timeout: 15_000 });
    await expect(page.getByTestId('graph-status-clusters')).toHaveCount(0);

    await page.getByTestId('toolbar-query').click();
    await page.getByTestId('graph-query-mode-sql').click();
    await page.getByTestId('graph-query-sql').fill('SELECT * FROM edges');
    await page.getByTestId('graph-query-run').click();

    // Group by Node Type → Person and Company.
    await expect(page.getByTestId('graph-status-clusters')).toHaveText('2 clusters', { timeout: 15_000 });
    await page.getByTitle('Clusters', { exact: true }).click();
    await expect(page.locator('[data-testid^="group-row-community:"]')).toHaveCount(2);
  });

  test('the Behaviors panel shows and changes the setting', async ({ authenticatedPage: page }) => {
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('toolbar-look').click();
    await page.getByTestId('look-tab-behaviors').click();

    const clusters = page.getByTestId('behavior-after-query-clusters');
    await expect(clusters).toHaveValue(PROGRAM);
    await clusters.selectOption('');

    await page.getByTestId('toolbar-query').click();
    await page.getByTestId('graph-query-mode-sql').click();
    await page.getByTestId('graph-query-sql').fill('SELECT * FROM edges');
    await page.getByTestId('graph-query-run').click();
    await expect(page.getByTestId('graph-status-bar')).toContainText('5 nodes');
    // Communities still run (no geometry); the cluster program does not.
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('graph-status-clusters')).toHaveCount(0);
  });
});
