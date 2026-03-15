import { defineConfig } from '@playwright/test';

/**
 * Integration test config — requires the full stack running:
 *   1. PostgreSQL:    make db-up && make migrate
 *   2. Warehouse:     make run-warehouse
 *   3. REST API:      make run-api-db
 *   4. Frontend:      (started automatically by Playwright)
 *
 * Run with: npm run e2e:integration
 * Or:       make test-integration
 */
export default defineConfig({
  testDir: './tests/integration',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:3000',
    actionTimeout: 10_000,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: '../playwright-report-integration', open: 'never' }],
  ],
  outputDir: '../test-results-integration',
  projects: [
    {
      name: 'integration',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'npm run dev',
    port: 3000,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
