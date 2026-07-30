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

// Graph size for the mocked payload. The defaults are deliberately small (fast
// smoke run); raise them to profile the load path at a realistic scale, e.g.
//   PERF_NODES=20000 PERF_EDGES=40000 PERF_PROPS=30 make perf-report
const NODE_COUNT = parseInt(process.env.PERF_NODES || '50', 10);
const EDGE_COUNT = parseInt(process.env.PERF_EDGES || '80', 10);
// Properties per node: the field that dominates payload size and reactive-wrap
// cost while contributing nothing to rendering — the whole premise of the
// progressive-load work, so it must be tunable in the baseline.
const PROPS_PER_NODE = parseInt(process.env.PERF_PROPS || '1', 10);

// ---------------------------------------------------------------------------
// Minimal mock data (inline to avoid import issues outside of Playwright test)
// ---------------------------------------------------------------------------

const MOCK_CONFIG = { dev_mode: true, database_enabled: false };

function buildNodeProperties(i: number): Record<string, unknown> {
  const props: Record<string, unknown> = { name: `Node ${i}` };
  for (let p = 1; p < PROPS_PER_NODE; p++) {
    props[`prop_${p}`] = `value_${i}_${p}`;
  }
  return props;
}

const MOCK_GRAPH_RESPONSE = {
  nodes: Array.from({ length: NODE_COUNT }, (_, i) => ({
    node_id: `n${i}`,
    node_type: i % 3 === 0 ? 'Person' : i % 3 === 1 ? 'Company' : 'Product',
    properties: buildNodeProperties(i),
  })),
  edges: Array.from({ length: EDGE_COUNT }, (_, i) => ({
    edge_id: `e${i}`,
    src: `n${i % NODE_COUNT}`,
    dst: `n${(i * 3 + 7) % NODE_COUNT}`,
    relationship_type: i % 2 === 0 ? 'WORKS_AT' : 'BOUGHT',
    properties: {},
  })),
  truncated: false,
  // Mirrors the shape the backend sends so the load:*:backend entries are
  // exercised end-to-end rather than silently skipped.
  metadata: {
    total_ms: 0,
    edge_query_ms: 0,
    node_query_ms: 0,
    node_count: NODE_COUNT,
    edge_count: EDGE_COUNT,
  },
};

const MOCK_CONTEXTS = [
  {
    id: 'perf-ctx',
    name: 'Perf Test Context',
    edge_table: 'edges',
    node_tables: ['nodes'],
    // Required: opening a context fetches nothing by default, and this harness measures the
    // render of the graph loaded on open. Without the opt-in it would benchmark an empty graph.
    default_behaviors: { autoLoadOnOpen: true },
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
  // Single-context fetch: loadContext() hits this before any graph data, and it
  // gates autoLoadOnOpen. Without it the view errors out and nothing renders.
  await page.route('**/graphlagoon/api/graph-contexts/perf-ctx', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_CONTEXTS[0]),
    }),
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

  // Navigate straight to the graph route. Landing on the app root only renders
  // the context list, so the load path under measurement never runs and the
  // report comes back empty.
  const graphUrl = `${BASE_URL.replace(/\/$/, '')}/graph/${MOCK_CONTEXTS[0].id}`;
  try {
    await page.goto(graphUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  } catch {
    console.error(`Failed to connect to ${graphUrl}. Is the dev server running? (make dev or make run-frontend)`);
    await browser.close();
    process.exit(1);
  }

  // Wait for rendering + force layout to settle
  await page.waitForTimeout(WAIT_MS);

  // Fail loudly rather than emitting an empty report that looks like a
  // successful zero-cost run.
  const entryCount = await page.evaluate(
    () => ((window as any).__PERF_METRICS__?.entries ?? []).length,
  );
  if (entryCount === 0) {
    console.error(
      `No perf entries recorded at ${graphUrl}. The graph never loaded — check the API mocks ` +
        `and that the dev server is running a DEV build (recordPerf is a no-op in PROD).`,
    );
    await browser.close();
    process.exit(1);
  }

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
