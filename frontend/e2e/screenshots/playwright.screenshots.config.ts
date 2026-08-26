import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for generating documentation screenshots.
 * Reuses the same mock infrastructure as E2E tests.
 *
 * Run with: npm run screenshots
 * Or:       make docs-screenshots
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'generate.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:3000',
    actionTimeout: 15_000,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'screenshots', use: { browserName: 'chromium' } },
  ],
  webServer: {
    command: 'npm run dev',
    port: 3000,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
