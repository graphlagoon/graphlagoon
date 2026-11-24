/**
 * Two things only visible with the real canvas: an id in the details panel
 * moves the camera to its node or edge, and a grouping run with a filter on
 * says, and uses, only the nodes shown.
 */
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts, seedGraphResponse } from '../helpers/api-mocks';
import { partnerRegister } from '../fixtures/partner-register';
import { waitForLayoutDone } from '../helpers/graph-hooks';

test.describe('Focus from the details, groupings on what is visible', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedGraphResponse(page, partnerRegister(60));
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toContainText('63 nodes', { timeout: 15_000 });
    await waitForLayoutDone(page);
  });

  test('an edge\'s source in the side panel and in Open details goes to the node', async ({ authenticatedPage: page }) => {
    const edge = partnerRegister(60).edges[0];
    await page.evaluate((id) => (window as any).__GRAPH_SELECT_EDGE__(id), edge.edge_id);
    await page.screenshot({ path: test.info().outputPath('edge-panel.png') });
    // The edge's own id frames both of its ends.
    await page.getByTestId('selection-details-id').click();
    await expect.poll(() => page.evaluate(([a, b]) => {
      const c = document.querySelector('canvas')!.getBoundingClientRect();
      const at = (window as any).__GRAPH_NODE_SCREEN_COORDS__;
      const [p, q] = [at(a), at(b)];
      return Math.hypot((p.x + q.x) / 2 - c.width / 2, (p.y + q.y) / 2 - c.height / 2);
    }, [edge.src, edge.dst]), { timeout: 5000 }).toBeLessThan(20);
    await page.getByTestId('selection-details-src').click();
    await expect(page.getByTestId('selection-details-id')).toHaveText(edge.src);
    await expectCentred(page, edge.src);
    await page.screenshot({ path: test.info().outputPath('focused.png') });

    await page.evaluate((id) => (window as any).__GRAPH_SELECT_EDGE__(id), edge.edge_id);
    await page.getByRole('button', { name: 'Open details' }).click();
    await page.screenshot({ path: test.info().outputPath('detail-modal.png') });
    await page.getByTestId('detail-modal-ref-Target').click();
    await expect(page.getByTestId('detail-modal-ref-Target')).toHaveCount(0);
    await expect(page.getByTestId('selection-details-id')).toHaveText(edge.dst);
    await expectCentred(page, edge.dst);
  });

  test('Clusters runs on the visible nodes only, and says so', async ({ authenticatedPage: page }) => {
    const type = partnerRegister(60).nodes.at(-1)!.node_type;
    const shown = partnerRegister(60).nodes.filter((n) => n.node_type === type).length;
    await page.evaluate((t) => {
      const g = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('graph');
      g.applyFilters({ node_types: [t] });
    }, type);
    await page.getByRole('button', { name: 'Clusters' }).first().click();
    await expect(page.getByTestId('run-scope-note')).toContainText(`${shown} visible of 63 nodes`);
    await page.screenshot({ path: test.info().outputPath('scope.png') });
    await page.getByTestId('cluster-run').click();
    await expect(page.getByTestId('cluster-run-summary')).toBeVisible();
    const mapped = await page.evaluate(() =>
      (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('community').communityMap.size);
    expect(mapped).toBe(shown);
    await expect(page.getByTestId('groups-count')).not.toContainText('NaN'); // no edges shown

    // Showing everything again: the rest is in no group, and can be.
    await page.evaluate(() => {
      (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('graph').applyFilters({ node_types: [] });
    });
    await expect(page.getByTestId('groups-stale')).toContainText(`${63 - shown} visible nodes are in no group`);
    await page.screenshot({ path: test.info().outputPath('stale.png') });
    await page.getByTestId('groups-run-again').click();
    await expect(page.getByTestId('groups-stale')).toHaveCount(0);

    // A member's id leaves the table and goes to the node.
    await page.locator('[data-testid^="group-menu-community:"]').first().click();
    await page.locator('[data-testid^="group-members-community:"]').first().click();
    const link = page.locator('[data-testid^="member-link-"]').first();
    const id = (await link.textContent())!.trim();
    await link.click();
    await expect(page.getByTestId('community-node-modal')).toHaveCount(0);
    await expect(page.getByTestId('selection-details-id')).toHaveText(id);
    await expectCentred(page, id);
  });
});

/** The camera ends on the node: its screen position is the middle of the canvas. */
async function expectCentred(page: import('@playwright/test').Page, id: string) {
  await expect.poll(() => page.evaluate((nodeId) => {
    const c = document.querySelector('canvas')!.getBoundingClientRect();
    const p = (window as any).__GRAPH_NODE_SCREEN_COORDS__(nodeId);
    return p ? Math.hypot(p.x - c.width / 2, p.y - c.height / 2) : Infinity;
  }, id), { timeout: 5000 }).toBeLessThan(20);
}
