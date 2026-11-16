/**
 * Selective expand (hubs-densos F3): a node with more than 50 edges in the
 * source asks what to load, and the canvas says how many of its edges are
 * loaded. The counting rule and the truncation toast are unit tested
 * (graph.selectiveExpand.test.ts); what is only observable here is the dialog.
 */
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts, seedGraphResponse } from '../helpers/api-mocks';
import { partnerRegister } from '../fixtures/partner-register';

test.describe('Selective expand', () => {
  test('counts first, loads only the chosen relationship type, and warns that it stopped', async ({
    authenticatedPage: page,
  }) => {
    const full = partnerRegister(60);
    const hub = full.nodes[0].node_id;
    await seedContexts(page, [MOCK_CONTEXT]);
    // The canvas starts with the hub alone; expanding brings 40 of its edges.
    await seedGraphResponse(page, { ...full, nodes: [full.nodes[0]], edges: [] });
    const expanded: unknown[] = [];
    await page.route('**/graphlagoon/api/graph-contexts/*/neighbor-summary', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          supported: true,
          total_edges: 380,
          buckets: [
            { relationship_type: 'SOCIO_DE', direction: 'in', edges: 304 },
            { relationship_type: 'ADMINISTRA', direction: 'in', edges: 76 },
          ],
        }),
      }),
    );
    await page.route('**/graphlagoon/api/graph-contexts/*/expand', (route) => {
      expanded.push(route.request().postDataJSON());
      const edges = full.edges.filter((e: any) => e.src === hub || e.dst === hub).slice(0, 40);
      const ids = new Set(edges.flatMap((e: any) => [e.src, e.dst]));
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ nodes: full.nodes.filter((n: any) => ids.has(n.node_id)), edges, truncated: true }),
      });
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toContainText('1 node', { timeout: 15_000 });

    await page.evaluate((id) => {
      const g = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('graph');
      void g.requestExpand(id);
    }, hub);

    const dialog = page.getByTestId('expand-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('expand-dialog-total')).toContainText('380 edges in the source');
    expect(expanded).toHaveLength(0);

    await page.getByTestId('expand-type-ADMINISTRA').uncheck();
    await page.getByTestId('expand-limit').fill('40');
    await expect(page.getByTestId('expand-dialog-note')).toContainText('264 of the 304 selected edges will not load');
    await page.getByTestId('expand-dialog-accept').click();

    await expect(dialog).toHaveCount(0);
    await expect.poll(() => expanded.length).toBe(1);
    expect(expanded[0]).toMatchObject({ node_id: hub, depth: 1, edge_types: ['SOCIO_DE'], edge_limit: 40 });
    await expect(page.locator('.toast')).toContainText('Expand stopped at 40 edges');
  });
});
