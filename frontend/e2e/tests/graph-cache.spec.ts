/**
 * Named graph caches — replayed from a URL, authored only by superusers.
 *
 * Nothing here lists caches, because the API does not offer it: entries are
 * addressed by a name their author chose, and enumerating them is the one
 * operation that does not survive scale.
 *
 * Reading a cache needs only context access, so those tests run as an ordinary
 * authenticated user. Creating and deleting are superuser-only — a graph cache
 * is a published, administered artifact, unlike a style preset, which anyone
 * with context write access can save — so those tests run through the shared
 * `superuserTest`/`superuserPage` fixture.
 */
import { test, superuserTest, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts, seedGraphCaches } from '../helpers/api-mocks';

const NODES = [
  { node_id: 'n1', node_type: 'Account', properties: { name: 'Ana' } },
  { node_id: 'n2', node_type: 'Account', properties: { name: 'Bruno' } },
  { node_id: 'n3', node_type: 'Device', properties: { name: 'iPhone' } },
];
const EDGES = [
  { edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'SENT', properties: {} },
  { edge_id: 'e2', src: 'n2', dst: 'n3', relationship_type: 'USED', properties: {} },
];

test.describe('Graph cache — reading', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
  });

  test('?graph=<name> replays the cached graph without running a query', async ({
    authenticatedPage: page,
  }) => {
    await seedGraphCaches(page, MOCK_CONTEXT.id, {
      'fraude-2024': { nodes: NODES, edges: EDGES },
    });

    // The point of the feature: no warehouse query is issued.
    const queryRequests: string[] = [];
    page.on('request', (req) => {
      if (/\/(query|cypher|subgraph)(\/async)?$/.test(new URL(req.url()).pathname)) {
        queryRequests.push(req.url());
      }
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}?graph=fraude-2024`);

    const statusBar = page.getByTestId('graph-status-bar');
    await expect(statusBar).toBeVisible({ timeout: 15_000 });
    await expect(statusBar).toContainText('3 nodes');
    await expect(statusBar).toContainText('2 edges');
    await expect(page.getByTestId('graph-status-cached')).toContainText('fraude-2024');

    expect(queryRequests).toEqual([]);
  });

  test('a missing cache reports the failure instead of loading something else', async ({
    authenticatedPage: page,
  }) => {
    await seedGraphCaches(page, MOCK_CONTEXT.id, {});

    await page.goto(`/graph/${MOCK_CONTEXT.id}?graph=nao-existe`);

    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('graph-status-bar')).toContainText('0 nodes');
    await expect(page.getByTestId('graph-status-cached')).toHaveCount(0);
  });

  test('an ordinary open shows no cache chip', async ({ authenticatedPage: page }) => {
    await seedGraphCaches(page, MOCK_CONTEXT.id, {
      'fraude-2024': { nodes: NODES, edges: EDGES },
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);

    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('graph-status-cached')).toHaveCount(0);
  });

  test('changing only the ?graph param reloads the graph', async ({
    authenticatedPage: page,
  }) => {
    await seedGraphCaches(page, MOCK_CONTEXT.id, {
      big: { nodes: NODES, edges: EDGES },
      small: { nodes: NODES.slice(0, 1), edges: [] },
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}?graph=big`);
    await expect(page.getByTestId('graph-status-bar')).toContainText('3 nodes', {
      timeout: 15_000,
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}?graph=small`);

    await expect(page.getByTestId('graph-status-cached')).toContainText('small');
    await expect(page.getByTestId('graph-status-bar')).toContainText('1 nodes');
  });

  test('a non-superuser can open a cache but never sees the Cache button', async ({
    authenticatedPage: page,
  }) => {
    await seedGraphCaches(page, MOCK_CONTEXT.id, {
      'fraude-2024': { nodes: NODES, edges: EDGES },
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}?graph=fraude-2024`);

    await expect(page.getByTestId('graph-status-cached')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('toolbar-graph-cache')).toHaveCount(0);
  });
});

superuserTest.describe('Graph cache — superuser authoring', () => {
  superuserTest(
    'the panel saves the current graph and hands back its link',
    async ({ superuserPage: page }) => {
      await seedContexts(page, [MOCK_CONTEXT]);
      await seedGraphCaches(page, MOCK_CONTEXT.id, {});

      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

      await page.getByTestId('toolbar-graph-cache').click();
      await expect(page.getByTestId('graph-cache-panel')).toBeVisible();

      await page.getByTestId('graph-cache-name-input').fill('fraude-2024');
      await page.getByTestId('graph-cache-save-button').click();

      // Nothing lists caches, so the link has to be handed over at save time.
      const saved = page.getByTestId('graph-cache-last-saved');
      await expect(saved).toBeVisible();
      await expect(saved).toContainText('fraude-2024');
      await expect(saved).toContainText('?graph=fraude-2024');
    },
  );

  superuserTest('a just-saved cache opens from the panel', async ({ superuserPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedGraphCaches(page, MOCK_CONTEXT.id, {});

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('toolbar-graph-cache').click();
    await page.getByTestId('graph-cache-name-input').fill('recem-salvo');
    await page.getByTestId('graph-cache-save-button').click();
    await expect(page.getByTestId('graph-cache-last-saved')).toBeVisible();

    await page.getByTestId('graph-cache-open-last').click();

    await expect(page).toHaveURL(/graph=recem-salvo/);
    await expect(page.getByTestId('graph-status-cached')).toContainText('recem-salvo');
  });

  superuserTest('deleting by name removes the cache', async ({ superuserPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedGraphCaches(page, MOCK_CONTEXT.id, {
      descartavel: { nodes: NODES, edges: EDGES },
    });
    page.on('dialog', (dialog) => dialog.accept());

    await page.goto(`/graph/${MOCK_CONTEXT.id}?graph=descartavel`);
    await expect(page.getByTestId('graph-status-cached')).toContainText('descartavel', {
      timeout: 15_000,
    });

    await page.getByTestId('toolbar-graph-cache').click();
    await page.getByTestId('graph-cache-delete-input').fill('descartavel');
    await page.getByTestId('graph-cache-delete-button').click();

    // Reopening the same URL now finds nothing.
    await page.goto(`/graph/${MOCK_CONTEXT.id}?graph=descartavel`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('graph-status-cached')).toHaveCount(0);
  });

  superuserTest(
    'the panel names the cache currently on screen',
    async ({ superuserPage: page }) => {
      await seedContexts(page, [MOCK_CONTEXT]);
      await seedGraphCaches(page, MOCK_CONTEXT.id, {
        'em-tela': { nodes: NODES, edges: EDGES },
      });

      await page.goto(`/graph/${MOCK_CONTEXT.id}?graph=em-tela`);
      await expect(page.getByTestId('graph-status-cached')).toBeVisible({
        timeout: 15_000,
      });

      await page.getByTestId('toolbar-graph-cache').click();
      await expect(page.getByTestId('graph-cache-viewing')).toContainText('em-tela');
    },
  );

  superuserTest(
    'the panel stays a sidebar instead of eating the canvas',
    async ({ superuserPage: page }) => {
      await seedContexts(page, [MOCK_CONTEXT]);
      await seedGraphCaches(page, MOCK_CONTEXT.id, {});

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/graph/${MOCK_CONTEXT.id}`);
      await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

      await page.getByTestId('toolbar-graph-cache').click();
      const panel = page.getByTestId('graph-cache-panel');
      await expect(panel).toBeVisible();

      // A long name plus the full URL is the widest content the panel ever holds.
      await page
        .getByTestId('graph-cache-name-input')
        .fill('um-nome-de-cache-bastante-longo-para-forcar-overflow');
      await page.getByTestId('graph-cache-save-button').click();
      await expect(page.getByTestId('graph-cache-last-saved')).toBeVisible();

      const box = (await panel.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(300);
      expect(box.width).toBeGreaterThanOrEqual(200);

      const overflow = await panel.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    },
  );

  superuserTest('the panel narrows on a small viewport', async ({ superuserPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedGraphCaches(page, MOCK_CONTEXT.id, {});

    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('toolbar-graph-cache').click();
    const box = (await page.getByTestId('graph-cache-panel').boundingBox())!;
    // 22vw of 900 is under the 230px floor, so the clamp holds it there.
    expect(box.width).toBeGreaterThanOrEqual(200);
    expect(box.width).toBeLessThan(280);
  });

  superuserTest(
    'the save button stays disabled for an invalid name',
    async ({ superuserPage: page }) => {
      await seedContexts(page, [MOCK_CONTEXT]);
      await seedGraphCaches(page, MOCK_CONTEXT.id, {
        base: { nodes: NODES, edges: EDGES },
      });

      await page.goto(`/graph/${MOCK_CONTEXT.id}?graph=base`);
      await expect(page.getByTestId('graph-status-bar')).toContainText('3 nodes', {
        timeout: 15_000,
      });

      await page.getByTestId('toolbar-graph-cache').click();
      await page.getByTestId('graph-cache-name-input').fill('nome invalido');

      await expect(page.getByTestId('graph-cache-save-button')).toBeDisabled();
    },
  );
});
