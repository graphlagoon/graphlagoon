/**
 * Performance Report Script
 *
 * Connects to a running dev server, loads the app with mocked API data,
 * waits for rendering, and dumps all performance metrics as JSON to stdout.
 *
 * Usage:
 *   npx tsx frontend/e2e/perf-report.ts                  # defaults to http://localhost:3000
 *   npx tsx frontend/e2e/perf-report.ts http://localhost:5173
 *   make perf-report                                     # from project root
 *
 * What it collects:
 *   - window.__PERF_METRICS__  (custom timing entries from recordPerf)
 *   - window.__THREE_RENDERER_INFO__  (Three.js render/memory stats)
 *   - performance.getEntriesByType('measure')  (User Timing API)
 *   - CDP Performance.getMetrics  (JS heap, layout count, frames, etc.)
 *   - performance.memory  (Chrome-specific heap info)
 */

import { chromium } from 'playwright';

const BASE_URL = process.argv[2] || 'http://localhost:3000';
const WAIT_MS = parseInt(process.env.PERF_WAIT_MS || '5000', 10);

// ---------------------------------------------------------------------------
// Minimal mock data (inline to avoid import issues outside of Playwright test)
// ---------------------------------------------------------------------------

const MOCK_CONFIG = { dev_mode: true, database_enabled: false };

const MOCK_GRAPH_RESPONSE = {
  nodes: Array.from({ length: 50 }, (_, i) => ({
    node_id: `n${i}`,
    node_type: i % 3 === 0 ? 'Person' : i % 3 === 1 ? 'Company' : 'Product',
    properties: { name: `Node ${i}` },
  })),
  edges: Array.from({ length: 80 }, (_, i) => ({
    edge_id: `e${i}`,
    src: `n${i % 50}`,
    dst: `n${(i * 3 + 7) % 50}`,
    relationship_type: i % 2 === 0 ? 'WORKS_AT' : 'BOUGHT',
    properties: {},
  })),
};

const MOCK_CONTEXTS = [
  {
    id: 'perf-ctx',
    name: 'Perf Test Context',
    edge_table: 'edges',
    node_tables: ['nodes'],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Enable CDP Performance domain
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');

  // Inject config before any script runs
  await page.addInitScript(() => {
    (window as any).__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, database_enabled: false };
    localStorage.setItem('userEmail', 'perf@test.com');
  });

  // Set up API mocks (inline route interception)
  await page.route('**/graphlagoon/api/config', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_CONFIG) }),
  );
  await page.route('**/graphlagoon/api/graph-contexts', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_CONTEXTS) }),
  );
  await page.route('**/graphlagoon/api/graph-contexts/*/subgraph', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_GRAPH_RESPONSE),
    }),
  );
  await page.route('**/graphlagoon/api/graph-contexts/*/expand', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_GRAPH_RESPONSE),
    }),
  );
  await page.route('**/graphlagoon/api/graph-contexts/*/query', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_GRAPH_RESPONSE),
    }),
  );
  await page.route('**/graphlagoon/api/graph-contexts/*/cypher', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_GRAPH_RESPONSE),
    }),
  );
  await page.route('**/graphlagoon/api/explorations**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/graphlagoon/api/datasets**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ edge_tables: ['edges'], node_tables: ['nodes'] }),
    }),
  );

  // Navigate to the app
  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  } catch {
    console.error(`Failed to connect to ${BASE_URL}. Is the dev server running? (make dev or make run-frontend)`);
    await browser.close();
    process.exit(1);
  }

  // Wait for rendering + force layout to settle
  await page.waitForTimeout(WAIT_MS);

  // Collect all metrics
  const report = await page.evaluate(() => {
    // Custom perf entries
    const perfHandle = (window as any).__PERF_METRICS__;
    const perfEntries = perfHandle?.entries ?? [];
    const perfSummary = perfHandle?.summary?.() ?? [];

    // Three.js renderer info
    const threeInfoFn = (window as any).__THREE_RENDERER_INFO__;
    const threeInfo = threeInfoFn ? threeInfoFn() : null;

    // User Timing API entries
    const userTiming = performance.getEntriesByType('measure').map((e) => ({
      name: e.name,
      duration: e.duration,
      startTime: e.startTime,
    }));

    // Chrome-specific memory info
    const memory = (performance as any).memory
      ? {
          usedJSHeapSize: (performance as any).memory.usedJSHeapSize,
          totalJSHeapSize: (performance as any).memory.totalJSHeapSize,
          jsHeapSizeLimit: (performance as any).memory.jsHeapSizeLimit,
        }
      : null;

    return {
      timestamp: new Date().toISOString(),
      perfEntries,
      perfSummary,
      threeInfo,
      userTiming,
      memory,
    };
  });

  // CDP metrics (JS heap, layout counts, frames, etc.)
  const cdpResult = await cdp.send('Performance.getMetrics');
  const cdpMetrics: Record<string, number> = {};
  for (const m of cdpResult.metrics) {
    cdpMetrics[m.name] = m.value;
  }
  (report as any).cdpMetrics = cdpMetrics;

  // Output
  console.log(JSON.stringify(report, null, 2));

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
