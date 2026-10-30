/**
 * UX-1 · the case workspace: one graph at a time (the legend picks, "All graphs"
 * unifies, the choice survives a reload), an attached exploration opens on its own
 * page, the dossier reads the notes and documents, removing is undone, the queue
 * keeps its filters across Back, and Escape closes the menu and the settings drawer.
 */
import { test, expect } from '../fixtures/test-fixtures';
import { seedInvestigations, seedStylePresets } from '../helpers/api-mocks';
import { waitForLayoutDone, waitForNodeVisualState } from '../helpers/graph-hooks';

const now = new Date().toISOString();
const CASE = {
  id: 'inv-u',
  title: 'Mule network · two banks',
  description: null,
  status: 'analysis',
  case_type: 'general',
  fields: {},
  tags: [],
  owner_email: 'e2e@test.com',
  settings: {},
  state: {},
  shared_with: [],
  decisions: [],
  has_write_access: true,
  can_manage: true,
  created_at: now,
  updated_at: now,
  deadline: null,
};
const base = { tags: [], status: 'confirmed', author_kind: 'human', author_email: 'e2e@test.com', provenance: {}, position: 0, accessible: true, pinned: [], created_at: now };
const ref = (id: string, title: string, ctx: string, exp: string) => ({ ...base, id, kind: 'graph', subkind: 'exploration_ref', title, context_id: ctx, exploration_id: exp, current_version: 0 });
const version = (contentType: string, size = 120) => ({ version: 1, sha256: 'a'.repeat(64), size_bytes: size, content_type: contentType, created_by: 'e2e@test.com', author_kind: 'human', has_text: true });
const ITEMS = [
  ref('g-a', 'Bank A transfers', 'ctx-a', 'exp-a'),
  ref('g-b', 'Bank B transfers', 'ctx-b', 'exp-b'),
  { ...base, id: 'n-1', kind: 'note', subkind: 'anchored', title: 'Same phone', description: 'Same **phone** as the mule', anchor: { entity_ids: ['x'] }, current_version: 1, latest: version('text/markdown') },
  { ...base, id: 'd-1', kind: 'document', subkind: 'markdown', title: 'Ring memo', current_version: 1, latest: version('text/markdown'), _text: '# Findings\n- two banks\n- one phone' },
  { ...base, id: 'd-2', kind: 'document', subkind: 'link', title: 'Bank notice', provenance: { url: 'https://example.com/notice' }, current_version: 1, latest: version('text/plain') },
  { ...base, id: 'd-3', kind: 'document', subkind: 'upload', title: 'statement.pdf', provenance: { filename: 'statement.pdf' }, current_version: 1, latest: version('application/pdf', 2048) },
];
const snap = (ids: string[]) => ({
  exploration: { state: {} },
  snapshot: { nodes: ids.map((id) => ({ id, type: 'Account', properties: { name: id } })), edges: [] },
});
const SNAPSHOTS = { 'g-a': snap(['a1', 'a2', 'a3']), 'g-b': snap(['b1', 'b2']) };

test.describe('Investigation workspace UX (UX-1)', () => {
  test('one graph at a time: the legend picks, "All graphs" unifies, a reload keeps the choice', async ({ authenticatedPage: page }) => {
    await seedInvestigations(page, [structuredClone(CASE)], { 'inv-u': structuredClone(ITEMS) }, [], SNAPSHOTS);
    await page.goto('/investigations/inv-u');
    const status = page.getByTestId('workspace-status');
    await expect(status).toContainText('3 nodes', { timeout: 15_000 });
    await expect(status).toContainText('1 source');

    await page.getByTestId('legend-item-g-b').click();
    await expect(status).toContainText('2 nodes');
    await page.getByTestId('canvas-all').click();
    await expect(status).toContainText('5 nodes');
    await expect(status).toContainText('2 sources');

    await page.reload();
    await expect(status).toContainText('5 nodes', { timeout: 15_000 });
    await expect(page.getByTestId('canvas-one')).toBeVisible();
  });

  test('picking a graph clears the canvas and lays it out on its own, not as a piece of the unified view', async ({ authenticatedPage: page }) => {
    const unified = { ...structuredClone(CASE), state: { canvas_items: 'all' } };
    await seedInvestigations(page, [unified], { 'inv-u': structuredClone(ITEMS) }, [], SNAPSHOTS);
    await page.goto('/investigations/inv-u');
    const status = page.getByTestId('workspace-status');
    await expect(status).toContainText('5 nodes', { timeout: 15_000 });
    const position = () => page.evaluate(() => (window as any).__GRAPH_NODE_POSITION__?.('a1@ctx-a') ?? null);
    await expect.poll(() => page.evaluate(() => (window as any).__GRAPH_LAYOUT_DONE__?.() ?? false), { timeout: 15_000 }).toBe(true);
    const before = await position();
    expect(before).not.toBeNull();

    await page.getByTestId('legend-item-g-a').click();
    await expect(status).toContainText('3 nodes');
    // Laid out anew: the node does not keep its place from the unified layout.
    await expect
      .poll(async () => {
        const now = await position();
        return now ? Math.hypot(now.x - before.x, now.y - before.y, now.z - before.z) : 0;
      }, { timeout: 15_000 })
      .toBeGreaterThan(1);

    // A graph picked in the material list shows alone too.
    await page.getByTestId('item-g-b').click();
    await expect(status).toContainText('2 nodes');
    await expect(status).toContainText('1 source');
  });

  test('an attached exploration opens on its own page, with the way back to the case', async ({ authenticatedPage: page }) => {
    await seedInvestigations(page, [structuredClone(CASE)], { 'inv-u': structuredClone(ITEMS) }, [], SNAPSHOTS);
    await page.goto('/investigations/inv-u');
    await page.getByTestId('item-g-a').click();
    const open = page.getByTestId('item-open-exploration');
    await expect(open).toBeVisible();
    await open.click();
    await page.waitForURL(/\/graph\/ctx-a\?exploration=exp-a&case=inv-u$/);
  });

  test('the dossier reads the notes and documents: rendered, linked, downloadable', async ({ authenticatedPage: page }) => {
    await seedInvestigations(page, [structuredClone(CASE)], { 'inv-u': structuredClone(ITEMS) }, [], SNAPSHOTS);
    await page.goto('/investigations/inv-u?mode=dossier');
    const section = page.getByTestId('dossier-documents');
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('dossier-writing-body-n-1').locator('strong')).toHaveText('phone');
    await expect(page.getByTestId('dossier-writing-body-d-1').locator('h3')).toHaveText('Findings');
    await expect(page.getByTestId('dossier-writing-body-d-1').locator('li')).toHaveCount(2);
    await expect(page.getByTestId('dossier-link-d-2')).toHaveAttribute('href', 'https://example.com/notice');
    await expect(page.getByTestId('dossier-writing-d-3')).toContainText('application/pdf · 2.0 KB');
    await expect(page.getByTestId('dossier-download-d-3')).toBeVisible();
  });

  test('removing an item is undone from the toast; "Removed" restores it too', async ({ authenticatedPage: page }) => {
    await seedInvestigations(page, [structuredClone(CASE)], { 'inv-u': structuredClone(ITEMS) }, [], SNAPSHOTS);
    await page.goto('/investigations/inv-u');
    await expect(page.getByTestId('item-d-1')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('item-remove-d-1').click();
    await expect(page.getByTestId('item-d-1')).toHaveCount(0);
    await page.getByTestId('toast-action-undo').click();
    await expect(page.getByTestId('item-d-1')).toBeVisible();

    await page.getByTestId('item-remove-d-2').click();
    await expect(page.getByTestId('item-d-2')).toHaveCount(0);
    await page.getByTestId('items-removed').getByRole('button', { name: /Removed/ }).click();
    await page.getByTestId('item-restore-d-2').click();
    await expect(page.getByTestId('item-d-2')).toBeVisible();
  });

  test('the queue keeps its filters across Back; Escape closes the menu and the settings drawer', async ({ authenticatedPage: page }) => {
    await seedInvestigations(page, [structuredClone(CASE), { ...structuredClone(CASE), id: 'inv-v', title: 'Card testing' }], { 'inv-u': structuredClone(ITEMS) }, [], SNAPSHOTS);
    await page.goto('/investigations');
    await page.getByTestId('investigations-search').fill('mule');
    await expect(page).toHaveURL(/[?&]q=mule/);
    await expect(page.locator('[data-testid^="investigation-row-"]')).toHaveCount(1);
    await page.getByRole('link', { name: 'Mule network · two banks' }).click();
    await page.waitForURL('**/investigations/inv-u');
    await page.goBack();
    await expect(page.getByTestId('investigations-search')).toHaveValue('mule');
    await expect(page.locator('[data-testid^="investigation-row-"]')).toHaveCount(1);

    await page.goto('/investigations/inv-u');
    await page.getByTestId('case-menu').click();
    await expect(page.getByTestId('case-menu-list')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('case-menu-list')).toHaveCount(0);

    await page.getByTestId('case-settings-btn').click();
    await expect(page.getByTestId('case-settings')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('case-settings')).toHaveCount(0);
  });

  test('the canvas wears the look saved on the item over its exploration\'s, and the stock look when there is none', async ({ authenticatedPage: page }) => {
    const snapshots = structuredClone(SNAPSHOTS) as Record<string, any>;
    snapshots['g-a'].look = { nodeTypeColors: { Account: '#0000ff' } }; // the exploration's
    const items = structuredClone(ITEMS) as any[];
    items[0].state = { look: { nodeTypeColors: { Account: '#ff0000' } } }; // the case's
    await seedInvestigations(page, [structuredClone(CASE)], { 'inv-u': items }, [], snapshots);
    await page.goto('/investigations/inv-u');
    await expect(page.getByTestId('workspace-status')).toContainText('3 nodes', { timeout: 15_000 });
    expect((await waitForNodeVisualState(page, 'a1@ctx-a')).color.toLowerCase()).toBe('#ff0000');

    // Bank B has no look of its own: the stock palette, not Bank A's red.
    await page.getByTestId('legend-item-g-b').click();
    await expect(page.getByTestId('workspace-status')).toContainText('2 nodes');
    expect((await waitForNodeVisualState(page, 'b1@ctx-b')).color.toLowerCase()).not.toBe('#ff0000');
  });

  test('the Look panel applies a preset of the graph\'s context and saves it on the item; off on a unified canvas', async ({ authenticatedPage: page }) => {
    await seedInvestigations(page, [structuredClone(CASE)], { 'inv-u': structuredClone(ITEMS) }, [], SNAPSHOTS);
    await seedStylePresets(page, 'ctx-a', { investigacao: { nodeTypeColors: { Account: '#00ff00' }, layout_algorithm: 'force' } });
    await page.goto('/investigations/inv-u');
    await expect(page.getByTestId('workspace-status')).toContainText('3 nodes', { timeout: 15_000 });

    await page.getByTestId('workspace-look-btn').click();
    await expect(page.getByTestId('panel-look')).toBeVisible();
    await expect(page.getByTestId('look-caption')).toContainText('Default look');
    await page.getByTestId('look-tab-presets').click();
    await page.getByTestId('style-preset-apply-investigacao').click();
    await expect.poll(async () => (await waitForNodeVisualState(page, 'a1@ctx-a')).color.toLowerCase(), { timeout: 15_000 }).toBe('#00ff00');

    const patches: any[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/items/g-a')) patches.push(r.postDataJSON()); });
    await page.getByTestId('style-save-look').click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0].state.look.nodeTypeColors).toEqual({ Account: '#00ff00' });
    await expect(page.getByTestId('look-caption')).toContainText('Bank A transfers');

    // The saved look survives a reload: the mock keeps the patched item.
    await page.reload();
    await expect(page.getByTestId('workspace-status')).toContainText('3 nodes', { timeout: 15_000 });
    expect((await waitForNodeVisualState(page, 'a1@ctx-a')).color.toLowerCase()).toBe('#00ff00');

    await page.getByTestId('canvas-all').click();
    await page.getByTestId('workspace-look-btn').click();
    await expect(page.getByTestId('style-save-look')).toBeDisabled();
    await expect(page.getByTestId('style-save-look-reason')).toContainText('one graph');
  });

  test('a default focus opens the graph selected and centred on that node, without a click', async ({ authenticatedPage: page }) => {
    const items = structuredClone(ITEMS) as any[];
    items[0].state = { look: { focus_node_id: 'a2' } };
    await seedInvestigations(page, [structuredClone(CASE)], { 'inv-u': items }, [], SNAPSHOTS);
    await page.goto('/investigations/inv-u');
    await expect(page.getByTestId('workspace-status')).toContainText('3 nodes', { timeout: 15_000 });
    await expect(page.getByTestId('inspector-title')).toHaveText('a2', { timeout: 15_000 });
    // The hook returns null once the focus landed (undefined would mean no hook at all).
    await expect.poll(() => page.evaluate(() => (window as any).__GRAPH_PENDING_FOCUS__?.()), { timeout: 15_000 }).toBeNull();
    // The inspector offers to drop it; a node of the graph can take its place.
    await expect(page.getByTestId('inspector-default-focus')).toContainText('✓');
  });

  test('clicking an edge shows its details in the inspector and follows the money from it', async ({ authenticatedPage: page }) => {
    const snapshots = structuredClone(SNAPSHOTS) as Record<string, any>;
    snapshots['g-a'].snapshot.edges = [{ id: 'e1', source: 'a1', target: 'a2', type: 'TRANSFER', properties: { amount: 1500, memo: 'rent' } }];
    await seedInvestigations(page, [structuredClone(CASE)], { 'inv-u': structuredClone(ITEMS) }, [], snapshots);
    await page.goto('/investigations/inv-u');
    await expect(page.getByTestId('workspace-status')).toContainText('1 edges', { timeout: 15_000 });
    await waitForLayoutDone(page);
    await page.evaluate(() => (window as any).__GRAPH_SELECT_EDGE__('g-a:e1'));
    const title = page.getByTestId('inspector-edge-title');
    await expect(title).toContainText('a1');
    await expect(title).toContainText('a2');
    await expect(page.getByTestId('workspace-inspector')).toContainText('memo');
    await expect(page.getByTestId('inspector-edge-source')).toHaveText('Bank A transfers');
    await page.getByTestId('inspector-edge-dst').click();
    await expect(page.getByTestId('inspector-title')).toHaveText('a2');
  });

  test('nothing over the canvas overlaps: the strip, the panels and the analysis bar keep to their own space', async ({ authenticatedPage: page }) => {
    await seedInvestigations(page, [structuredClone(CASE)], { 'inv-u': structuredClone(ITEMS) }, [], SNAPSHOTS);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(viewport);
      await page.goto('/investigations/inv-u');
      await expect(page.getByTestId('workspace-status')).toContainText('3 nodes', { timeout: 15_000 });
      await page.getByTestId('workspace-look-btn').click();
      await page.getByTestId('workspace-layout-btn').click();
      const box = async (testid: string) => (await page.getByTestId(testid).boundingBox())!;
      const bar = await page.locator('[data-testid="analysis-bar"] .buttons').boundingBox();
      const look = await box('panel-look');
      const strip = await box('case-filter-chips');
      expect(bar).not.toBeNull();
      // The panel ends above the analysis bar and starts below the strip.
      expect(look.y + look.height).toBeLessThanOrEqual(bar!.y + 1);
      expect(look.y).toBeGreaterThanOrEqual(strip.y + strip.height - 1);
      await expect(page.getByTestId('controls-hint')).toHaveCount(0);
    }
  });
});
