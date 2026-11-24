import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts } from '../helpers/api-mocks';

/**
 * Labels → Import JSON: one paste sets the labels of several types at once.
 * Canvas labels are pixels, so the proof that an import reaches the renderer
 * is a tooltip-surface rule — the tooltip is a DOM node.
 */

const CANVAS = '.graph3d-container canvas';

const IMPORT = {
  defaults: { nodeTemplate: '{prop:name|truncate:20:...}' },
  rules: [
    { name: 'Person tip', target: 'node', types: ['Person'], template: 'P {node_id}', surface: 'tooltip' },
    { name: 'Company tip', target: 'node', types: ['Company'], template: 'C {node_id}', surface: 'tooltip' },
    { name: 'Knows', target: 'edge', types: ['KNOWS'], template: 'knows' },
  ],
};

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

async function openLabels(page: Page) {
  await page.getByTestId('toolbar-look').click();
  await page.getByTestId('look-tab-labels').click();
}

async function hoverNode(page: Page, nodeId: string) {
  const canvas = page.locator(CANVAS);
  for (let attempt = 0; attempt < 30; attempt++) {
    const coords = await page.evaluate(
      (id) => (window as any).__GRAPH_NODE_SCREEN_COORDS__?.(id) as { x: number; y: number } | null,
      nodeId,
    );
    const box = coords && (await canvas.boundingBox());
    if (coords && box) {
      await page.mouse.move(box.x + coords.x, box.y + coords.y);
      try {
        await expect(canvas).toHaveClass(/clickable/, { timeout: 2_000 });
        return;
      } catch {
        // Camera still animating — retry.
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`could not hover node ${nodeId}`);
}

test.describe('Labels: import / export JSON', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await freezeLayout(page);
  });

  test('one import sets rules for several types, reaches the canvas, and can be undone', async ({
    authenticatedPage: page,
  }) => {
    await openLabels(page);
    await page.getByTestId('label-import-toggle').click();
    await page.getByTestId('label-import-text').fill(JSON.stringify(IMPORT));
    await expect(page.getByTestId('label-import-summary')).toContainText('3 rules for 3 types');
    await page.getByTestId('label-import-apply').click();

    // The Labels tab lists the label rule; the two tooltip rules are on the other tab.
    await expect(page.locator('.rule-item .rule-name')).toHaveText(['Knows']);
    await page.getByTestId('labels-tab-tooltips').click();
    await expect(page.locator('.rule-item .rule-name')).toHaveText(['Person tip', 'Company tip']);
    await page.getByTestId('toolbar-look').click();

    await hoverNode(page, 'n1');
    await expect(page.getByTestId('graph-tooltip-body')).toHaveText(/^(P|C) n\d$/);

    await page.mouse.move(0, 0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await openLabels(page);
    await page.getByTestId('labels-tab-tooltips').click();
    await expect(page.locator('.rule-item')).toHaveCount(0);
  });

  test('a broken rule is named and nothing is applied', async ({ authenticatedPage: page }) => {
    await openLabels(page);
    await page.getByTestId('label-import-toggle').click();
    await page
      .getByTestId('label-import-text')
      .fill(JSON.stringify({ rules: [IMPORT.rules[2], { name: 'Broken', target: 'node', template: '{prop:name' }] }));

    await expect(page.getByTestId('label-import-parse-error')).toContainText('Rule 2 ("Broken")');
    await expect(page.getByTestId('label-import-apply')).toBeDisabled();
    await expect(page.locator('.rule-item')).toHaveCount(0);
  });

  test('export downloads the labels in the portable envelope', async ({ authenticatedPage: page }) => {
    await openLabels(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('label-export').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^labels-.*\.json$/);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(payload.graphlagoon_export).toBe('label-formats');
    expect(payload.textFormat.defaults.edgeTemplate).toBe('{relationship_type}');
  });
});
