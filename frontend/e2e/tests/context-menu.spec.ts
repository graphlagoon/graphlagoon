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
 * Stops the force simulation via the Layout panel. Stop pins every node
 * (fx/fy/fz), so screen positions stay put no matter how slow the runner is —
 * without this, CI's low frame rate keeps the layout drifting for the whole
 * test and nodes escape between hover and click.
 */
async function freezeLayout(page: Page) {
  await page.getByTestId('graph-toolbar-layout').click();
  const runBtn = page.getByTestId('layout-run-btn');
  await expect(runBtn).toBeVisible();
  // Toggle until it reads "Run" (= stopped). The retry absorbs the race where
  // the simulation self-stops between reading the label and clicking.
  await expect(async () => {
    if ((await runBtn.innerText()).includes('Stop')) await runBtn.click();
    expect(await runBtn.innerText()).toContain('Run');
  }).toPass({ timeout: 10_000 });
  // Close the panel so it doesn't overlap the canvas
  await page.getByTestId('graph-toolbar-layout').click();
}

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
          // Generous timeout: the hover raycast runs once per frame and CI's
          // software-rendered frames can be several hundred ms apart
          await expect(canvas).toHaveClass(/clickable/, { timeout: 2_000 });
          return { x, y };
        } catch {
          // Camera still animating — node not under the pointer yet, retry
        }
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`could not hover node ${nodeId}`);
}

test.describe('Graph context menu', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    const statusBar = page.getByTestId('graph-status-bar');
    await expect(statusBar).toBeVisible({ timeout: 15_000 });
    await expect(statusBar).toContainText('5 nodes');
    await freezeLayout(page);
  });

  test('right-click with small pointer jitter opens the node context menu', async ({ authenticatedPage: page }) => {
    const menu = page.getByTestId('graph-context-menu');

    // With the old library-driven path this NEVER opened (any jitter counted as
    // a drag), so retrying doesn't mask the regression — it only absorbs
    // slow-frame flake on CI runners.
    let opened = false;
    for (let attempt = 0; attempt < 3 && !opened; attempt++) {
      const pos = await hoverNode(page, 'n1');

      // Right-click WITH 2px of jitter between press and release — the exact
      // sequence the library treats as a drag and used to swallow
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(pos.x + 2, pos.y + 1);
      await page.mouse.up({ button: 'right' });

      opened = await menu
        .waitFor({ state: 'visible', timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
    }

    expect(opened).toBe(true);
    await expect(menu).toContainText('node');
    await expect(page.getByTestId('context-menu-action-copy-id')).toBeVisible();
  });

  test('the menu is rendered inside the fullscreen element, so it stays visible in fullscreen', async ({ authenticatedPage: page }) => {
    // A native fullscreen element is rendered alone in the top layer: anything
    // outside its subtree is invisible. The menu teleports to <body>, so
    // fullscreen must be requested on the document (not the graph container)
    // for the menu to be a descendant of `document.fullscreenElement`.
    await page.getByTitle('Fullscreen', { exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);

    const menu = page.getByTestId('graph-context-menu');
    let opened = false;
    for (let attempt = 0; attempt < 3 && !opened; attempt++) {
      const pos = await hoverNode(page, 'n1');
      await page.mouse.down({ button: 'right' });
      await page.mouse.up({ button: 'right' });
      opened = await menu
        .waitFor({ state: 'visible', timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
    }
    expect(opened).toBe(true);

    const insideFullscreen = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="graph-context-menu"]');
      return !!el && !!document.fullscreenElement?.contains(el);
    });
    expect(insideFullscreen).toBe(true);
  });

  test('right-drag (camera pan/orbit) does not open the context menu', async ({ authenticatedPage: page }) => {
    const pos = await hoverNode(page, 'n1');

    await page.mouse.down({ button: 'right' });
    await page.mouse.move(pos.x + 80, pos.y + 60, { steps: 5 });
    await page.mouse.up({ button: 'right' });

    await expect(page.getByTestId('graph-context-menu')).toHaveCount(0);
  });
});
