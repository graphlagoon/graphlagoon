import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT, MOCK_EXPLORATION } from '../fixtures/mock-data';
import { seedContexts, seedExplorations } from '../helpers/api-mocks';

/**
 * Layout regressions the graph page used to have (2026-08-28):
 *   - the top toolbar pushed its right-hand group past the viewport edge at
 *     1440px (document scrolled horizontally);
 *   - an unlayered `* { padding: 0 }` reset beat the PrimeVue theme layer, so
 *     Data Table cells had no padding and text sat flush against the borders;
 *   - the page height was `calc(100vh - 60px)` while the toolbar wraps to two
 *     rows under 768px, so the drawer ran off the bottom of the screen.
 */
/** No element may stick out of the viewport horizontally. */
async function assertNoHorizontalOverflow(page: import('@playwright/test').Page, width: number) {
  const result = await page.evaluate((w) => {
    const out: string[] = [];
    document.querySelectorAll('body *').forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.width > 0 && (b.right > w + 1 || b.left < -1)) {
        const e = el as HTMLElement;
        const cls = typeof e.className === 'string' ? e.className.split(' ')[0] : '';
        out.push(`${e.tagName}.${cls}`);
      }
    });
    return { scrollWidth: document.documentElement.scrollWidth, offenders: out.slice(0, 6) };
  }, width);
  expect(result.offenders, `elements past ${width}px`).toEqual([]);
  expect(result.scrollWidth).toBeLessThanOrEqual(width);
}

test.describe('Responsive layout', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
  });

  for (const [width, height] of [
    [1440, 900],
    [1024, 700],
    [600, 800],
  ] as const) {
    test(`graph page + data table fit the ${width}x${height} viewport`, async ({ authenticatedPage: page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Data Table').click();
      const drawer = page.locator('.data-table-drawer');
      await expect(drawer).toBeVisible();
      await expect(drawer.locator('.p-datatable-tbody > tr').first()).toBeVisible();

      const layout = await page.evaluate(() => {
        const td = document.querySelector('.p-datatable-tbody > tr > td') as HTMLElement;
        const right = document.querySelector('.toolbar-right')!.getBoundingClientRect();
        const drawer = document.querySelector('.data-table-drawer')!.getBoundingClientRect();
        return {
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          toolbarRight: right.right,
          drawerBottom: drawer.bottom,
          cellPaddingLeft: parseFloat(getComputedStyle(td).paddingLeft),
        };
      });

      // No document-level overflow in either axis.
      expect(layout.scrollWidth).toBeLessThanOrEqual(width);
      expect(layout.scrollHeight).toBeLessThanOrEqual(height);
      // Save / Export / user menu stay reachable; the drawer ends at the screen edge.
      expect(layout.toolbarRight).toBeLessThanOrEqual(width);
      expect(layout.drawerBottom).toBeLessThanOrEqual(height);
      // Cell text is inset from the border (PrimeVue theme padding applies).
      expect(layout.cellPaddingLeft).toBeGreaterThan(0);
    });
  }

  // The list pages used to push their row actions (Open / Check schema / Edit
  // / Share / Delete) off-screen at phone widths — measured to 626px in a
  // 390px viewport — and `.modal { min-width: 400px }` beat `max-width: 90vw`,
  // so every modal was wider than the screen below ~445px.
  for (const [width, height] of [
    [768, 900],
    [390, 844],
  ] as const) {
    test(`list pages and modals fit ${width}x${height}`, async ({ authenticatedPage: page }) => {
      await page.setViewportSize({ width, height });
      await seedExplorations(page, [MOCK_EXPLORATION]);

      await page.goto('/contexts');
      await expect(page.getByText(MOCK_CONTEXT.title)).toBeVisible({ timeout: 15_000 });
      await assertNoHorizontalOverflow(page, width);

      await page.goto('/explorations');
      await expect(page.getByText(MOCK_EXPLORATION.title)).toBeVisible({ timeout: 15_000 });
      await assertNoHorizontalOverflow(page, width);

      await page.goto('/contexts');
      await page.getByTestId('create-context-btn').click();
      await expect(page.getByRole('heading', { name: 'Create Graph Context' })).toBeVisible();
      await assertNoHorizontalOverflow(page, width);
    });
  }
});
