/**
 * Precomputed graphs — resolved from a URL, published only by superusers.
 *
 * Nothing here lists them, because the API does not offer it: entries are
 * addressed by a name their author chose, and enumerating them is the one
 * operation that does not survive scale.
 *
 * Reading needs only context access, so those tests run as an ordinary
 * authenticated user. Publishing and deleting need superuser status *and* a
 * writable provider — a precomputed graph is a published, administered
 * artifact, unlike a style preset, which anyone with context write access can
 * save — so those tests run through the shared `superuserTest`/`superuserPage`
 * fixture.
 */
import { test, superuserTest, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts, seedPrecomputedGraphs } from '../helpers/api-mocks';

const NODES = [
  { node_id: 'n1', node_type: 'Account', properties: { name: 'Ana' } },
  { node_id: 'n2', node_type: 'Account', properties: { name: 'Bruno' } },
  { node_id: 'n3', node_type: 'Device', properties: { name: 'iPhone' } },
];
const EDGES = [
  { edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'SENT', properties: {} },
  { edge_id: 'e2', src: 'n2', dst: 'n3', relationship_type: 'USED', properties: {} },
];

test.describe('Precomputed graphs — reading', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
  });

  test('?precomputed=<name> resolves the graph without running a query', async ({
    authenticatedPage: page,
  }) => {
    await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {
      'fraude-2024': { nodes: NODES, edges: EDGES },
    });

    // The point of the feature: no warehouse query is issued.
    const queryRequests: string[] = [];
    page.on('request', (req) => {
      if (/\/(query|cypher|subgraph)(\/async)?$/.test(new URL(req.url()).pathname)) {
        queryRequests.push(req.url());
      }
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}?precomputed=fraude-2024`);

    const statusBar = page.getByTestId('graph-status-bar');
    await expect(statusBar).toBeVisible({ timeout: 15_000 });
    await expect(statusBar).toContainText('3 nodes');
    await expect(statusBar).toContainText('2 edges');
    await expect(page.getByTestId('graph-status-precomputed')).toContainText('fraude-2024');

    expect(queryRequests).toEqual([]);
  });

  test('a missing graph reports the failure instead of loading something else', async ({
    authenticatedPage: page,
  }) => {
    await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {});

    await page.goto(`/graph/${MOCK_CONTEXT.id}?precomputed=nao-existe`);

    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('graph-status-bar')).toContainText('0 nodes');
    await expect(page.getByTestId('graph-status-precomputed')).toHaveCount(0);
  });

  test('an ordinary open shows no precomputed chip', async ({ authenticatedPage: page }) => {
    await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {
      'fraude-2024': { nodes: NODES, edges: EDGES },
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);

    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('graph-status-precomputed')).toHaveCount(0);
  });

  test('changing only the ?precomputed param reloads the graph', async ({
    authenticatedPage: page,
  }) => {
    await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {
      big: { nodes: NODES, edges: EDGES },
      small: { nodes: NODES.slice(0, 1), edges: [] },
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}?precomputed=big`);
    await expect(page.getByTestId('graph-status-bar')).toContainText('3 nodes', {
      timeout: 15_000,
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}?precomputed=small`);

    await expect(page.getByTestId('graph-status-precomputed')).toContainText('small');
    await expect(page.getByTestId('graph-status-bar')).toContainText('1 nodes');
  });

  test('changing only a provider argument re-resolves the graph', async ({
    authenticatedPage: page,
  }) => {
    // The headline capability: one name, different graphs per argument. The
    // name never changes here, so nothing but the argument can be driving it.
    await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {
      'vizinhanca?seed=n1': { nodes: NODES, edges: EDGES },
      'vizinhanca?seed=n2': { nodes: NODES.slice(0, 1), edges: [] },
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}?precomputed=vizinhanca&seed=n1`);
    await expect(page.getByTestId('graph-status-bar')).toContainText('3 nodes', {
      timeout: 15_000,
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}?precomputed=vizinhanca&seed=n2`);

    await expect(page.getByTestId('graph-status-precomputed')).toContainText('vizinhanca');
    await expect(page.getByTestId('graph-status-bar')).toContainText('1 nodes');
  });

  test('provider arguments are forwarded, reserved keys are not', async ({
    authenticatedPage: page,
  }) => {
    await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {
      'vizinhanca?hops=3&seed=n1': { nodes: NODES, edges: EDGES },
    });

    const resolved: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/precomputed-graphs/')) resolved.push(req.url());
    });

    await page.goto(
      `/graph/${MOCK_CONTEXT.id}?precomputed=vizinhanca&seed=n1&hops=3` +
        `&style=investigacao&layout=ego&utm_source=slack`,
    );
    await expect(page.getByTestId('graph-status-precomputed')).toBeVisible({
      timeout: 15_000,
    });

    const request = resolved.find((url) => url.includes('vizinhanca'));
    expect(request).toBeTruthy();
    const params = new URL(request!).searchParams;
    expect(params.get('seed')).toBe('n1');
    expect(params.get('hops')).toBe('3');
    // The frontend owns these; forwarding one would be an immediate 400.
    expect(params.has('style')).toBe(false);
    expect(params.has('layout')).toBe(false);
    expect(params.has('utm_source')).toBe(false);
  });

  test('an unknown argument surfaces an error instead of a blank canvas', async ({
    authenticatedPage: page,
  }) => {
    await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {
      vizinhanca: { nodes: NODES, edges: EDGES },
    });
    // A parameter the provider never declared: the mock keys on sorted args, so
    // `?sed=n1` resolves to nothing, exactly as a 400 would leave the canvas.
    await page.goto(`/graph/${MOCK_CONTEXT.id}?precomputed=vizinhanca&sed=n1`);

    await expect(page.getByTestId('graph-status-bar')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('graph-status-precomputed')).toHaveCount(0);
  });

  test('a non-superuser can open one but never sees the Precomputed button', async ({
    authenticatedPage: page,
  }) => {
    await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {
      'fraude-2024': { nodes: NODES, edges: EDGES },
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}?precomputed=fraude-2024`);

    await expect(page.getByTestId('graph-status-precomputed')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('toolbar-precomputed')).toHaveCount(0);
  });
});

superuserTest.describe('Precomputed graphs — superuser publishing', () => {
  superuserTest(
    'the panel saves the current graph and hands back its link',
    async ({ superuserPage: page }) => {
      await seedContexts(page, [MOCK_CONTEXT]);
      await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {});

      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

      await page.getByTestId('toolbar-precomputed').click();
      await expect(page.getByTestId('precomputed-graph-panel')).toBeVisible();

      await page.getByTestId('precomputed-graph-name-input').fill('fraude-2024');
      await page.getByTestId('precomputed-graph-save-button').click();

      // Nothing lists them, so the link has to be handed over at publish time.
      const saved = page.getByTestId('precomputed-graph-last-saved');
      await expect(saved).toBeVisible();
      await expect(saved).toContainText('fraude-2024');
      await expect(saved).toContainText('?precomputed=fraude-2024');
    },
  );

  superuserTest('a just-published graph opens from the panel', async ({ superuserPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {});

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('toolbar-precomputed').click();
    await page.getByTestId('precomputed-graph-name-input').fill('recem-salvo');
    await page.getByTestId('precomputed-graph-save-button').click();
    await expect(page.getByTestId('precomputed-graph-last-saved')).toBeVisible();

    await page.getByTestId('precomputed-graph-open-last').click();

    await expect(page).toHaveURL(/precomputed=recem-salvo/);
    await expect(page.getByTestId('graph-status-precomputed')).toContainText('recem-salvo');
  });

  superuserTest('deleting by name removes the graph', async ({ superuserPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {
      descartavel: { nodes: NODES, edges: EDGES },
    });
    page.on('dialog', (dialog) => dialog.accept());

    await page.goto(`/graph/${MOCK_CONTEXT.id}?precomputed=descartavel`);
    await expect(page.getByTestId('graph-status-precomputed')).toContainText('descartavel', {
      timeout: 15_000,
    });

    await page.getByTestId('toolbar-precomputed').click();
    await page.getByTestId('precomputed-graph-delete-input').fill('descartavel');
    await page.getByTestId('precomputed-graph-delete-button').click();

    // Reopening the same URL now finds nothing.
    await page.goto(`/graph/${MOCK_CONTEXT.id}?precomputed=descartavel`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('graph-status-precomputed')).toHaveCount(0);
  });

  superuserTest(
    'the panel names the precomputed graph currently on screen',
    async ({ superuserPage: page }) => {
      await seedContexts(page, [MOCK_CONTEXT]);
      await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {
        'em-tela': { nodes: NODES, edges: EDGES },
      });

      await page.goto(`/graph/${MOCK_CONTEXT.id}?precomputed=em-tela`);
      await expect(page.getByTestId('graph-status-precomputed')).toBeVisible({
        timeout: 15_000,
      });

      await page.getByTestId('toolbar-precomputed').click();
      await expect(page.getByTestId('precomputed-graph-viewing')).toContainText('em-tela');
    },
  );

  superuserTest(
    'the panel stays a sidebar instead of eating the canvas',
    async ({ superuserPage: page }) => {
      await seedContexts(page, [MOCK_CONTEXT]);
      await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {});

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

      await page.getByTestId('toolbar-precomputed').click();
      const panel = page.getByTestId('precomputed-graph-panel');
      await expect(panel).toBeVisible();

      // A long name plus the full URL is the widest content the panel ever holds.
      await page
        .getByTestId('precomputed-graph-name-input')
        .fill('um-nome-bastante-longo-para-forcar-overflow-no-painel');
      await page.getByTestId('precomputed-graph-save-button').click();
      await expect(page.getByTestId('precomputed-graph-last-saved')).toBeVisible();

      const box = (await panel.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(300);
      expect(box.width).toBeGreaterThanOrEqual(200);

      const overflow = await panel.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    },
  );

  superuserTest('the panel narrows on a small viewport', async ({ superuserPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {});

    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('toolbar-precomputed').click();
    const box = (await page.getByTestId('precomputed-graph-panel').boundingBox())!;
    // 22vw of 900 is under the 230px floor, so the clamp holds it there.
    expect(box.width).toBeGreaterThanOrEqual(200);
    expect(box.width).toBeLessThan(280);
  });

  superuserTest(
    'the save button stays disabled for an invalid name',
    async ({ superuserPage: page }) => {
      await seedContexts(page, [MOCK_CONTEXT]);
      await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {
        base: { nodes: NODES, edges: EDGES },
      });

      await page.goto(`/graph/${MOCK_CONTEXT.id}?precomputed=base`);
      await expect(page.getByTestId('graph-status-bar')).toContainText('3 nodes', {
        timeout: 15_000,
      });

      await page.getByTestId('toolbar-precomputed').click();
      await page.getByTestId('precomputed-graph-name-input').fill('nome invalido');

      await expect(page.getByTestId('precomputed-graph-save-button')).toBeDisabled();
    },
  );
});
