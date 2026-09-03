import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts } from '../helpers/api-mocks';

/**
 * Hover tooltips are configured with the label template language. The tooltip
 * is a DOM node (not the canvas font), so unlike labels it is directly
 * assertable — which is what these tests lean on.
 */

const CANVAS = '.graph3d-container canvas';

/** Stop the simulation so screen positions hold still on a slow runner. */
async function freezeLayout(page: Page) {
  await page.getByTestId('graph-toolbar-layout').click();
  const runBtn = page.getByTestId('layout-run-btn');
  await expect(runBtn).toBeVisible();
  await expect(async () => {
    if ((await runBtn.innerText()).includes('Stop')) await runBtn.click();
    expect(await runBtn.innerText()).toContain('Run');
  }).toPass({ timeout: 10_000 });
  await page.getByTestId('graph-toolbar-layout').click();
}

/** Point at a node and wait for the hover raycast to engage. */
async function hoverNode(page: Page, nodeId: string) {
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
        await page.mouse.move(box.x + coords.x, box.y + coords.y);
        try {
          await expect(canvas).toHaveClass(/clickable/, { timeout: 2_000 });
          return;
        } catch {
          // Camera still animating — retry.
        }
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`could not hover node ${nodeId}`);
}

test.describe('Hover tooltip templates', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await freezeLayout(page);
  });

  test('unconfigured, the tooltip shows the label and the type chip', async ({
    authenticatedPage: page,
  }) => {
    await hoverNode(page, 'n1');

    await expect(page.getByTestId('graph-tooltip')).toBeVisible();
    // Shape, not identity: a slow runner's raycast can land on a neighbour.
    await expect(page.getByTestId('graph-tooltip-body')).toHaveText(/^n\d$/);
    await expect(page.locator('.tooltip-type')).toHaveText(/^(Person|Company)$/);
  });

  /** Type the template into the panel and let the 400 ms debounce land. */
  async function setNodeTooltipTemplate(page: Page, template: string) {
    await page.getByTitle('Labels', { exact: true }).click();
    await page.getByTestId('labels-tab-tooltips').click();
    await page.getByTestId('tooltip-template-node').fill(template);
    await page.waitForTimeout(600);
    await page.getByTitle('Labels', { exact: true }).click();
  }

  test('a template drives the body, over several lines, and keeps the chip', async ({
    authenticatedPage: page,
  }) => {
    await setNodeTooltipTemplate(page, '{node_type}{br}id {node_id}');

    await hoverNode(page, 'n1');

    const body = page.getByTestId('graph-tooltip-body');
    await expect(body).toBeVisible();
    // {br} becomes a real line break (white-space: pre-line).
    await expect(body).toHaveText(/^(Person|Company)\nid n\d$/);
    // The template owns the body only — the type chip is structural.
    await expect(page.locator('.tooltip-type')).toHaveText(/^(Person|Company)$/);
  });

  test('a missing property renders the visible sentinel, not silence', async ({
    authenticatedPage: page,
  }) => {
    await setNodeTooltipTemplate(page, '{prop:no_such_column}');

    await hoverNode(page, 'n1');

    await expect(page.getByTestId('graph-tooltip-body')).toHaveText('[no_such_column]');
  });

  test('the panel reads the template back out of the store', async ({
    authenticatedPage: page,
  }) => {
    await setNodeTooltipTemplate(page, 'TIP {node_id}');

    await page.getByTitle('Labels', { exact: true }).click();
    await page.getByTestId('labels-tab-tooltips').click();
    await expect(page.getByTestId('tooltip-template-node')).toHaveValue('TIP {node_id}');
    await page.getByTitle('Labels', { exact: true }).click();

    await hoverNode(page, 'n2');
    await expect(page.getByTestId('graph-tooltip-body')).toHaveText(/^TIP n\d$/);
  });
});

test.describe('Tooltip-surface rules (rule editor modal)', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await freezeLayout(page);
  });

  test('a tooltip-surface rule drives the hover body and leaves the label alone', async ({
    authenticatedPage: page,
  }) => {
    // Create the rule through the modal, from the Tooltips tab — its + button
    // opens the editor already preset to the tooltip surface.
    await page.getByTitle('Labels', { exact: true }).click();
    await page.getByTestId('labels-tab-tooltips').click();
    await page.locator('.add-rule-btn').click();

    const modal = page.getByTestId('rule-editor-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('rule-surface')).toHaveValue('tooltip');
    await expect(modal.getByTestId('rule-priority')).toHaveValue('100');
    await modal.getByTestId('rule-name').fill('Person tips');
    await modal.getByTestId('rule-types').getByText('Person', { exact: true }).click();
    await modal.getByTestId('rule-template').fill('RULE {node_id|upper}');
    await modal.getByTestId('rule-save').click();
    await expect(modal).toHaveCount(0);

    // The list shows the surface chip; close the panel.
    await expect(page.locator('.rule-surface')).toHaveText('tooltip');
    await page.getByTitle('Labels', { exact: true }).click();

    // Hovering a Person shows the rule's body — the type chip stays. Under a
    // slow runner the raycast can land on a neighbouring Person, so assert the
    // rule's shape rather than which node was hit.
    await hoverNode(page, 'n1');
    await expect(page.getByTestId('graph-tooltip-body')).toHaveText(/^RULE N\d$/);
    await expect(page.locator('.tooltip-type')).toHaveText('Person');
  });

  test('Escape closes the modal without saving', async ({ authenticatedPage: page }) => {
    await page.getByTitle('Labels', { exact: true }).click();
    await page.locator('.add-rule-btn').click();
    await expect(page.getByTestId('rule-editor-modal')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByTestId('rule-editor-modal')).toHaveCount(0);
  });
});
