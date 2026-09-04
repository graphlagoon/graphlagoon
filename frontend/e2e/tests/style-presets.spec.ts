/**
 * Named style presets — style, labels and layout applied from the URL.
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import {
  seedContexts,
  seedStylePresets,
  seedPrecomputedGraphs,
  seedGraphResponse,
} from '../helpers/api-mocks';

// Kept WITHOUT property_visibility/behaviors on purpose: presets saved before
// those fields existed must still apply cleanly (backward-compat guard).
const INVESTIGACAO = {
  aesthetics: { nodeSize: 9 },
  nodeTypeColors: { Person: '#ff0000' },
  edgeTypeColors: {},
  textFormat: { rules: [], defaults: {} },
  layout_algorithm: 'hive',
  layout_mode_config: { ego: {}, hive: {}, hierarchical: {} },
  force3d_settings: {},
};

// A preset carrying the newer fields: a node-property allowlist and behaviors.
const FOCO = {
  ...INVESTIGACAO,
  property_visibility: { nodeProperties: ['name'], edgeProperties: null },
  behaviors: { degreeDimEnabled: false },
};

// The default subgraph mock carries no `properties` objects, so property
// surfaces have nothing to prune. This graph does.
const GRAPH_WITH_PROPS = {
  nodes: [
    { node_id: 'n1', node_type: 'Person', properties: { name: 'Alice', age: 30 } },
    { node_id: 'n2', node_type: 'Person', properties: { name: 'Bob', age: 25 } },
  ],
  edges: [
    { edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'KNOWS', properties: { weight: 0.5 } },
  ],
};

/**
 * Presets open from a button inside the existing Style (aesthetics) panel — not
 * from a toolbar entry of their own, and not inline in the sidebar.
 */
async function openPresets(page: any) {
  if (!(await page.getByTestId('style-preset-open').isVisible().catch(() => false))) {
    await page.getByTitle('Style', { exact: true }).click();
  }
  await page.getByTestId('style-preset-open').click();
  await expect(page.getByTestId('style-preset-modal')).toBeVisible();
}

test.describe('Style presets', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
  });

  test('?style=<name> applies the preset to the loaded graph', async ({
    authenticatedPage: page,
  }) => {
    await seedStylePresets(page, MOCK_CONTEXT.id, { investigacao: INVESTIGACAO });

    await page.goto(`/graph/${MOCK_CONTEXT.id}?style=investigacao`);

    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('graph-status-style')).toContainText('investigacao');
    // The graph itself is untouched — a preset never changes what is shown.
    await expect(page.getByTestId('graph-status-bar')).toContainText('5 nodes');
  });

  test('a missing preset leaves the graph fully usable and says so', async ({
    authenticatedPage: page,
  }) => {
    await seedStylePresets(page, MOCK_CONTEXT.id, {});

    await page.goto(`/graph/${MOCK_CONTEXT.id}?style=nao-existe`);

    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    // Unlike a missing ?precomputed=, the graph still loaded.
    await expect(page.getByTestId('graph-status-bar')).toContainText('5 nodes');
    await expect(page.getByTestId('graph-status-style')).toHaveCount(0);
    await expect(page.getByTestId('graph-status-style-error')).toBeVisible();
  });

  test('an ordinary open shows no style chip', async ({ authenticatedPage: page }) => {
    await seedStylePresets(page, MOCK_CONTEXT.id, { investigacao: INVESTIGACAO });

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);

    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('graph-status-style')).toHaveCount(0);
  });

  test('style and a precomputed graph compose in one URL', async ({ authenticatedPage: page }) => {
    await seedStylePresets(page, MOCK_CONTEXT.id, { investigacao: INVESTIGACAO });
    await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {
      'fraude-2024': {
        nodes: [
          { node_id: 'n1', node_type: 'Person', properties: {} },
          { node_id: 'n2', node_type: 'Person', properties: {} },
        ],
        edges: [],
      },
    });

    await page.goto(
      `/graph/${MOCK_CONTEXT.id}?precomputed=fraude-2024&style=investigacao`,
    );

    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('graph-status-precomputed')).toContainText('fraude-2024');
    await expect(page.getByTestId('graph-status-style')).toContainText('investigacao');
    await expect(page.getByTestId('graph-status-bar')).toContainText('2 nodes');
  });

  test('the panel lists presets and applies one through the URL', async ({
    authenticatedPage: page,
  }) => {
    await seedStylePresets(page, MOCK_CONTEXT.id, {
      investigacao: INVESTIGACAO,
      apresentacao: INVESTIGACAO,
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    await openPresets(page);
    await expect(page.getByTestId('style-preset-item-investigacao')).toBeVisible();
    await expect(page.getByTestId('style-preset-item-apresentacao')).toBeVisible();

    await page.getByTestId('style-preset-apply-investigacao').click();

    await expect(page).toHaveURL(/style=investigacao/);
    await expect(page.getByTestId('graph-status-style')).toContainText('investigacao');
  });

  test('saving the current look creates a preset and applies it', async ({
    authenticatedPage: page,
  }) => {
    await seedStylePresets(page, MOCK_CONTEXT.id, {});

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    await openPresets(page);
    await page.getByTestId('style-preset-name-input').fill('meu-estilo');
    await page.getByTestId('style-preset-description-input').fill('For reviews');
    await page.getByTestId('style-preset-save-button').click();

    await expect(page.getByTestId('style-preset-item-meu-estilo')).toBeVisible();
    await expect(page).toHaveURL(/style=meu-estilo/);
  });

  test('stopping a style drops only that URL param', async ({
    authenticatedPage: page,
  }) => {
    await seedStylePresets(page, MOCK_CONTEXT.id, { investigacao: INVESTIGACAO });

    await page.goto(`/graph/${MOCK_CONTEXT.id}?style=investigacao`);
    await expect(page.getByTestId('graph-status-style')).toBeVisible({ timeout: 15_000 });

    await openPresets(page);
    await page.getByTestId('style-preset-clear').click();

    await expect(page).not.toHaveURL(/style=/);
    await expect(page.getByTestId('graph-status-style')).toHaveCount(0);
    // The graph is still there — only the styling stopped.
    await expect(page.getByTestId('graph-status-bar')).toContainText('5 nodes');
  });

  test('deleting someone else\'s preset reports who owns it', async ({
    authenticatedPage: page,
  }) => {
    await seedStylePresets(
      page,
      MOCK_CONTEXT.id,
      { alheio: INVESTIGACAO },
      { alheio: 'alice@example.com' },
    );
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    await openPresets(page);
    await page.getByTestId('style-preset-delete-alheio').click();
    await page.getByTestId('confirm-dialog-accept').click();

    // The listing carries no owner, so this message is the only place it appears.
    await expect(page.getByTestId('style-preset-error')).toContainText(
      'alice@example.com',
    );
    await expect(page.getByTestId('style-preset-item-alheio')).toBeVisible();
  });

  test('deleting your own preset removes it', async ({ authenticatedPage: page }) => {
    await seedStylePresets(page, MOCK_CONTEXT.id, { meu: INVESTIGACAO });
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    await openPresets(page);
    await page.getByTestId('style-preset-delete-meu').click();
    await page.getByTestId('confirm-dialog-accept').click();

    await expect(page.getByTestId('style-preset-item-meu')).toHaveCount(0);
    await expect(page.getByTestId('style-preset-empty')).toBeVisible();
  });

  test('presets open from the Style panel, not a second Style button', async ({
    authenticatedPage: page,
  }) => {
    await seedStylePresets(page, MOCK_CONTEXT.id, { investigacao: INVESTIGACAO });

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    // Exactly one toolbar entry says "Style".
    await expect(page.getByTitle('Style', { exact: true })).toHaveCount(1);

    // Opening it shows sliders, not a preset list — that lives behind a button.
    await page.getByTitle('Style', { exact: true }).click();
    await expect(page.getByTestId('style-preset-list')).toHaveCount(0);
    await expect(page.getByTestId('style-preset-open')).toBeVisible();

    await page.getByTestId('style-preset-open').click();
    await expect(page.getByTestId('style-preset-modal')).toBeVisible();
    await expect(page.getByTestId('style-preset-item-investigacao')).toBeVisible();
  });

  test('?style= with a property allowlist prunes the data table and behaviors land', async ({
    authenticatedPage: page,
  }) => {
    await seedStylePresets(page, MOCK_CONTEXT.id, { foco: FOCO });
    await seedGraphResponse(page, GRAPH_WITH_PROPS);

    await page.goto(`/graph/${MOCK_CONTEXT.id}?style=foco`);
    await expect(page.getByTestId('graph-status-style')).toContainText('foco', {
      timeout: 15_000,
    });

    // The data table shows only the allowlisted property column, with the way
    // out advertised right next to it.
    await page.getByTitle('Data Table').click();
    const drawer = page.locator('.data-table-drawer');
    await expect(drawer.locator('th', { hasText: 'name' })).toBeVisible();
    await expect(drawer.locator('th', { hasText: 'age' })).toHaveCount(0);
    await expect(page.getByTestId('property-visibility-hint')).toContainText(
      'Showing 1 of 2',
    );

    // The preset's behaviors landed too: Dim Hub defaults to on, preset turned it off.
    await page.getByTitle('Behaviors').click();
    await expect(
      page.locator('label', { hasText: 'Dim Hub' }).locator('input'),
    ).not.toBeChecked();
  });

  test('picking a property subset survives save + reload through ?style=', async ({
    authenticatedPage: page,
  }) => {
    await seedStylePresets(page, MOCK_CONTEXT.id, {});
    await seedGraphResponse(page, GRAPH_WITH_PROPS);

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    // Limit node properties: checking the box seeds the full list, then
    // deselect "age" in the MultiSelect.
    await page.getByTitle('Style', { exact: true }).click();
    await page.getByTestId('property-visibility-node-toggle').check();
    await page.getByTestId('property-visibility-node').click();
    await page.getByRole('option', { name: 'age' }).click();
    await page.keyboard.press('Escape');

    await page.getByTitle('Data Table').click();
    const drawer = page.locator('.data-table-drawer');
    await expect(drawer.locator('th', { hasText: 'name' })).toBeVisible();
    await expect(drawer.locator('th', { hasText: 'age' })).toHaveCount(0);

    // Save the look as a preset, then reload through the URL it produced.
    await openPresets(page);
    await page.getByTestId('style-preset-name-input').fill('so-nomes');
    await page.getByTestId('style-preset-save-button').click();
    await expect(page).toHaveURL(/style=so-nomes/);

    await page.goto(`/graph/${MOCK_CONTEXT.id}?style=so-nomes`);
    await expect(page.getByTestId('graph-status-style')).toContainText('so-nomes', {
      timeout: 15_000,
    });
    await page.getByTitle('Data Table').click();
    await expect(drawer.locator('th', { hasText: 'name' })).toBeVisible();
    await expect(drawer.locator('th', { hasText: 'age' })).toHaveCount(0);

    // "Show all" is the escape hatch — one click back to everything.
    await page.getByTestId('property-visibility-hint').locator('button').click();
    await expect(drawer.locator('th', { hasText: 'age' })).toBeVisible();
  });

  test('closing the modal leaves the applied style in place', async ({
    authenticatedPage: page,
  }) => {
    await seedStylePresets(page, MOCK_CONTEXT.id, { investigacao: INVESTIGACAO });

    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    await openPresets(page);
    await page.getByTestId('style-preset-apply-investigacao').click();
    await page.getByTestId('style-preset-close').click();

    await expect(page.getByTestId('style-preset-modal')).toHaveCount(0);
    await expect(page.getByTestId('graph-status-style')).toContainText('investigacao');
  });
});

/**
 * The sphere/icon state of one node, read straight from graphData.
 *
 * Deliberately not rendering-dependent: `color` and `__iconColor` are plain JS
 * state written by updateVisuals(), so these assertions hold identically on a
 * GPU and on CI's software renderer. The hook itself is dev-only, so its
 * absence means the suite is pointed at a production build — worth saying out
 * loud rather than failing later on `undefined.color`.
 */
async function readVisualState(page: Page, nodeId: string) {
  const state = await page.evaluate(
    (id) => (window as any).__GRAPH_NODE_VISUAL_STATE__?.(id) ?? null,
    nodeId,
  );
  expect(
    state,
    'no __GRAPH_NODE_VISUAL_STATE__ for the node: the graph never finished '
      + 'building, or the app is a production build without the dev hook',
  ).not.toBeNull();
  return state as { color: string; iconColor?: string };
}

/**
 * Regression: on a first load with ?style=, the preset's fetch used to land
 * while the async graph build (chunked + headless settle for >2000 edges) was
 * still in flight — the nodeTypeIcons watcher ran updateVisuals() against the
 * about-to-be-discarded graphData, so styled nodes kept their opaque spheres
 * and the icon billboards stayed depth-rejected inside them until the next
 * camera idle. The >2000-edge graph makes the race deterministic: the mocked
 * style fetch (ms) always resolves mid-settle.
 */
test.describe('Style presets — icons on first load', () => {
  // These two deliberately load a graph big enough to force the async build
  // path, and they run on a software-rendered WebGL context in CI. The default
  // 30s budget cannot even contain their own waits, let alone a cold runner:
  // mark them slow (x3) so a slow environment reports the real assertion
  // instead of a timeout.
  test.slow();

  // Above HEADLESS_SETTLE_EDGE_THRESHOLD (2000) so updateGraph awaits a
  // headless settle, guaranteeing the style lands mid-build.
  const N = 420;
  const BIG_NODES = Array.from({ length: N }, (_, i) => ({
    node_id: `p${i}`,
    node_type: 'Person',
    properties: { name: `Person ${i}` },
  }));
  const BIG_EDGES = Array.from({ length: N * 5 }, (_, i) => ({
    edge_id: `e${i}`,
    src: `p${i % N}`,
    dst: `p${(i * 7 + 1) % N}`,
    relationship_type: 'KNOWS',
    properties: {},
  }));

  const ICONES = {
    ...INVESTIGACAO,
    nodeTypeIcons: { Person: 'user' },
  };

  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedPrecomputedGraphs(page, MOCK_CONTEXT.id, {
      'big-icons': { nodes: BIG_NODES, edges: BIG_EDGES },
    });
  });

  test('icons from ?style= show without any camera interaction', async ({
    authenticatedPage: page,
  }) => {
    await seedStylePresets(page, MOCK_CONTEXT.id, { icones: ICONES });

    await page.goto(`/graph/${MOCK_CONTEXT.id}?precomputed=big-icons&style=icones`);

    await expect(page.getByTestId('graph-status-style')).toContainText('icones', {
      timeout: 20_000,
    });
    await page.waitForFunction(() => (window as any).__GRAPH_LAYOUT_DONE__?.(), null, {
      timeout: 30_000,
    });

    // No camera move, no zoom: the sphere must already be transparent with the
    // appearance color handed to the icon billboard.
    const state = await readVisualState(page, 'p1');
    expect(state.color).toBe('rgba(0,0,0,0)');
    expect(state.iconColor).toBeTruthy();
  });

  test('preset behaviors that re-init the graph still keep the icons', async ({
    authenticatedPage: page,
  }) => {
    // viewMode '3d' differs from the '2d-proj' default, so applying the preset
    // re-runs initGraph() — the secondary window for the same lost-visuals bug.
    await seedStylePresets(page, MOCK_CONTEXT.id, {
      icones3d: { ...ICONES, behaviors: { viewMode: '3d' } },
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}?precomputed=big-icons&style=icones3d`);

    await expect(page.getByTestId('graph-status-style')).toContainText('icones3d', {
      timeout: 20_000,
    });
    await page.waitForFunction(() => (window as any).__GRAPH_LAYOUT_DONE__?.(), null, {
      timeout: 30_000,
    });

    const state = await readVisualState(page, 'p1');
    expect(state.color).toBe('rgba(0,0,0,0)');
    expect(state.iconColor).toBeTruthy();
  });
});
