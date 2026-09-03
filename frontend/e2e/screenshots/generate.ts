import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  setupAPIMocks,
  seedContexts,
  seedExplorations,
  seedGraphResponse,
  seedStylePresets,
  seedQueryTemplates,
  seedPrecomputedGraphs,
  seedSimilarityEndpoints,
  enableDatasources,
} from '../helpers/api-mocks';
import { MOCK_EXPLORATION, MOCK_REST_CONNECTION } from '../fixtures/mock-data';
import {
  SCREENSHOT_CONTEXT,
  SCREENSHOT_GRAPH_RESPONSE,
} from '../fixtures/screenshot-graph';

/**
 * Documentation screenshot generator.
 *
 * Every scene below becomes docs/public/screenshots/<guide>-<scene>.png, where
 * <guide> is the docs/guide/ page slug the image belongs to (or `index` for
 * the landing page). Adding a screenshot for a guide is a one-entry diff in
 * SCENES. Run with `make docs-screenshots`; no backend needed — the app runs
 * against the same API mocks as the E2E suite.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOTS_DIR = path.resolve(__dirname, '../../../docs/public/screenshots');

const CANVAS = '.graph3d-container canvas';
// The `docs` style preset (seeded below) labels nodes by their name property
// instead of the default truncated node_id — real feature, prettier captures.
const GRAPH_URL = `/graph/${SCREENSHOT_CONTEXT.id}?style=docs`;

function screenshotPath(name: string) {
  return path.join(SCREENSHOTS_DIR, `${name}.png`);
}

/**
 * Deterministic replacement for blind sleeps: __THREE_RENDERER_INFO__ proves
 * the WebGL scene has real geometry on screen, and __GRAPH_LAYOUT_DONE__ waits
 * for the initial force-layout cooldown — the moment node labels appear.
 * Both hooks are dev-only, exposed by GraphCanvas3D.
 */
async function waitForGraphSettled(page: Page) {
  await page.waitForFunction(
    () => {
      const info = (window as any).__THREE_RENDERER_INFO__?.();
      const layoutDone = (window as any).__GRAPH_LAYOUT_DONE__?.();
      return !!info && info.render.frame > 30 && info.render.triangles > 0 && !!layoutDone;
    },
    { timeout: 45_000 },
  );
  // One settle pass so labels/camera finish their post-layout fade-in.
  await page.waitForTimeout(500);
}

/** Open a toolbar panel by its button title and let it paint. */
async function openPanel(page: Page, title: string) {
  await page.getByTitle(title, { exact: true }).click();
  await page.waitForTimeout(400);
}

/**
 * Hover a node using the dev-only __GRAPH_NODE_SCREEN_COORDS__ hook (WebGL is
 * opaque to DOM selectors) — same approach as e2e/tests/context-menu.spec.ts.
 */
async function hoverNode(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  const canvas = page.locator(CANVAS);
  await expect(canvas).toBeVisible({ timeout: 15_000 });

  for (let attempt = 0; attempt < 30; attempt++) {
    const coords = await page.evaluate(
      (id) => (window as any).__GRAPH_NODE_SCREEN_COORDS__?.(id) as { x: number; y: number } | null,
      nodeId,
    );
    if (coords) {
      const box = await canvas.boundingBox();
      if (box) {
        const x = box.x + coords.x;
        const y = box.y + coords.y;
        await page.mouse.move(x, y);
        try {
          await expect(canvas).toHaveClass(/clickable/, { timeout: 2_000 });
          return { x, y };
        } catch {
          // Camera still animating — node not under the pointer yet, retry
        }
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`could not hover node ${nodeId}`);
}

const DEMO_TEMPLATES = [
  {
    id: 'tpl-influencers',
    graph_context_id: SCREENSHOT_CONTEXT.id,
    owner_email: 'demo@graphlagoon.dev',
    name: 'Key influencers',
    description: 'People with the most connections',
    query_type: 'cypher',
    query: 'MATCH (p:Person)-[k:KNOWS]-() RETURN p ORDER BY count(k) DESC',
    parameters: [],
    options: { procedural_bfs: false, large_results_mode: false },
    visibility: 'shared',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'tpl-company-graph',
    graph_context_id: SCREENSHOT_CONTEXT.id,
    owner_email: 'demo@graphlagoon.dev',
    name: 'Company neighborhood',
    description: 'A company, its employees and products',
    query_type: 'cypher',
    query: 'MATCH (c:Company {name: $company})--(n) RETURN c, n',
    parameters: [{ name: 'company', label: 'Company name', default: 'Acme Analytics' }],
    options: { procedural_bfs: false, large_results_mode: false },
    visibility: 'private',
    created_at: '2026-01-02T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  },
];

// A believable catalog for the Clusters → Similarity tab. The compute
// endpoints are never called — the scene captures the configured form.
const DEMO_SIMILARITY_ENDPOINTS = [
  {
    name: 'embedding-cosine',
    description: 'Cosine similarity over node embeddings',
    endpoint: '/demo-api/similarity/cosine',
    params: [
      {
        name: 'threshold',
        type: 'float',
        default: 0.75,
        required: false,
        description: 'Minimum score to keep a pair',
      },
      {
        name: 'top_k',
        type: 'int',
        default: 10,
        required: false,
        description: 'Keep at most this many neighbours per node',
      },
    ],
  },
  {
    name: 'shared-neighbors',
    description: 'Jaccard overlap of direct neighbourhoods',
    endpoint: '/demo-api/similarity/jaccard',
    params: [
      {
        name: 'min_overlap',
        type: 'float',
        default: 0.2,
        required: false,
        description: 'Minimum Jaccard index',
      },
    ],
  },
];

const DEMO_PRESETS = {
  docs: {
    aesthetics: {},
    nodeTypeColors: {},
    edgeTypeColors: {},
    textFormat: {
      rules: [],
      defaults: { nodeTemplate: '{prop:name}', edgeTemplate: '{relationship_type}' },
    },
    layout_algorithm: 'forceAtlas2',
    layout_mode_config: { ego: {}, hive: {}, hierarchical: {} },
    force3d_settings: {},
  },
  investigation: {
    aesthetics: { nodeSize: 9 },
    nodeTypeColors: { Person: '#e5484d' },
    edgeTypeColors: {},
    textFormat: { rules: [], defaults: {} },
    layout_algorithm: 'hive',
    layout_mode_config: { ego: {}, hive: {}, hierarchical: {} },
    force3d_settings: {},
  },
  presentation: {
    aesthetics: { nodeSize: 12 },
    nodeTypeColors: { Company: '#3e63dd' },
    edgeTypeColors: {},
    textFormat: { rules: [], defaults: {} },
    layout_algorithm: 'forceAtlas2',
    layout_mode_config: { ego: {}, hive: {}, hierarchical: {} },
    force3d_settings: {},
  },
};

/** Authenticated page with mock data. Reuses the E2E mock infrastructure. */
async function setupPage(page: Page) {
  await page.addInitScript(() => {
    (window as any).__GRAPH_LAGOON_CONFIG__ = {
      dev_mode: true,
      database_enabled: false,
    };
    // Disables the stats-gl FPS overlay (see useDevPerf.ts) — the generator
    // runs against the dev server, where the overlay would otherwise show up.
    (window as any).__SCREENSHOT_MODE__ = true;
    localStorage.setItem('userEmail', 'demo@graphlagoon.dev');
    // Hide dev-only chrome that would look out of place in the docs.
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent =
        '[data-testid="nav-dev"], .exploration-unsaved { display: none !important; }';
      document.head.appendChild(style);
    });
  });

  // Set up API mocks first, then seed data (later routes take precedence)
  await setupAPIMocks(page);

  const contexts = [
    SCREENSHOT_CONTEXT,
    {
      ...SCREENSHOT_CONTEXT,
      id: 'ctx-supply',
      title: 'Supply Chain',
      description: 'Supplier and product graph',
      tags: ['env:prod', 'team:logistics'],
      node_types: ['Supplier', 'Product', 'Warehouse'],
      relationship_types: ['SUPPLIES', 'STORED_AT'],
    },
  ];

  const explorations = [
    {
      ...MOCK_EXPLORATION,
      id: 'exp-influencers',
      title: 'Key influencers',
      graph_context_id: SCREENSHOT_CONTEXT.id,
    },
    {
      ...MOCK_EXPLORATION,
      id: 'exp-bottlenecks',
      title: 'Supply chain bottlenecks',
      graph_context_id: 'ctx-supply',
    },
  ];

  await seedContexts(page, contexts);
  await seedExplorations(page, explorations);
  await seedGraphResponse(page, SCREENSHOT_GRAPH_RESPONSE);
  await seedStylePresets(page, SCREENSHOT_CONTEXT.id, DEMO_PRESETS);
  await seedQueryTemplates(page, SCREENSHOT_CONTEXT.id, DEMO_TEMPLATES);
  await seedPrecomputedGraphs(page, SCREENSHOT_CONTEXT.id, {
    'demo-subgraph': {
      nodes: SCREENSHOT_GRAPH_RESPONSE.nodes,
      edges: SCREENSHOT_GRAPH_RESPONSE.edges,
    },
  });
  await seedSimilarityEndpoints(page, DEMO_SIMILARITY_ENDPOINTS);
  // Advertise a named REST connection so the datasource picker shows the full
  // roster (rest-connections scene). Invisible everywhere else — the picker
  // only exists inside the create-context modal.
  await enableDatasources(page, { sql_warehouse: true, neptune: false }, [
    MOCK_REST_CONNECTION,
  ]);
}

interface Scene {
  /** docs/guide/ page slug this image belongs to (`index` for the landing page). */
  guide: string;
  /** Distinguishes multiple images for the same guide. */
  scene: string;
  path: string;
  /** Interactions to run before capturing (panels, menus, waits). */
  prepare?: (page: Page) => Promise<void>;
}

const SCENES: Scene[] = [
  {
    guide: 'index',
    scene: 'contexts',
    path: '/contexts',
    prepare: async (page) => {
      await page
        .waitForSelector('[data-testid="context-card"], .context-card, h1', { timeout: 10_000 })
        .catch(() => {});
      await page.waitForTimeout(500);
    },
  },
  {
    guide: 'index',
    scene: 'graph',
    path: GRAPH_URL,
    prepare: waitForGraphSettled,
  },
  {
    // Create-context modal for a triple-store-only warehouse: no node tables
    // in the datasets listing, so the "No node table" checkbox is pre-checked
    // and the node column mapping is hidden.
    guide: 'triple-stores',
    scene: 'nodeless-context',
    path: '/contexts',
    prepare: async (page) => {
      await page.route('**/graphlagoon/api/datasets', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            edge_tables: ['warehouse.graph.triples'],
            node_tables: [],
          }),
        });
      });
      await page.getByTestId('create-context-btn').click();
      await expect(page.getByTestId('create-context-modal')).toBeVisible();
      await expect(page.getByTestId('no-node-table-checkbox')).toBeChecked();
      await page.getByTestId('assign-edge-warehouse.graph.triples').click();
      await page.getByPlaceholder('My Graph Context').fill('Supply-chain triples');
      await page.waitForTimeout(300);
    },
  },
  {
    guide: 'explorations',
    scene: 'list',
    path: '/explorations',
    prepare: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    guide: 'style-presets',
    scene: 'modal',
    path: GRAPH_URL,
    prepare: async (page) => {
      await waitForGraphSettled(page);
      await openPanel(page, 'Style');
      await page.getByTestId('style-preset-open').click();
      await expect(page.getByTestId('style-preset-modal')).toBeVisible();
      await page.waitForTimeout(300);
    },
  },
  {
    guide: 'query-templates',
    scene: 'panel',
    path: GRAPH_URL,
    prepare: async (page) => {
      await waitForGraphSettled(page);
      await openPanel(page, 'Query Templates');
    },
  },
  {
    guide: 'labels',
    scene: 'panel',
    path: GRAPH_URL,
    prepare: async (page) => {
      await waitForGraphSettled(page);
      await openPanel(page, 'Labels');
    },
  },
  {
    guide: 'exploring-the-graph',
    scene: 'filters',
    path: GRAPH_URL,
    prepare: async (page) => {
      await waitForGraphSettled(page);
      await openPanel(page, 'Filters');
    },
  },
  {
    // Property allowlist active: Style panel picker + pruned Data Table with
    // its "Showing N of M properties · Show all" hint.
    guide: 'exploring-the-graph',
    scene: 'property-visibility',
    path: GRAPH_URL,
    prepare: async (page) => {
      await waitForGraphSettled(page);
      await openPanel(page, 'Style');
      await page.getByTestId('property-visibility-node-toggle').check();
      await page.getByTestId('property-visibility-node').click();
      await page.getByRole('option', { name: 'role' }).click();
      await page.getByRole('option', { name: 'city' }).click();
      await page.keyboard.press('Escape');
      // The section sits at the bottom of the Style panel — scroll it into frame.
      await page
        .locator('.aesthetics-panel')
        .evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.getByTitle('Data Table').click();
      await page.waitForSelector('.data-table-drawer', { timeout: 10_000 });
      await page.waitForTimeout(400);
    },
  },
  {
    // The "Hide empty properties and metrics" switch in Style → Details Display.
    guide: 'exploring-the-graph',
    scene: 'hide-empty-values',
    path: GRAPH_URL,
    prepare: async (page) => {
      await waitForGraphSettled(page);
      await openPanel(page, 'Style');
      // The section sits near the bottom of the Style panel — scroll it in.
      await page
        .locator('.aesthetics-panel')
        .evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.getByTestId('hide-empty-values-toggle').waitFor();
      await page.waitForTimeout(300);
    },
  },
  {
    guide: 'clusters',
    scene: 'programs',
    path: GRAPH_URL,
    prepare: async (page) => {
      await waitForGraphSettled(page);
      await openPanel(page, 'Clusters');
      await page.getByRole('button', { name: 'Programs' }).click();
      await page.waitForTimeout(400);
    },
  },
  {
    guide: 'communities-metrics',
    scene: 'metrics',
    path: GRAPH_URL,
    prepare: async (page) => {
      await waitForGraphSettled(page);
      await openPanel(page, 'Metrics');
    },
  },
  {
    // Visual Mapping tab with the Node Color section active: built-in Degree
    // driving the gradient, low/high color pickers visible, canvas recolored.
    guide: 'communities-metrics',
    scene: 'color-mapping',
    path: GRAPH_URL,
    prepare: async (page) => {
      await waitForGraphSettled(page);
      await openPanel(page, 'Metrics');
      await page.getByText('Visual Mapping').click();
      await page.getByTestId('node-color-metric-select').selectOption('__builtin_degree');
      await page.getByTestId('node-color-min').waitFor({ timeout: 5_000 });
      await page.waitForTimeout(600);
    },
  },
  {
    // Built-in Degree flagged as a Data Table column: Metrics panel checkbox
    // checked + the drawer showing the numeric Degree column.
    guide: 'communities-metrics',
    scene: 'table-columns',
    path: GRAPH_URL,
    prepare: async (page) => {
      await waitForGraphSettled(page);
      await openPanel(page, 'Metrics');
      await page.getByTestId('metric-table-toggle-__builtin_degree').check();
      await page.getByTitle('Data Table').click();
      await page.waitForSelector('.data-table-drawer', { timeout: 10_000 });
      await page.waitForTimeout(400);
    },
  },
  {
    // Custom tab: the auto-run metric already computed, the manual one waiting
    // for Recompute, plus the Import/Export and robot buttons.
    guide: 'communities-metrics',
    scene: 'custom',
    path: GRAPH_URL,
    prepare: async (page) => {
      await waitForGraphSettled(page);
      await openPanel(page, 'Metrics');
      await page.getByTestId('metrics-tab-custom').click();
      await page
        .getByTestId('custom-metric-status-cm-city-tag')
        .filter({ hasText: 'done' })
        .waitFor({ timeout: 15_000 });
      await page.waitForTimeout(300);
    },
  },
  {
    // The editor with a definition tested against the current graph.
    guide: 'communities-metrics',
    scene: 'custom-editor',
    path: GRAPH_URL,
    prepare: async (page) => {
      await waitForGraphSettled(page);
      await openPanel(page, 'Metrics');
      await page.getByTestId('metrics-tab-custom').click();
      await page.getByTestId('custom-metric-edit-cm-neighbour-degree').click();
      await page.getByTestId('custom-metric-test').click();
      await page.getByTestId('custom-metric-test-results').waitFor({ timeout: 15_000 });
      await page.waitForTimeout(500);
    },
  },
  {
    guide: 'context-menu-actions',
    scene: 'menu',
    path: GRAPH_URL,
    prepare: async (page) => {
      await waitForGraphSettled(page);
      // Same retry loop as context-menu.spec.ts — the raycast runs per frame,
      // so a right-click can land while the camera is still easing.
      const menu = page.getByTestId('graph-context-menu');
      let opened = false;
      for (let attempt = 0; attempt < 5 && !opened; attempt++) {
        await hoverNode(page, 'person-0');
        await page.mouse.down({ button: 'right' });
        await page.mouse.up({ button: 'right' });
        opened = await menu
          .waitFor({ state: 'visible', timeout: 2_000 })
          .then(() => true)
          .catch(() => false);
      }
      await expect(menu).toBeVisible();
      await page.waitForTimeout(200);
    },
  },
  {
    guide: 'layout-url-overrides',
    scene: 'ego',
    path: `${GRAPH_URL}&layout=ego&layout.ego.focusNodeId=person-0`,
    prepare: waitForGraphSettled,
  },
  {
    guide: 'precomputed-graphs',
    scene: 'status',
    path: `${GRAPH_URL}&precomputed=demo-subgraph`,
    prepare: waitForGraphSettled,
  },
  {
    guide: 'similarity',
    scene: 'panel',
    path: GRAPH_URL,
    prepare: async (page) => {
      await waitForGraphSettled(page);
      await openPanel(page, 'Clusters');
      await page.getByRole('button', { name: 'Similarity' }).click();
      await page.waitForTimeout(400);
      // Configure the form so the dynamic param inputs are on screen.
      await page.selectOption('#sim-endpoint', 'embedding-cosine');
      await page.selectOption('#sim-node-type', { label: 'Person' });
      await page.waitForTimeout(300);
    },
  },
  {
    guide: 'rest-connections',
    scene: 'picker',
    path: '/contexts',
    prepare: async (page) => {
      await page.getByTestId('create-context-btn').click();
      await expect(page.getByTestId('datasource-picker')).toBeVisible();
      await page.waitForTimeout(400);
    },
  },
];

test.describe('Documentation Screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  for (const s of SCENES) {
    test(`${s.guide}-${s.scene}`, async ({ page }) => {
      await page.goto(s.path);
      await s.prepare?.(page);
      await page.screenshot({
        path: screenshotPath(`${s.guide}-${s.scene}`),
        fullPage: false,
      });
    });
  }

  test('getting-started-login', async ({ browser }) => {
    // Fresh context without the auth init script
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    await page.addInitScript(() => {
      (window as any).__GRAPH_LAGOON_CONFIG__ = {
        dev_mode: true,
        database_enabled: false,
      };
      (window as any).__SCREENSHOT_MODE__ = true;
    });

    await setupAPIMocks(page);
    await page.goto('/login');
    await page.waitForTimeout(500);

    await page.screenshot({
      path: screenshotPath('getting-started-login'),
      fullPage: false,
    });

    await context.close();
  });
});
