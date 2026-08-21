import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT, MOCK_GRAPH_RESPONSE } from '../fixtures/mock-data';
import { seedContexts } from '../helpers/api-mocks';

/**
 * Progressive load: the graph must be usable before node properties arrive.
 *
 * These tests drive the real two-request flow (types-only subgraph, then a
 * /nodes/batch enrichment) rather than the default single-shot mock, so a
 * regression that silently reverts to blocking on properties is caught.
 */
test.describe('Progressive load', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
  });

  /**
   * Serve a types-only subgraph, and hold the enrichment batch until released
   * so the "properties have not arrived yet" window is deterministic.
   */
  async function mockDeferredLoad(page: any) {
    let releaseBatch: () => void = () => {};
    const batchGate = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });

    await page.route('**/graphlagoon/api/graph-contexts/*/subgraph', (route: any) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          nodes: MOCK_GRAPH_RESPONSE.nodes.map((n) => ({
            node_id: n.node_id,
            node_type: n.node_type,
            properties: null,
          })),
          edges: MOCK_GRAPH_RESPONSE.edges,
          truncated: false,
          properties_deferred: true,
        }),
      });
    });

    await page.route('**/graphlagoon/api/graph-contexts/*/nodes/batch', async (route: any) => {
      await batchGate;
      const wanted = new Set(route.request().postDataJSON()?.node_ids ?? []);
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          nodes: MOCK_GRAPH_RESPONSE.nodes.filter((n) => wanted.has(n.node_id)),
        }),
      });
    });

    return () => releaseBatch();
  }

  test('graph renders before node properties arrive', async ({ authenticatedPage: page }) => {
    const releaseBatch = await mockDeferredLoad(page);

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);

    // The status bar reports the graph while enrichment is still blocked —
    // this is the whole point of the feature.
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('graph-status-bar')).toContainText(
      String(MOCK_GRAPH_RESPONSE.nodes.length),
      { timeout: 15_000 },
    );

    releaseBatch();
  });

  test('requests types-only nodes, then enriches in a second call', async ({
    authenticatedPage: page,
  }) => {
    const subgraphBodies: any[] = [];
    const batchBodies: any[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/subgraph')) subgraphBodies.push(req.postDataJSON());
      if (req.url().includes('/nodes/batch')) batchBodies.push(req.postDataJSON());
    });

    const releaseBatch = await mockDeferredLoad(page);
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    // The 'request' event fires asynchronously relative to the status bar
    // becoming visible — poll instead of indexing synchronously, or a slow
    // CI runner can observe the array before it's populated.
    await expect.poll(() => subgraphBodies.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(subgraphBodies[0]?.nodes_mode).toBe('types');

    releaseBatch();
    await expect.poll(() => batchBodies.length, { timeout: 15_000 }).toBeGreaterThan(0);
    // Enrichment must ask only for the nodes it actually received.
    expect(batchBodies[0].node_ids.length).toBeGreaterThan(0);
    expect(batchBodies[0].node_ids.length).toBeLessThanOrEqual(
      MOCK_GRAPH_RESPONSE.nodes.length,
    );
  });

  test('shows an enrichment indicator that clears once properties land', async ({
    authenticatedPage: page,
  }) => {
    const releaseBatch = await mockDeferredLoad(page);

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-enriching')).toBeVisible({
      timeout: 15_000,
    });

    releaseBatch();

    await expect(page.getByTestId('graph-status-enriching')).toHaveCount(0, {
      timeout: 15_000,
    });
  });

  test('the Behaviors panel switches property loading for the current session', async ({
    authenticatedPage: page,
  }) => {
    // NOTE ON PERSISTENCE: like every other behavior, this setting is
    // session-scoped. It survives a reload only when written to the context's
    // default_behaviors or saved into an exploration — a page reload alone
    // resets it. The test therefore asserts the in-session effect.
    const bodies: any[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/subgraph')) bodies.push(req.postDataJSON());
    });

    const releaseBatch = await mockDeferredLoad(page);
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    releaseBatch();

    // The 'request' event fires asynchronously relative to the status bar
    // becoming visible — poll instead of indexing synchronously, or a slow
    // CI runner can observe the array before it's populated (flaky
    // "Cannot read properties of undefined" on bodies[0]).
    await expect.poll(() => bodies.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(bodies[0].nodes_mode).toBe('types');

    await page.getByRole('button', { name: 'Behaviors' }).click();
    // The control lives behind the Advanced disclosure, like the other
    // load-shaping settings.
    const advanced = page.getByText('Advanced', { exact: true });
    if (await advanced.isVisible().catch(() => false)) await advanced.click();
    await page.getByTestId('progressive-load-never').check();
    await expect(page.getByTestId('progressive-load-never')).toBeChecked();

    // Changing the mode must not itself refetch — it only decides how the NEXT
    // load is shaped. (The store reads `behaviors` at loadSubgraph time.)
    expect(bodies.length).toBe(1);
  });

  test('the panel reflects the context default for property loading', async ({
    authenticatedPage: page,
  }) => {
    const releaseBatch = await mockDeferredLoad(page);
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    releaseBatch();

    await page.getByRole('button', { name: 'Behaviors' }).click();
    const advanced = page.getByText('Advanced', { exact: true });
    if (await advanced.isVisible().catch(() => false)) await advanced.click();

    // 'auto' is the default and must be the selected radio out of the box.
    await expect(page.getByTestId('progressive-load-auto')).toBeChecked();
  });

  test('the enrichment indicator clears after a query, not just a subgraph', async ({
    authenticatedPage: page,
  }) => {
    // Regression: the query path raised the indicator when it drew a partial
    // but never lowered it, so "loading properties…" stayed up for good.
    // A plain flag, not a promise race: racing against Promise.resolve(false)
    // always settles false, so the job would never reach "succeeded".
    let jobDone = false;
    const releaseJob = () => {
      jobDone = true;
    };

    const partial = {
      nodes: MOCK_GRAPH_RESPONSE.nodes.map((n) => ({
        node_id: n.node_id,
        node_type: n.node_type,
        properties: null,
      })),
      edges: MOCK_GRAPH_RESPONSE.edges,
      truncated: false,
      properties_deferred: true,
    };

    await page.route('**/graphlagoon/api/graph-contexts/*/query/async', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ job_id: 'job-1', status: 'running' }),
      });
    });
    await page.route('**/graphlagoon/api/graph-contexts/*/query/job/**', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      // Hold in "running with a partial" until released, then succeed.
      const done = jobDone;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          done
            ? {
                job_id: 'job-1',
                status: 'succeeded',
                result: { ...MOCK_GRAPH_RESPONSE, truncated: false },
                partial_seq: 1,
              }
            : { job_id: 'job-1', status: 'running', partial, partial_seq: 1 },
        ),
      });
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('toolbar-query').click();
    await page.getByTestId('graph-query-mode-sql').click();
    await page.getByTestId('graph-query-sql').fill('SELECT 1 AS r');
    await page.getByTestId('graph-query-run').click();

    await expect(page.getByTestId('graph-status-enriching')).toBeVisible({
      timeout: 15_000,
    });

    releaseJob();

    await expect(page.getByTestId('graph-status-enriching')).toHaveCount(0, {
      timeout: 20_000,
    });
  });

  test('shows a truncation warning when the edge limit was hit', async ({
    authenticatedPage: page,
  }) => {
    // A truncated graph looks exactly like a complete one — the badge is the
    // only thing telling the user their view is partial.
    await page.route('**/graphlagoon/api/graph-contexts/*/subgraph', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...MOCK_GRAPH_RESPONSE, truncated: true }),
      });
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);

    await expect(page.getByTestId('graph-status-truncated')).toBeVisible({
      timeout: 15_000,
    });
  });

  test('hides the truncation warning for a complete graph', async ({
    authenticatedPage: page,
  }) => {
    await page.route('**/graphlagoon/api/graph-contexts/*/subgraph', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...MOCK_GRAPH_RESPONSE, truncated: false }),
      });
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId('graph-status-truncated')).toHaveCount(0);
  });

  test('graph stays intact when enrichment fails', async ({ authenticatedPage: page }) => {
    await page.route('**/graphlagoon/api/graph-contexts/*/subgraph', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          nodes: MOCK_GRAPH_RESPONSE.nodes.map((n) => ({
            node_id: n.node_id,
            node_type: n.node_type,
            properties: null,
          })),
          edges: MOCK_GRAPH_RESPONSE.edges,
          truncated: false,
          properties_deferred: true,
        }),
      });
    });
    await page.route('**/graphlagoon/api/graph-contexts/*/nodes/batch', (route) => {
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);

    // Enrichment is best-effort: a failed batch must not blank the graph or
    // raise a blocking error over an already-usable visualisation.
    await expect(page.getByTestId('graph-status-bar')).toContainText(
      String(MOCK_GRAPH_RESPONSE.nodes.length),
      { timeout: 15_000 },
    );
    await expect(page.locator('.error-overlay')).toHaveCount(0);
  });
});
