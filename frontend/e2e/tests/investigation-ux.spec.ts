/**
 * UX-1 · the case workspace: one graph at a time (the legend picks, "All graphs"
 * unifies, the choice survives a reload), an attached exploration opens on its own
 * page, the dossier reads the notes and documents, removing is undone, the queue
 * keeps its filters across Back, and Escape closes the menu and the settings drawer.
 */
import { test, expect } from '../fixtures/test-fixtures';
import { seedInvestigations } from '../helpers/api-mocks';

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
});
