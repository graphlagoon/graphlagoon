import type { Page } from '@playwright/test';

/**
 * Opens the account menu in the toolbar.
 *
 * DEV, Admin and Precomputed live in there since 2026-09-03: they are used by
 * a minority, rarely, and each one cost the toolbar permanent width — with
 * both nav links showing, the left group measured 874px and pushed the panel
 * toggles off the screen.
 */
export async function openUserMenu(page: Page) {
  await page.getByTestId('user-menu-btn').click();
  await page.locator('.user-menu-dropdown').waitFor({ state: 'visible' });
}
