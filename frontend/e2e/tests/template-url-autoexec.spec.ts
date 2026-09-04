/**
 * `?template=<name>&template.<param>=<value>` — run a saved query template
 * from a link.
 *
 * The doctrine under test is fail-closed: these values are spliced into a
 * query a warehouse executes, so ANY issue — unknown param, missing required
 * value, hostile characters, an ambiguous name — must mean NO query of any
 * kind is issued, with one status chip explaining why. Several tests therefore
 * count outbound query/transpile requests and assert zero.
 */
import { test, expect } from '../fixtures/test-fixtures';
import type { Page } from '@playwright/test';
import { MOCK_CONTEXT, MOCK_EXPLORATION } from '../fixtures/mock-data';
import {
  seedContexts,
  seedExplorations,
  seedPrecomputedGraphs,
  seedQueryTemplates,
} from '../helpers/api-mocks';

const NEIGHBORS_TEMPLATE = {
  id: 'tpl-neighbors',
  graph_context_id: MOCK_CONTEXT.id,
  owner_email: 'e2e@test.com',
  name: 'Neighbors',
  query_type: 'cypher',
  query: 'MATCH (n {node_id: "$node_id"})-[r]-() RETURN r LIMIT $limit',
  parameters: [
    { id: 'node_id', type: 'input', label: 'node_id', required: true },
    { id: 'limit', type: 'input', label: 'limit', required: false, default: '100' },
  ],
  options: { procedural_bfs: true, large_results_mode: true },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

/**
 * Record the substituted Cypher each template execution submits. Templates now
 * run through the Cypher endpoints (the server transpiles — the raw-SQL
 * endpoint rejects transpiled BEGIN…END scripts), so the substituted query is
 * what lands on `/cypher` or `/cypher/async`; the responses themselves come
 * from the setupAPIMocks defaults.
 */
async function mockTranspile(page: Page): Promise<string[]> {
  const transpiled: string[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    const path = new URL(req.url()).pathname;
    if (/\/cypher(\/async)?$/.test(path)) {
      transpiled.push(req.postDataJSON()?.query ?? '');
    }
  });
  return transpiled;
}

/** Record every outbound request that would execute or prepare a query. */
function trackQueryRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (/\/(query|cypher|subgraph|transpile)(\/async)?$/.test(path)) {
      requests.push(path);
    }
  });
  return requests;
}

test.describe('Template URL auto-execution — happy path', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedQueryTemplates(page, MOCK_CONTEXT.id, [NEIGHBORS_TEMPLATE]);
  });

  test('?template= resolves, substitutes and executes, and the chip says so', async ({
    authenticatedPage: page,
  }) => {
    const transpiled = await mockTranspile(page);

    await page.goto(
      `/graph/${MOCK_CONTEXT.id}?template=Neighbors&template.node_id=n1`,
    );

    const statusBar = page.getByTestId('graph-status-bar');
    await expect(statusBar).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('graph-status-template')).toContainText('Neighbors', {
      timeout: 15_000,
    });
    await expect(statusBar).toContainText('5 nodes');

    // The URL value AND the declared default were both substituted before the
    // query left the browser.
    await expect.poll(() => transpiled.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(transpiled[0]).toContain('"n1"');
    expect(transpiled[0]).toContain('LIMIT 100');
    expect(transpiled[0]).not.toContain('$node_id');
  });

  test('the template replaces the default auto-load', async ({
    authenticatedPage: page,
  }) => {
    // MOCK_CONTEXT opts into autoLoadOnOpen — with a template in the URL, the
    // implicit subgraph load must not run alongside it.
    await mockTranspile(page);
    const requests = trackQueryRequests(page);

    await page.goto(
      `/graph/${MOCK_CONTEXT.id}?template=Neighbors&template.node_id=n1`,
    );
    await expect(page.getByTestId('graph-status-template')).toBeVisible({
      timeout: 15_000,
    });

    expect(requests.filter((path) => path.endsWith('/subgraph'))).toEqual([]);
  });

  test('editing a template param in the URL re-executes', async ({
    authenticatedPage: page,
  }) => {
    const transpiled = await mockTranspile(page);

    await page.goto(
      `/graph/${MOCK_CONTEXT.id}?template=Neighbors&template.node_id=n1`,
    );
    await expect.poll(() => transpiled.length, { timeout: 15_000 }).toBe(1);

    await page.goto(
      `/graph/${MOCK_CONTEXT.id}?template=Neighbors&template.node_id=n2`,
    );
    await expect.poll(() => transpiled.length, { timeout: 15_000 }).toBe(2);
    expect(transpiled[1]).toContain('"n2"');
  });
});

test.describe('Template URL auto-execution — fail-closed', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedQueryTemplates(page, MOCK_CONTEXT.id, [NEIGHBORS_TEMPLATE]);
  });

  const brokenLinks: Array<[string, string]> = [
    ['a missing required value', 'template=Neighbors'],
    ['an unknown parameter', 'template=Neighbors&template.node_id=n1&template.nope=1'],
    ['an unsafe value', `template=Neighbors&template.node_id=${encodeURIComponent("n1'; DROP TABLE x--")}`],
    ['a template that does not exist', 'template=NoSuchTemplate'],
    ['an orphaned parameter with no template name', 'template.node_id=n1'],
  ];

  for (const [label, query] of brokenLinks) {
    test(`${label} shows the error chip and executes nothing`, async ({
      authenticatedPage: page,
    }) => {
      await mockTranspile(page);
      const requests = trackQueryRequests(page);

      await page.goto(`/graph/${MOCK_CONTEXT.id}?${query}`);

      await expect(page.getByTestId('graph-status-template-error')).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId('graph-status-template')).toHaveCount(0);
      await expect(page.getByTestId('graph-status-bar')).toContainText('0 nodes');
      // The core guarantee: a broken link runs NOTHING — not the template, and
      // not the default auto-load either.
      expect(requests).toEqual([]);
    });
  }

  test('a template whose author disabled link execution refuses to run', async ({
    authenticatedPage: page,
  }) => {
    await seedQueryTemplates(page, MOCK_CONTEXT.id, [
      {
        ...NEIGHBORS_TEMPLATE,
        options: { ...NEIGHBORS_TEMPLATE.options, allow_url_execution: false },
      },
    ]);
    await mockTranspile(page);
    const requests = trackQueryRequests(page);

    await page.goto(`/graph/${MOCK_CONTEXT.id}?template=Neighbors&template.node_id=n1`);

    await expect(page.getByTestId('graph-status-template-error')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('graph-status-template')).toHaveCount(0);
    expect(requests).toEqual([]);
  });

  test('an ambiguous name refuses to guess', async ({ authenticatedPage: page }) => {
    await seedQueryTemplates(page, MOCK_CONTEXT.id, [
      NEIGHBORS_TEMPLATE,
      { ...NEIGHBORS_TEMPLATE, id: 'tpl-neighbors-2' },
    ]);
    const requests = trackQueryRequests(page);

    await page.goto(`/graph/${MOCK_CONTEXT.id}?template=Neighbors&template.node_id=n1`);

    await expect(page.getByTestId('graph-status-template-error')).toBeVisible({
      timeout: 15_000,
    });
    expect(requests).toEqual([]);
  });
});

test.describe('Template URL auto-execution — precedence', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedQueryTemplates(page, MOCK_CONTEXT.id, [NEIGHBORS_TEMPLATE]);
  });

  test('?precomputed= wins and the template is ignored entirely', async ({
    authenticatedPage: page,
  }) => {
    // Seeded WITHOUT arguments: if template.* keys leaked into the provider
    // arguments, the lookup key would not match and this load would 404 —
    // so the graph appearing is itself the reserved-key regression test.
    await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {
      'fraude-2024': {
        nodes: [{ node_id: 'p1', node_type: 'Account', properties: {} }],
        edges: [],
      },
    });
    await mockTranspile(page);
    const requests = trackQueryRequests(page);

    await page.goto(
      `/graph/${MOCK_CONTEXT.id}?precomputed=fraude-2024&template=Neighbors&template.node_id=n1`,
    );

    await expect(page.getByTestId('graph-status-precomputed')).toContainText(
      'fraude-2024',
      { timeout: 15_000 },
    );
    await expect(page.getByTestId('graph-status-bar')).toContainText('1 nodes');
    await expect(page.getByTestId('graph-status-template')).toHaveCount(0);
    await expect(page.getByTestId('graph-status-template-error')).toHaveCount(0);
    expect(requests).toEqual([]);
  });

  test('?exploration= wins over the template', async ({ authenticatedPage: page }) => {
    await seedExplorations(page, [MOCK_EXPLORATION]);
    const transpiled = await mockTranspile(page);

    await page.goto(
      `/graph/${MOCK_CONTEXT.id}?exploration=${MOCK_EXPLORATION.id}&template=Neighbors&template.node_id=n1`,
    );

    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    // The exploration re-runs its own saved query; the template path (which
    // would transpile first) must never start.
    await expect(page.getByTestId('graph-status-template')).toHaveCount(0);
    await expect(page.getByTestId('graph-status-template-error')).toHaveCount(0);
    expect(transpiled).toEqual([]);
  });
});
