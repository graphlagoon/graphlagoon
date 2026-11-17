/**
 * Hubs with many leaves: the Layout panel lays a hub's leaves next to it
 * (utils/hubLeaves.ts). The geometry is unit tested; what is only observable
 * here is the seam — the panel drives it, no node disappears, and the status
 * bar says that the hub edges are not drawn and puts them back. By default the
 * arrangement is automatic (utils/autoAdjust.ts): a hub with 30+ leaves is
 * arranged without asking, and the status bar says that too.
 */
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts, seedGraphResponse } from '../helpers/api-mocks';
import { partnerRegister } from '../fixtures/partner-register';

test.describe('Hubs with many leaves', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedGraphResponse(page, partnerRegister(60));
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toContainText('63 nodes', { timeout: 15_000 });
    await page.getByTestId('graph-toolbar-layout').click();
  });

  test('automatic by default: the hub is arranged, the status bar says so, and ✕ leaves it to the simulation', async ({
    authenticatedPage: page,
  }) => {
    // 57 leaves (60 partners minus the 3 with a second company) ≥ 30: arranged without asking.
    await expect(page.getByTestId('hub-leaves-mode')).toHaveValue('auto');
    await expect(page.getByTestId('status-auto-hub-leaves')).toContainText('Auto: 1 hub arranged');
    await expect(page.getByTestId('hub-leaves-stats')).toContainText('57 leaves arranged');
    // The role on the edge splits the partners: petals by it.
    await expect(page.getByTestId('hub-leaves-auto-shapes')).toContainText('petals (1)');
    await expect(page.getByTestId('hub-leaves-auto-keys')).toContainText('edge role');
    await expect(page.getByTestId('status-hub-edges-implied')).toContainText('57 hub edges not drawn');
    await expect(page.getByTestId('graph-status-nodes')).toHaveText('63 nodes');

    await page.getByTestId('status-auto-hub-leaves-off').click();
    await expect(page.getByTestId('hub-leaves-mode')).toHaveValue('free');
    await expect(page.getByTestId('status-auto-hub-leaves')).toHaveCount(0);
    await expect(page.getByTestId('status-hub-edges-implied')).toHaveCount(0);

    // The chip's verb changed the layout, so the toast can put it back.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId('hub-leaves-mode')).toHaveValue('auto');
    await expect(page.getByTestId('status-auto-hub-leaves')).toBeVisible();
  });

  test('the master switch in Behaviors turns the automatic arrangement off without changing the setting', async ({ authenticatedPage: page }) => {
    await expect(page.getByTestId('status-auto-hub-leaves')).toBeVisible();
    await page.evaluate(() => {
      const g = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('graph');
      g.updateBehaviors({ autoAdjust: false });
    });
    await expect(page.getByTestId('status-auto-hub-leaves')).toHaveCount(0);
    await expect(page.getByTestId('status-hub-edges-implied')).toHaveCount(0);
    await expect(page.getByTestId('hub-leaves-auto-hint')).toContainText('Automatic adjustments are off');
    // The setting itself is untouched: still Automatic.
    await expect(page.getByTestId('hub-leaves-mode')).toHaveValue('auto');
  });

  test('petals by an edge property: every node stays, the hub edges are said to be undrawn and come back', async ({
    authenticatedPage: page,
  }) => {
    await page.getByTestId('hub-leaves-mode').selectOption('petals');
    await page.getByTestId('hub-leaves-key').selectOption('edge:role');

    await expect(page.getByTestId('status-auto-hub-leaves')).toHaveCount(0);
    await expect(page.getByTestId('hub-leaves-stats')).toContainText('1 hub');
    await expect(page.getByTestId('hub-leaves-stats')).toContainText('57 leaves arranged');
    await expect(page.getByTestId('status-hub-edges-implied')).toContainText('57 hub edges not drawn');
    await expect(page.getByTestId('graph-status-nodes')).toHaveText('63 nodes');

    await page.getByTestId('status-hub-edges-draw').click();
    await expect(page.getByTestId('status-hub-edges-implied')).toHaveCount(0);
    await expect(page.getByTestId('hub-leaves-implicit')).not.toBeChecked();
  });

  test('turning it on with the layout stopped still arranges the leaves', async ({ authenticatedPage: page }) => {
    await page.getByTestId('hub-leaves-mode').selectOption('free');
    await expect(page.getByTestId('status-hub-edges-implied')).toHaveCount(0);
    // A stopped layout runs no simulation tick: the arrangement must not depend on one.
    const run = page.getByTestId('layout-run-btn');
    if ((await run.textContent())?.includes('Stop')) await run.click();
    await expect(run).toContainText('Run');

    await page.getByTestId('hub-leaves-mode').selectOption('crown');
    await expect(page.getByTestId('status-hub-edges-implied')).toContainText('57 hub edges not drawn');
  });

  test('a threshold above every hub says so; Free turns it off', async ({ authenticatedPage: page }) => {
    await page.getByTestId('hub-leaves-mode').selectOption('crown');
    await expect(page.getByTestId('status-hub-edges-implied')).toContainText('57');

    await page.getByTestId('hub-leaves-min').fill('100');
    await expect(page.getByTestId('hub-leaves-stats')).toContainText('No node has 100 or more leaves');
    await expect(page.getByTestId('status-hub-edges-implied')).toHaveCount(0);

    await page.getByTestId('hub-leaves-mode').selectOption('free');
    await expect(page.getByTestId('hub-leaves-stats')).toHaveCount(0);
  });

  test('in 3D the panel says the arrangement is 2D only and switches', async ({ authenticatedPage: page }) => {
    await page.getByTestId('hub-leaves-mode').selectOption('crown');
    await page.getByTestId('canvas-toolbar-3d').click();
    await expect(page.getByTestId('status-hub-edges-implied')).toHaveCount(0);
    // The Layout panel stays open across the view switch.
    await expect(page.getByTestId('hub-leaves-3d-hint')).toBeVisible();
    await page.getByTestId('hub-leaves-to-2d').click();
    await expect(page.getByTestId('status-hub-edges-implied')).toContainText('57');
  });
});
