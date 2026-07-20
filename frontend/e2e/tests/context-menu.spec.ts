import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts } from '../helpers/api-mocks';

/**
 * Regression tests for the intermittent right-click context menu (the 3D graph
 * library used to swallow right-clicks whenever the pointer jittered even 1px
 * between press and release — the menu is now opened by an app-level mouseup
 * handler with a 5px drag threshold).
 */

const CANVAS = '.graph3d-container canvas';

/**
 * Moves the pointer over the given node and waits until the hover raycast
 * actually engages (the graph lib adds a `clickable` class to the canvas when a
 * node is hovered). Node screen coords come from the dev-only
 * __GRAPH_NODE_SCREEN_COORDS__ hook — WebGL is opaque to DOM selectors.
 * Returns the node's page coordinates.
 */
async function hoverNode(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  const canvas = page.locator(CANVAS);
  await expect(canvas).toBeVisible({ timeout: 15_000 });

  for (let attempt = 0; attempt < 30; attempt++) {
    const coords = await page.evaluate(
      (id) => (window as any).__GRAPH_NODE_SCREEN_COORDS__?.(id) as { x: number; y: number } | null,
      nodeId,
    );
    if (coords) {
      const box = await canvas.boundingBox();
      if (box) {
        const x = box.x + coords.x;
        const y = box.y + coords.y;
        await page.mouse.move(x, y);
        try {
          await expect(canvas).toHaveClass(/clickable/, { timeout: 500 });
          return { x, y };
        } catch {
          // Layout/camera still moving — node not under the pointer yet, retry
        }
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`could not hover node ${nodeId} (layout never settled?)`);
}

test.describe('Graph context menu', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    const statusBar = page.getByTestId('graph-status-bar');
    await expect(statusBar).toBeVisible({ timeout: 15_000 });
    await expect(statusBar).toContainText('5 nodes');
  });

  test('right-click with small pointer jitter opens the node context menu', async ({ authenticatedPage: page }) => {
    const menu = page.getByTestId('graph-context-menu');

    // With the old library-driven path this NEVER opened (any jitter counted as
    // a drag), so retrying doesn't mask the regression — it only absorbs
    // layout-drift flake under load.
    let opened = false;
    for (let attempt = 0; attempt < 3 && !opened; attempt++) {
      const pos = await hoverNode(page, 'n1');

      // Right-click WITH 2px of jitter between press and release — the exact
      // sequence the library treats as a drag and used to swallow
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(pos.x + 2, pos.y + 1);
      await page.mouse.up({ button: 'right' });

      opened = await menu.isVisible();
      if (!opened) await page.waitForTimeout(300);
    }

    expect(opened).toBe(true);
    await expect(menu).toContainText('node');
    await expect(page.getByTestId('context-menu-action-copy-id')).toBeVisible();
  });

  test('right-drag (camera pan/orbit) does not open the context menu', async ({ authenticatedPage: page }) => {
    const pos = await hoverNode(page, 'n1');

    await page.mouse.down({ button: 'right' });
    await page.mouse.move(pos.x + 80, pos.y + 60, { steps: 5 });
    await page.mouse.up({ button: 'right' });

    await expect(page.getByTestId('graph-context-menu')).toHaveCount(0);
  });
});
