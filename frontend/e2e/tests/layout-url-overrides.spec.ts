/**
 * `?layout=` and `?layout.<mode>.<field>=` — layout parameters overridden from a
 * link, on top of whatever a style preset restored.
 *
 * The parsing rules are unit tested in
 * src/utils/__tests__/layoutUrlOverrides.test.ts. What is only observable here
 * is the seam: that the URL beats the preset, that a bad parameter leaves the
 * graph usable and says so, and that a focus node the graph does not have is
 * reported once rather than silently producing an inert layout.
 */
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT, MOCK_CONTEXT_NO_AUTOLOAD } from '../fixtures/mock-data';
import { seedContexts, seedStylePresets } from '../helpers/api-mocks';

/** A preset whose layout block the URL will override field by field. */
const EGO_PRESET = {
  aesthetics: { nodeSize: 9 },
  nodeTypeColors: { Person: '#ff0000' },
  edgeTypeColors: {},
  textFormat: { rules: [], defaults: {} },
  layout_algorithm: 'ego',
  layout_mode_config: {
    ego: { focusNodeId: 'n2', maxHops: 1, direction: 'out' },
    hive: {},
    hierarchical: {},
  },
  force3d_settings: {},
};

async function openLayoutPanel(page: any) {
  await page.getByTestId('graph-toolbar-layout').click();
  await expect(page.getByTestId('ego-max-hops')).toBeVisible();
}

async function waitForGraph(page: any) {
  await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
}

test.describe('Layout overrides from the URL', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT, MOCK_CONTEXT_NO_AUTOLOAD]);
  });

  test('?layout=ego with a focus node centres the layout from a link', async ({
    authenticatedPage: page,
  }) => {
    await page.goto(`/graph/${MOCK_CONTEXT.id}?layout=ego&layout.ego.focusNodeId=n1`);
    await waitForGraph(page);

    await expect(page.getByTestId('graph-status-bar')).toContainText('5 nodes');
    await expect(page.getByTestId('graph-status-layout-error')).toHaveCount(0);

    await openLayoutPanel(page);
    await expect(page.getByTestId('ego-focus-label')).toContainText('n1');
    await expect(page.getByTestId('ego-no-focus-hint')).toHaveCount(0);
  });

  test('a URL layout parameter beats the preset that set it', async ({
    authenticatedPage: page,
  }) => {
    await seedStylePresets(page, MOCK_CONTEXT.id, { 'ego-investigacao': EGO_PRESET });

    await page.goto(
      `/graph/${MOCK_CONTEXT.id}?style=ego-investigacao` +
        `&layout.ego.focusNodeId=n3&layout.ego.maxHops=3`,
    );
    await waitForGraph(page);

    // The preset still applied — the URL overrides fields, it does not replace it.
    await expect(page.getByTestId('graph-status-style')).toContainText('ego-investigacao');
    await expect(page.getByTestId('graph-status-layout-error')).toHaveCount(0);

    await openLayoutPanel(page);
    // Overridden by the URL...
    await expect(page.getByTestId('ego-focus-label')).toContainText('n3');
    await expect(page.getByTestId('ego-max-hops')).toHaveValue('3');
    // ...while a field the URL did not name keeps the preset's value.
    await expect(page.getByTestId('ego-direction-select')).toHaveValue('out');
  });

  test('a focus node that is not in the graph says so and leaves the graph usable', async ({
    authenticatedPage: page,
  }) => {
    await page.goto(`/graph/${MOCK_CONTEXT.id}?layout=ego&layout.ego.focusNodeId=n-999`);
    await waitForGraph(page);

    await expect(page.getByTestId('graph-status-bar')).toContainText('5 nodes');
    await expect(page.getByTestId('graph-status-layout-error')).toBeVisible();
    await expect(page.getByTestId('graph-status-layout-error')).toContainText(
      'layout setting not applied',
    );

    const toast = page.locator('.toast', { hasText: 'n-999' });
    await expect(toast).toBeVisible();
    // Exactly one: switching to ego and setting the focus happen in one
    // synchronous pass, so the canvas must not also fire its own
    // "Pick a focus node" toast.
    await expect(page.locator('.toast')).toHaveCount(1);
  });

  test('an unparseable parameter is dropped while the rest of the link still works', async ({
    authenticatedPage: page,
  }) => {
    await page.goto(
      `/graph/${MOCK_CONTEXT.id}?layout=ego` +
        `&layout.ego.focusNodeId=n1&layout.ego.maxHops=abc`,
    );
    await waitForGraph(page);

    const chip = page.getByTestId('graph-status-layout-error');
    await expect(chip).toContainText('layout setting not applied');
    await expect(chip).toHaveAttribute('title', /maxHops/);

    await openLayoutPanel(page);
    // The good half of the link survived the bad half.
    await expect(page.getByTestId('ego-focus-label')).toContainText('n1');
  });

  test('several bad parameters produce one chip listing all of them', async ({
    authenticatedPage: page,
  }) => {
    await page.goto(
      `/graph/${MOCK_CONTEXT.id}?layout=ego` +
        `&layout.ego.maxHops=abc&layout.ego.direction=sideways`,
    );
    await waitForGraph(page);

    const chip = page.getByTestId('graph-status-layout-error');
    await expect(chip).toContainText('2 layout settings not applied');
    await expect(chip).toHaveAttribute('title', /maxHops/);
    await expect(chip).toHaveAttribute('title', /direction/);
  });

  test('an appearance parameter is refused and points at style presets', async ({
    authenticatedPage: page,
  }) => {
    await page.goto(`/graph/${MOCK_CONTEXT.id}?layout=ego&layout.ego.ringSpacing=200`);
    await waitForGraph(page);

    const chip = page.getByTestId('graph-status-layout-error');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('title', /style preset/);
  });

  test('an unknown layout algorithm is reported', async ({ authenticatedPage: page }) => {
    await page.goto(`/graph/${MOCK_CONTEXT.id}?layout=circular`);
    await waitForGraph(page);

    await expect(page.getByTestId('graph-status-bar')).toContainText('5 nodes');
    await expect(page.getByTestId('graph-status-layout-error')).toHaveAttribute(
      'title',
      /is not a layout/,
    );
  });

  test('an ordinary open shows no layout chip', async ({ authenticatedPage: page }) => {
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await waitForGraph(page);

    await expect(page.getByTestId('graph-status-layout-error')).toHaveCount(0);
  });

  test('a focus node is not blamed on a graph that has not loaded anything', async ({
    authenticatedPage: page,
  }) => {
    // This context does not auto-load, so it opens empty. An empty graph cannot
    // answer "is this node here", and saying "not found" would blame the link
    // for the user not having run a query yet.
    await page.goto(
      `/graph/${MOCK_CONTEXT_NO_AUTOLOAD.id}?layout=ego&layout.ego.focusNodeId=n1`,
    );
    await waitForGraph(page);

    await expect(page.getByTestId('graph-status-bar')).toContainText('0 nodes');
    await expect(page.getByTestId('graph-status-layout-error')).toHaveCount(0);
    await expect(page.locator('.toast')).toHaveCount(0);
  });

  test('style and layout overrides compose in one link', async ({
    authenticatedPage: page,
  }) => {
    await seedStylePresets(page, MOCK_CONTEXT.id, { 'ego-investigacao': EGO_PRESET });

    await page.goto(
      `/graph/${MOCK_CONTEXT.id}?style=ego-investigacao&layout.ego.focusNodeId=n1`,
    );
    await waitForGraph(page);

    await expect(page.getByTestId('graph-status-style')).toContainText('ego-investigacao');
    await expect(page.getByTestId('graph-status-layout-error')).toHaveCount(0);
    await openLayoutPanel(page);
    await expect(page.getByTestId('ego-focus-label')).toContainText('n1');
  });
});
