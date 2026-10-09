import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT, MOCK_EXPLORATION } from '../fixtures/mock-data';
import { seedContexts, seedExplorations, seedInvestigations } from '../helpers/api-mocks';

const now = new Date().toISOString();
const CASE = {
  id: 'inv-1',
  title: 'Golpe Pix · falsa central',
  status: 'analise',
  typology: 'Golpe Pix',
  origin: 'MED',
  owner_email: 'e2e@test.com',
  assignee_email: 'ana@test.com',
  state: {},
  shared_with: [],
  has_write_access: true,
  can_manage: true,
  created_at: now,
  updated_at: now,
  source_count: 2,
};
const RESTRICTED_SOURCE = {
  id: 'src-r',
  kind: 'exploration',
  position: 0,
  title_snapshot: 'Cartões suspeitos',
  context_title: 'Cartões · emissão',
  owner_email: 'mendes@test.com',
  accessible: false,
};

test.describe('Investigations', () => {
  test('the queue lists cases from the top navigation', async ({ authenticatedPage: page }) => {
    await seedInvestigations(page, [CASE]);
    await page.goto('/contexts');
    await page.getByTestId('nav-investigations').click();

    const row = page.getByTestId('investigation-row-inv-1');
    await expect(row).toContainText('Golpe Pix · falsa central');
    await expect(row).toContainText('In analysis');
    await expect(row).toContainText('ana@test.com');
    await expect(row).toContainText('2 sources');
    await expect(row).toContainText('d left');
  });

  test('"New investigation" needs investigation.create', async ({ authenticatedPage: page }) => {
    await page.addInitScript(() => {
      (window as any).__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, database_enabled: false, permissions: [] };
    });
    await seedInvestigations(page, [CASE]);
    await page.goto('/investigations');
    await expect(page.getByTestId('investigation-row-inv-1')).toBeVisible();
    await expect(page.getByTestId('new-investigation-btn')).toHaveCount(0);
  });

  test('adds an exploration to a case, frozen, with the restricted source as a placeholder', async ({
    authenticatedPage: page,
  }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedExplorations(page, [MOCK_EXPLORATION]);
    const { added } = await seedInvestigations(page, [CASE], { 'inv-1': [RESTRICTED_SOURCE] });

    await page.goto('/explorations');
    await page.getByTestId(`exploration-add-to-investigation-${MOCK_EXPLORATION.id}`).click();
    const modal = page.getByTestId('add-to-investigation-modal');
    await modal.getByTestId('add-case-select').selectOption('inv-1');

    await expect(modal.getByTestId('add-restricted-source')).toContainText("don't have access");
    await expect(modal.getByTestId('add-restricted-source')).toContainText('Cartões · emissão');
    await expect(modal.getByTestId(`add-exp-${MOCK_EXPLORATION.id}`).locator('input')).toBeChecked();
    await expect(modal.getByTestId('add-preview')).toContainText('1 new exploration, from 1 context');

    await modal.getByTestId('add-mode-frozen').check();
    await modal.getByTestId('add-submit').click();
    await expect(modal).toHaveCount(0);
    expect(added).toEqual([
      { investigation_id: 'inv-1', kind: 'exploration', exploration_id: MOCK_EXPLORATION.id, mode: 'frozen' },
    ]);
  });

  test('workspace unifies two sources by CPF: one node, two rings, a tab per source', async ({
    authenticatedPage: page,
  }) => {
    const ctx = (id: string, title: string, nodeType: string, prop: string) => ({
      ...MOCK_CONTEXT,
      id,
      title,
      identity_keys: [
        { node_type: nodeType, entity: 'Pessoa', source: { kind: 'prop', name: prop }, normalize: 'cpf_cnpj' },
      ],
    });
    const source = (id: string, contextId: string, title: string, position: number) => ({
      id,
      kind: 'exploration',
      position,
      title_snapshot: title,
      accessible: true,
      exploration_id: `exp-${id}`,
      context_id: contextId,
      mode: 'live',
    });
    const payload = (contextId: string, nodes: any[], edges: any[]) => ({
      exploration: { id: 'x', title: 'x', graph_context_id: contextId, owner_email: 'e2e@test.com', state: {} },
      snapshot: { nodes, edges },
    });
    await seedContexts(page, [ctx('ctx-pix', 'Pix', 'Titular', 'cpf'), ctx('ctx-cad', 'Cadastro', 'Cliente', 'doc')]);
    await seedInvestigations(page, [CASE], {
      'inv-1': [source('src-1', 'ctx-pix', 'Pix · transfers', 0), source('src-2', 'ctx-cad', 'Cadastro · clients', 1), RESTRICTED_SOURCE],
    });
    const snapshots: Record<string, unknown> = {
      'src-1': payload(
        'ctx-pix',
        [
          { id: 'p1', type: 'Titular', properties: { cpf: '123.456.789-01' } },
          { id: 'a1', type: 'Conta', properties: {} },
          { id: 'a2', type: 'Conta', properties: {} },
        ],
        [
          { id: 'e1', source: 'p1', target: 'a1', type: 'OWNS', properties: {} },
          { id: 'e2', source: 'a1', target: 'a2', type: 'PIX', properties: {} },
        ],
      ),
      'src-2': payload(
        'ctx-cad',
        [
          { id: 'c9', type: 'Cliente', properties: { doc: '12345678901' } },
          { id: 'd1', type: 'Device', properties: {} },
        ],
        [{ id: 'e1', source: 'c9', target: 'd1', type: 'USES', properties: {} }],
      ),
    };
    await page.route('**/graphlagoon/api/investigations/inv-1/sources/*/snapshot', (route) => {
      const sid = route.request().url().split('/sources/')[1].split('/')[0];
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshots[sid]) });
    });

    await page.goto('/investigations/inv-1');
    const status = page.getByTestId('workspace-status');
    await expect(status).toContainText('4 nodes', { timeout: 15_000 });
    await expect(status).toContainText('3 edges');
    await expect(status).toContainText('2 sources + 1 restricted');
    await expect(page.getByTestId('unification-summary')).toContainText('1 entity merged by identity key: 1 by Pessoa');
    await expect(page.getByTestId('tab-src-r')).toContainText('restricted');

    const rings = (id: string) =>
      page.evaluate((nodeId) => (window as any).__GRAPH_NODE_VISUAL_STATE__?.(nodeId)?.rings ?? null, id);
    await expect.poll(() => rings('Pessoa:12345678901'), { timeout: 15_000 }).toHaveLength(2);
    expect(await rings('a1@ctx-pix')).toHaveLength(1);

    await page.getByTestId('tab-src-2').click();
    await expect(status).toContainText('2 nodes');
    await expect(status).toContainText('1 edges');
    await page.getByTestId('tab-unified').click();
    await expect(status).toContainText('4 nodes');
  });
});
