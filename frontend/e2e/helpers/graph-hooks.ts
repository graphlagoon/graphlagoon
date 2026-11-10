/**
 * Dev-only window hooks the canvas installs (GraphCanvas3D): the WebGL scene is
 * opaque to DOM selectors, so specs read node state through them.
 */
import type { Page } from '@playwright/test';

/**
 * The sphere/icon state of one node, read straight from graphData once the
 * graph holding it is built and laid out.
 *
 * Deliberately not rendering-dependent: `color` and `__iconColor` are plain JS
 * state written by updateVisuals(), so these assertions hold identically on a
 * GPU and on CI's software renderer.
 *
 * `__GRAPH_LAYOUT_DONE__` alone is not a readiness signal here: it turns true
 * on the initial (empty) mount and stays true while a large fresh load empties
 * the scene for its headless settle — on a slow runner that leaves seconds of
 * "done" over an empty graph. Waiting for the node itself closes that window.
 * The state is captured by the same poll that first sees the node, i.e. the
 * earliest post-swap state, so a regression that only heals on a later camera
 * idle still fails.
 */
export async function waitForNodeVisualState(page: Page, nodeId: string) {
  try {
    const handle = await page.waitForFunction(
      (id) => {
        const w = window as any;
        if (!w.__GRAPH_LAYOUT_DONE__?.()) return null;
        return w.__GRAPH_NODE_VISUAL_STATE__?.(id) ?? null;
      },
      nodeId,
      { timeout: 30_000 },
    );
    return (await handle.jsonValue()) as { color: string; iconColor?: string; hidden?: boolean };
  } catch (error) {
    const hookInstalled = await page.evaluate(
      () => typeof (window as any).__GRAPH_NODE_VISUAL_STATE__ === 'function',
    );
    throw new Error(
      hookInstalled
        ? `node ${nodeId} never appeared in a laid-out graph: ${error}`
        : 'no __GRAPH_NODE_VISUAL_STATE__ hook: the app is a production build without the dev hooks',
    );
  }
}

/** Wait for the first layout to settle. */
export async function waitForLayoutDone(page: Page) {
  await page.waitForFunction(() => (window as any).__GRAPH_LAYOUT_DONE__?.() === true, undefined, { timeout: 30_000 });
}
