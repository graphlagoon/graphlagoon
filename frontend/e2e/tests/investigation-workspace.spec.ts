/**
 * F4 · analysis workspace (05 §4b, §5, §10): Vínculos by phone + device reveals a
 * synthetic cluster, a group is made from that selection without any JS and shows
 * in the dossier; groups by property, bulk roles and saved views survive a reload.
 */
import { test, expect, type Page } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts, seedInvestigations } from '../helpers/api-mocks';

const now = new Date().toISOString();
const CASE = {
  id: 'inv-s',
  title: 'Fraude sintética · cadastros em comum',
  status: 'analysis',
  kind_preset: 'fraude_sintetica',
  tags: [],
  owner_email: 'e2e@test.com',
  settings: {},
  state: {},
  shared_with: [],
  has_write_access: true,
  can_manage: true,
  created_at: now,
  updated_at: now,
  deadline: null,
};
const ITEM = {
  id: 'src-1', kind: 'graph', subkind: 'exploration_ref', title: 'Cadastros (KYC)', tags: [], status: 'confirmed', author_kind: 'human',
  author_email: 'e2e@test.com', provenance: {}, exploration_id: 'exp-1', context_id: 'ctx-s', current_version: 0, position: 0, accessible: true, pinned: [], created_at: now,
};
// Five identities: p1–p3 share a phone and a device (synthetic cluster), p4 only the device, p5 nothing.
const people = [
  ['p1', 'Ana Souza', '+55 11 99999-0000', 'DEV-1', 'SP'],
  ['p2', 'Bia Lima', '11999990000', 'dev-1', 'SP'],
  ['p3', 'Caio Melo', '+55 (11) 99999-0000', 'dev1', 'RJ'],
  ['p4', 'Davi Reis', '+55 21 98888-0000', 'DEV-1', 'RJ'],
  ['p5', 'Eva Cruz', '+55 31 97777-0000', 'dev-9', 'MG'],
];
const SNAPSHOT = {
  exploration: { id: 'exp-1', title: 'Cadastros', state: {} },
  snapshot: {
    nodes: people.map(([id, nome, telefone, device_id, uf]) => ({ id, type: 'Pessoa', properties: { nome, telefone, device_id, uf } })),
    edges: [{ id: 'e1', source: 'p1', target: 'p2', type: 'INDICOU', properties: {} }],
  },
};

/**
 * The shared mock keeps an item's JSON only for tables; analyses and views need
 * theirs back (content + snapshot of a derived layer), so this captures every
 * POSTed `content_json` and serves it from routes registered after the seed.
 */
async function keepItemContents(page: Page) {
  const contents = new Map<string, any>();
  const waiters = new Map<string, (c: any) => void>();
  /** The snapshot of a derived item is requested the instant its POST returns: wait for the capture. */
  const captured = (id: string) =>
    contents.get(id) ?? new Promise<any>((resolve) => {
      waiters.set(id, resolve);
      setTimeout(() => resolve(undefined), 3_000);
    });
  page.on('response', async (res) => {
    const req = res.request();
    if (req.method() !== 'POST' || !/\/api\/investigations\/[^/]+\/items$/.test(new URL(req.url()).pathname)) return;
    const body = req.postDataJSON?.();
    if (!body?.content_json) return;
    try {
      const id = (await res.json()).id;
      contents.set(id, body.content_json);
      waiters.get(id)?.(body.content_json);
    } catch {
      /* not JSON */
    }
  });
  const idOf = (url: string) => new URL(url).pathname.match(/\/items\/([^/]+)\/(content|snapshot)$/)![1];
  await page.route(/\/api\/investigations\/[^/]+\/items\/[^/]+\/content(\?.*)?$/, async (route) => {
    const c = await captured(idOf(route.request().url()));
    return c ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(c) }) : route.fallback();
  });
  await page.route(/\/api\/investigations\/[^/]+\/items\/[^/]+\/snapshot(\?.*)?$/, async (route) => {
    const id = idOf(route.request().url());
    const c = await captured(id);
    if (!c?.unified) return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ item_id: id, title: 'derived', context_id: null, identity_keys: [], edge_semantics: null, unified: true, snapshot: { nodes: c.nodes, edges: c.edges } }),
    });
  });
}

async function openCase(page: Page) {
  await seedContexts(page, [{ ...MOCK_CONTEXT, id: 'ctx-s', title: 'KYC' }]);
  await seedInvestigations(page, [CASE], { 'inv-s': [ITEM] }, [], { 'src-1': SNAPSHOT });
  await keepItemContents(page);
  await page.goto('/investigations/inv-s');
  await expect(page.getByTestId('workspace-status')).toContainText('5 nodes', { timeout: 15_000 });
}

test.describe('F4 · analysis workspace', () => {
  test('fraude sintética: Vínculos by phone + device reveals the cluster; a group from that selection reaches the dossier', async ({
    authenticatedPage: page,
  }) => {
    await openCase(page);
    await expect(page.getByTestId('workspace-status')).toContainText('1 edges');

    // Vínculos: the preset pre-selects telefone, email, device_id, endereco; two shared attributes keep only the trio.
    await page.getByTestId('analysis-links').click();
    const popover = page.getByTestId('popover-links');
    await expect(popover.getByTestId('link-attr-telefone')).toBeChecked();
    await expect(popover.getByTestId('link-attr-device_id')).toBeChecked();
    await popover.getByTestId('link-min-shared').fill('2');
    await popover.getByTestId('links-run').click();

    const result = page.getByTestId('links-result');
    await expect(result).toContainText('3 pairs share');
    await expect(page.getByTestId('link-pair')).toHaveCount(3);
    // The derived item is material and a layer on the canvas: 1 + 6 compartilha_* edges.
    await expect(page.getByTestId('workspace-status')).toContainText('7 edges', { timeout: 15_000 });
    await expect(page.locator('[data-testid^="item-item-"]').first()).toContainText('Vínculos por');

    // Group from the selection, no JS: select the linked entities → Agrupar.
    await page.getByTestId('links-select').click();
    await expect(page.getByTestId('inspector-multi-title')).toContainText('3 entities');
    await page.getByTestId('bulk-group-name').fill('Cluster sintético');
    await page.getByTestId('bulk-group-color-2').click();
    await page.getByTestId('bulk-group-create').click();
    await expect(page.getByTestId('status-groups')).toContainText('1 group');
    await page.getByTestId('chip-groups').click();
    await expect(page.getByTestId('chip-menu-groups')).toContainText('Cluster sintético · 3');

    // The dossier (same screen, mode=dossie) lists the group.
    await page.getByTestId('dossier-link').click();
    await expect(page).toHaveURL(/mode=dossie/);
    await expect(page.getByTestId('dossier-summary')).toContainText('Cluster sintético · 3');
    await expect(page.getByTestId('dossier-summary')).toContainText('Fraude sintética');
  });

  test('groups by property, bulk roles and a saved view survive a reload', async ({ authenticatedPage: page }) => {
    await openCase(page);

    // Grupos → by property uf: SP (2), RJ (2); MG is a singleton and not a group.
    await page.getByTestId('analysis-groups').click();
    const groups = page.getByTestId('popover-groups');
    await groups.getByTestId('group-by').selectOption('property');
    await groups.getByTestId('group-property').selectOption('uf');
    await expect(groups.getByTestId('group-preview')).toContainText('2 groups');
    await groups.getByTestId('group-create-rule').click();
    await expect(page.getByTestId('status-groups')).toContainText('2 groups');
    await expect(groups.locator('[data-testid^="group-select-"]')).toHaveCount(2);

    // Select the SP group → bulk role → the role chip offers it.
    await groups.locator('[data-testid^="group-select-"]').first().click();
    await expect(page.getByTestId('inspector-multi-title')).toContainText('2 entities');
    await page.getByTestId('bulk-role').selectOption('identidade sintética');
    await page.getByTestId('bulk-role-apply').click();
    await page.getByTestId('analysis-groups').click(); // close the popover
    await page.getByTestId('chip-roles').click();
    await page.getByTestId('chip-opt-roles-identidade sintética').check();
    await expect(page.getByTestId('chip-roles')).toContainText('papel: identidade sintética');

    // Save the chips as a view.
    await page.getByTestId('chip-views').click();
    await page.getByTestId('view-name').fill('Sintéticas');
    await page.getByTestId('view-save').click();
    await expect(page.getByTestId('chip-views')).toContainText('visões · 1');

    // Reload: groups, roles and the view come back from the server.
    await page.reload();
    await expect(page.getByTestId('workspace-status')).toContainText('5 nodes', { timeout: 15_000 });
    await expect(page.getByTestId('status-groups')).toContainText('2 groups');
    await expect(page.getByTestId('chip-views')).toContainText('visões · 1');
    await page.getByTestId('chip-views').click();
    await page.getByTestId('view-apply-item-1').click();
    await expect(page.getByTestId('chip-roles')).toContainText('papel: identidade sintética');
    await page.getByTestId('chip-groups').click();
    await expect(page.getByTestId('chip-menu-groups')).toContainText('uf = SP · 2 nós · 2');
  });
});
