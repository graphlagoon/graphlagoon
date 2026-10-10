import { readFileSync } from 'fs';
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT, MOCK_EXPLORATION } from '../fixtures/mock-data';
import { seedContexts, seedExplorations, seedInvestigations } from '../helpers/api-mocks';

const now = new Date().toISOString();
const CASE = {
  id: 'inv-1',
  title: 'Golpe Pix · falsa central',
  status: 'analysis',
  kind_preset: 'pix_med',
  tags: ['MED'],
  owner_email: 'e2e@test.com',
  assignee_email: 'ana@test.com',
  settings: {},
  state: {},
  shared_with: [],
  has_write_access: true,
  can_manage: true,
  created_at: now,
  updated_at: now,
  item_count: 2,
  suggested_count: 1,
  deadline: { phase: 'analysis', due_at: now, days_left: 6 },
};
const item = (id: string, contextId: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'graph', subkind: 'exploration_ref', title, tags: [], status: 'confirmed', author_kind: 'human',
  author_email: 'e2e@test.com', provenance: {}, exploration_id: `exp-${id}`, context_id: contextId, current_version: 0,
  position: 0, accessible: true, pinned: [], created_at: now, ...extra,
});
const RESTRICTED = item('src-r', 'ctx-r', 'Cartões suspeitos', { accessible: false, author_email: 'mendes@test.com' });
const payload = (nodes: any[], edges: any[]) => ({ exploration: { id: 'x', title: 'x', state: {} }, snapshot: { nodes, edges } });

test.describe('Investigations', () => {
  test('the queue lists cases from the top navigation', async ({ authenticatedPage: page }) => {
    await seedInvestigations(page, [CASE]);
    await page.goto('/contexts');
    await page.getByTestId('nav-investigations').click();

    const row = page.getByTestId('investigation-row-inv-1');
    await expect(row).toContainText('Golpe Pix · falsa central');
    await expect(row).toContainText('In analysis');
    await expect(row).toContainText('Pix with MED');
    await expect(row).toContainText('ana@test.com');
    await expect(row).toContainText('2 items');
    await expect(row).toContainText('1 suggested');
    await expect(row).toContainText('analysis · 6 d left');
    await expect(page.getByTestId('counter-urgent')).toContainText('1');
    await expect(page.getByTestId('counter-suggested')).toContainText('1');
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

  test('F1: create → rename → share → add → remove item → analysis → decide → reopen → delete, on the case screen', async ({
    authenticatedPage: page,
  }) => {
    const exploration = { ...MOCK_EXPLORATION, title: 'Pix transfers', node_count: 3, updated_at: now };
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedExplorations(page, [exploration]);
    await seedInvestigations(page, [], {}, [exploration], {
      [exploration.id]: payload(
        [
          { id: 'p1', type: 'Titular', properties: { nome: 'Ana Silva', cpf: '12345678901', cpf_mascarado: '***.456.789-**' } },
          { id: 'a1', type: 'Conta', properties: {} },
          { id: 'a2', type: 'Conta', properties: {} },
        ],
        [
          { id: 'e1', source: 'p1', target: 'a1', type: 'OWNS', properties: {} },
          { id: 'e2', source: 'a1', target: 'a2', type: 'PIX', properties: {} },
        ],
      ),
    });

    // create
    await page.goto('/investigations');
    await page.getByTestId('new-investigation-btn').click();
    await page.getByTestId('new-investigation-title').fill('Golpe Pix');
    await page.getByTestId('new-investigation-preset').selectOption('pix_med');
    await page.getByTestId('new-investigation-submit').click();
    await page.waitForURL('**/investigations/inv-new');
    await expect(page.getByTestId('canvas-empty')).toContainText('Nothing on the canvas yet');

    // rename inline
    await page.getByTestId('investigation-title').click();
    await page.getByTestId('case-title-input').fill('Golpe Pix · falsa central');
    await page.getByTestId('case-title-input').press('Enter');
    await expect(page.getByTestId('investigation-title')).toHaveText('Golpe Pix · falsa central');

    // share with a named person
    await page.getByTestId('case-share').click();
    await page.getByTestId('share-email').fill('ana@test.com');
    await page.getByTestId('share-permission').selectOption('editor');
    await page.getByTestId('share-submit').click();
    await expect(page.getByTestId('share-row-ana@test.com')).toContainText('can write');
    await page.getByTestId('share-dialog').getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('case-share')).toContainText('Share · 1');

    // add from "my recent explorations": a live reference item
    await page.getByTestId('items-empty-add').click();
    const modal = page.getByTestId('add-to-investigation-modal');
    await expect(modal.getByTestId('add-scope-mine')).toHaveClass(/on/);
    await expect(modal.getByTestId(`add-exp-${exploration.id}`)).toContainText('3 nodes');
    await modal.getByTestId(`add-exp-${exploration.id}`).locator('input').check();
    await modal.getByTestId('add-submit').click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId('workspace-status')).toContainText('3 nodes', { timeout: 15_000 });
    await expect(page.getByTestId('item-item-1')).toContainText('Pix transfers');
    await expect(page.getByTestId('item-item-1')).toContainText('G1');

    // remove the item
    await page.getByTestId('item-remove-item-1').click();
    await expect(page.getByTestId('items-empty')).toBeVisible();
    await expect(page.getByTestId('workspace-status')).toContainText('0 sources');

    // status: open → analysis (the select only offers the allowed transitions)
    const status = page.getByTestId('case-status');
    await expect(status.locator('option')).toHaveText(['Open', 'In analysis', 'Archived']);
    await status.selectOption('analysis');
    await expect(page.getByTestId('workspace-deadline')).toContainText('analysis · 90 d left');

    // decide
    await page.getByTestId('case-decide').click();
    await page.getByTestId('decision-action-dict').check();
    await page.getByTestId('decision-rationale').fill('Conta de passagem.');
    await page.getByTestId('decision-record').click();
    await expect(page.getByTestId('decide-dialog')).toHaveCount(0);
    await expect(status).toHaveValue('decided');
    await expect(status).toBeDisabled();
    await expect(page.getByTestId('case-decide')).toHaveCount(0);

    // reopen (human only)
    await page.getByTestId('case-menu').click();
    await page.getByTestId('case-reopen').click();
    await expect(status).toHaveValue('analysis');
    await expect(page.getByTestId('case-decide')).toBeVisible();
    await page.getByTestId('journal-toggle').click();
    await expect(page.getByTestId('journal')).toContainText('reopened the case');
    await expect(page.getByTestId('journal')).toContainText('shared with ana@test.com (editor)');

    // delete with confirmation → back to the queue
    await page.getByTestId('case-menu').click();
    await page.getByTestId('case-delete').click();
    await page.getByTestId('case-delete-yes').click();
    await page.waitForURL('**/investigations');
    await expect(page.getByTestId('investigations-empty')).toBeVisible();
  });

  test('adds an exploration to a case as a live reference, with the restricted item as a placeholder', async ({
    authenticatedPage: page,
  }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedExplorations(page, [MOCK_EXPLORATION]);
    const { added } = await seedInvestigations(page, [CASE], { 'inv-1': [RESTRICTED] });

    await page.goto('/explorations');
    await page.getByTestId(`exploration-add-to-investigation-${MOCK_EXPLORATION.id}`).click();
    const modal = page.getByTestId('add-to-investigation-modal');
    await modal.getByTestId('add-case-select').selectOption('inv-1');

    await expect(modal.getByTestId('add-restricted-source')).toContainText("don't have access");
    await expect(modal.getByTestId('add-restricted-source')).toContainText('Cartões suspeitos');
    await expect(modal.getByTestId(`add-exp-${MOCK_EXPLORATION.id}`).locator('input')).toBeChecked();
    await expect(modal.getByTestId('add-preview')).toContainText('1 new exploration, from 1 context');

    await modal.getByTestId('add-submit').click();
    await expect(modal).toHaveCount(0);
    expect(added).toEqual([{ investigation_id: 'inv-1', kind: 'graph', subkind: 'exploration_ref', exploration_id: MOCK_EXPLORATION.id }]);
  });

  test('the canvas unifies two items by CPF: one node, two rings; "on canvas" removes an item without a reload', async ({
    authenticatedPage: page,
  }) => {
    const ctx = (id: string, title: string, nodeType: string, prop: string) => ({
      ...MOCK_CONTEXT,
      id,
      title,
      identity_keys: [{ node_type: nodeType, entity: 'Pessoa', source: { kind: 'prop', name: prop }, normalize: 'cpf_cnpj' }],
    });
    await seedContexts(page, [ctx('ctx-pix', 'Pix', 'Titular', 'cpf'), ctx('ctx-cad', 'Cadastro', 'Cliente', 'doc')]);
    await seedInvestigations(
      page,
      [CASE],
      { 'inv-1': [item('src-1', 'ctx-pix', 'Pix · transfers'), item('src-2', 'ctx-cad', 'Cadastro · clients', { position: 1 }), RESTRICTED] },
      [],
      {
        'src-1': payload(
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
          [
            { id: 'c9', type: 'Cliente', properties: { doc: '12345678901' } },
            { id: 'd1', type: 'Device', properties: {} },
          ],
          [{ id: 'e1', source: 'c9', target: 'd1', type: 'USES', properties: {} }],
        ),
      },
    );

    await page.goto('/investigations/inv-1');
    const status = page.getByTestId('workspace-status');
    await expect(status).toContainText('4 nodes', { timeout: 15_000 });
    await expect(status).toContainText('3 edges');
    await expect(status).toContainText('2 sources + 1 restricted');
    await expect(page.getByTestId('unification-summary')).toContainText('1 entities merged by identity key: 1 by Pessoa');
    await expect(page.getByTestId('item-src-r')).toBeVisible();

    const rings = (id: string) =>
      page.evaluate((nodeId) => (window as any).__GRAPH_NODE_VISUAL_STATE__?.(nodeId)?.rings ?? null, id);
    await expect.poll(() => rings('Pessoa:12345678901'), { timeout: 15_000 }).toHaveLength(2);
    expect(await rings('a1@ctx-pix')).toHaveLength(1);

    await page.getByTestId('item-canvas-src-2').uncheck();
    await expect(status).toContainText('3 nodes');
    await expect(status).toContainText('2 edges');
    await page.getByTestId('item-canvas-src-2').check();
    await expect(status).toContainText('4 nodes');
  });

  test('material: a brief, a markdown document pinned as evidence, and an agent suggestion confirmed in place', async ({
    authenticatedPage: page,
  }) => {
    const suggestion = item('item-agent', 'ctx', 'Rastro do dinheiro', {
      kind: 'document', subkind: 'markdown', status: 'suggested', author_kind: 'agent', current_version: 1, context_id: null,
      latest: { version: 1, sha256: 'a'.repeat(64), size_bytes: 20, content_type: 'text/markdown', has_text: true, created_by: 'e2e@test.com', author_kind: 'agent' },
    });
    await seedInvestigations(page, [{ ...CASE, kind_preset: 'credito', deadline: null }], { 'inv-1': [suggestion] });
    await page.goto('/investigations/inv-1');
    const panel = page.getByTestId('case-items-panel');
    await expect(panel.getByTestId('suggested-count')).toContainText('1 suggested');
    await expect(page.getByTestId('item-author-item-agent')).toContainText('agent');
    await page.getByTestId('item-confirm-item-agent').click();
    await expect(panel.getByTestId('suggested-count')).toHaveCount(0);
    await expect(page.getByTestId('item-item-agent')).not.toHaveClass(/suggested/);

    await page.getByTestId('brief-edit').click();
    await page.getByTestId('brief-input').fill('# Exposição consolidada\nSeis empresas, três sócios em comum.');
    await page.getByTestId('brief-save').click();
    await expect(page.getByTestId('brief-text')).toContainText('Exposição consolidada');

    await page.getByTestId('compose-markdown').click();
    await page.getByTestId('compose-title').fill('KYC da 4471-0');
    await page.getByTestId('compose-body').fill('# KYC\nRenda declarada: 1 salário mínimo.');
    await page.getByTestId('compose-save').click();
    const doc = page.getByTestId('items-group-document').getByText('KYC da 4471-0');
    await expect(doc).toBeVisible();
    await page.getByTestId('item-pin-item-1').click();
    await expect(page.getByText(/Pinned v1 · hash/)).toBeVisible();
    await expect(page.getByTestId('item-pinned-item-1')).toContainText('v1');
    await page.getByTestId('journal-toggle').click();
    await expect(page.getByTestId('journal')).toContainText('pinned “KYC da 4471-0” v1');
    await expect(page.getByTestId('journal')).toContainText('confirmed the suggested item “Rastro do dinheiro”');
  });

  test('dossier: pinned evidence, a hypothesis with evidence for it, its status and the journal', async ({
    authenticatedPage: page,
  }) => {
    await seedInvestigations(page, [{ ...CASE, description: 'Pix de R$ 4.870 saiu da vítima' }]);
    await page.goto('/investigations/inv-1');
    await expect(page.getByTestId('investigation-title')).toBeVisible();
    // A table pinned earlier (the trace screen posts the same body).
    await page.evaluate(async () => {
      const r = await fetch('/graphlagoon/api/investigations/inv-1/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'table', subkind: 'result', title: 'Rastreio FIFO', content_json: { rows: 3 }, provenance: { tool: 'trace', params: {} } }),
      });
      const created = await r.json();
      await fetch(`/graphlagoon/api/investigations/inv-1/items/${created.id}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    });
    await page.getByTestId('dossier-link').click();

    await expect(page.getByTestId('dossier-summary')).toContainText('Pix de R$ 4.870');
    await expect(page.getByTestId('evidence-item-1')).toContainText('E1 · Rastreio FIFO');
    await page.getByTestId('hypothesis-input').fill('4471-0 é conta de passagem');
    await page.getByTestId('hypothesis-add').click();
    await expect(page.getByTestId('hypothesis-H1')).toContainText('4471-0 é conta de passagem');
    await page.getByTestId('hypothesis-link-evidence_for-H1').selectOption('item-1');
    await expect(page.getByTestId('hypothesis-evidence_for-H1')).toContainText('E1 Rastreio FIFO');
    await page.getByTestId('hypothesis-status-H1').selectOption('supported');
    await expect(page.getByTestId('dossier-indicators')).toContainText('1 supported');
    await expect(page.getByTestId('dossier-journal')).toContainText('set hypothesis → supported');
  });

  test('decision freezes the dossier; exports download', async ({ authenticatedPage: page }) => {
    await seedInvestigations(page, [{ ...CASE }]);
    await page.goto('/investigations/inv-1/dossier');
    await expect(page.getByTestId('decision-form')).toBeVisible();
    await page.getByTestId('decision-action-dict').check();
    await page.getByTestId('decision-rationale').fill('Conta de passagem (E1).');
    await page.getByTestId('decision-record').click();
    await expect(page.getByTestId('decision-outcome')).toContainText('Communicate to COAF');
    await expect(page.getByTestId('decision-hash')).toContainText('ffff…beef');
    await expect(page.getByTestId('decision-form')).toHaveCount(0);
    await expect(page.getByTestId('hypothesis-input')).toHaveCount(0);
    await expect(page.getByTestId('dossier-journal')).toContainText('decided: communicate to COAF (dict)');

    const download = page.waitForEvent('download');
    await page.getByTestId('export-siscoaf').click();
    expect((await download).suggestedFilename()).toBe('investigation-inv-1-siscoaf.json');
  });

  test('follow the money: right-click the victim, trace forward, see the exits and the Sankey', async ({
    authenticatedPage: page,
  }) => {
    const pix = JSON.parse(readFileSync(new URL('../../src/__tests__/fixtures/trace/golpe-pix.json', import.meta.url), 'utf8'));
    await seedContexts(page, [{ ...MOCK_CONTEXT, id: 'ctx-pix', title: 'Pix', edge_semantics: pix.edge_semantics }]);
    await seedInvestigations(page, [CASE], { 'inv-1': [item('src-1', 'ctx-pix', 'Pix')] }, [], {
      'src-1': payload(
        pix.nodes.map((n: any) => ({ id: n.node_id, type: n.node_type, properties: n.properties ?? {} })),
        pix.edges.map((e: any) => ({ id: e.edge_id, source: e.src, target: e.dst, type: e.relationship_type, properties: e.properties })),
      ),
    });

    await page.goto('/investigations/inv-1');
    await expect(page.getByTestId('workspace-status')).toContainText('9 nodes', { timeout: 15_000 });

    // WebGL is opaque to selectors: hover the node through the dev coords hook, then right-click.
    const canvas = page.locator('.graph3d-container canvas');
    const menu = page.getByTestId('graph-context-menu');
    await expect(async () => {
      const at = await page.evaluate(() => (window as any).__GRAPH_NODE_SCREEN_COORDS__?.('0001-9@ctx-pix'));
      const box = await canvas.boundingBox();
      expect(at && box).toBeTruthy();
      await page.mouse.move(box!.x + at.x, box!.y + at.y);
      await expect(canvas).toHaveClass(/clickable/, { timeout: 1_000 });
      await page.mouse.down({ button: 'right' });
      await page.mouse.up({ button: 'right' });
      await expect(menu).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await page.getByTestId('context-menu-action-trace-forward').click();

    const exits = page.getByTestId('trace-exits');
    await expect(exits).toContainText('Saque ATM');
    await expect(exits).toContainText('Exchange Gama');
    await expect(exits).toContainText('Bet Delta');
    await expect(page.getByTestId('trace-coverage')).toContainText('(91%)');
    await expect(page.getByTestId('trace-method')).toContainText('FIFO');
    await page.getByTestId('trace-save-evidence').click();
    await expect(page.getByText(/Evidence saved · hash/)).toBeVisible();
    await expect(page.getByTestId('workspace-status')).toContainText('8 nodes');

    await page.getByTestId('trace-view-sankey').click();
    await expect(page.getByTestId('sankey-band')).toHaveCount(7);
  });

  test('typology badges (T9): the merchant ring gets CC 4.001 III-f, confirmed as an annotation', async ({
    authenticatedPage: page,
  }) => {
    await seedContexts(page, [{ ...MOCK_CONTEXT, id: 'ctx-loj', title: 'Lojistas' }]);
    const shops = ['Loja Bom Preço ME', 'Empório Dois Irmãos', 'Casa Nova Utilid.', 'Variedades JM', 'Ótica Visão Clara', 'Pet Mundo', 'Auto Peças Rota', 'Moda Lima', 'Celular Expresso'];
    const links: [number, string][] = [[0, 'socia'], [1, 'socia'], [2, 'socia'], [3, 'socia'], [0, 'conta'], [4, 'conta'], [5, 'conta'], [6, 'conta'], [7, 'conta'], [1, 'conta'], [6, 'terminal'], [7, 'terminal'], [8, 'terminal']];
    await seedInvestigations(
      page,
      [{ ...CASE, title: 'Lojista recém-credenciado com chargebacks', kind_preset: 'lojista', deadline: null }],
      { 'inv-1': [item('src-1', 'ctx-loj', 'Lojistas · credenciamento')] },
      [],
      {
        'src-1': payload(
          [
            ...shops.map((name, i) => ({ id: `L${i + 1}`, type: 'Lojista', properties: { nome: name } })),
            { id: 'socia', type: 'Pessoa', properties: { nome: 'Sócia M. A. Souza' } },
            { id: 'conta', type: 'ContaLiquidacao', properties: { nome: 'Conta de liquidação 0099-1' } },
            { id: 'terminal', type: 'Terminal', properties: { nome: 'Terminal T-88' } },
          ],
          links.map(([i, to], k) => ({ id: `r${k}`, source: `L${i + 1}`, target: to, type: 'compartilha', properties: {} })),
        ),
      },
    );

    await page.goto('/investigations/inv-1');
    await expect(page.getByTestId('workspace-status')).toContainText('12 nodes', { timeout: 15_000 });
    await page.getByTestId('workspace-typologies-btn').click();
    const badge = page.getByTestId('typology-hub_atributo');
    await expect(badge).toContainText('CC 4.001 III-f');
    await expect(badge).toContainText('3 entities');
    await badge.click();
    await page.getByTestId('typology-bipartite').click();
    await page.getByTestId('typology-accept-hub_atributo').click();
    await expect(page.getByTestId('typology-accepted')).toBeVisible();
    await page.getByTestId('journal-toggle').click();
    await expect(page.getByTestId('journal')).toContainText('set typology CC 4.001 III-f');
  });

  test('agent tokens live in the account menu: a token scoped to one case, shown once', async ({ authenticatedPage: page }) => {
    await page.addInitScript(() => {
      (window as any).__GRAPH_LAGOON_CONFIG__ = { dev_mode: true, database_enabled: false, agents_enabled: true, permissions: ['investigation.agent'] };
    });
    await seedInvestigations(page, [CASE]);
    const tokens: any[] = [];
    await page.route('**/graphlagoon/api/agent-tokens', (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        const token = { id: `tok-${tokens.length + 1}`, owner_email: 'e2e@test.com', active: true, created_at: now, expires_at: now, ...body, token: 'glt_secret' };
        tokens.push(token);
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(token) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tokens) });
    });
    await page.goto('/investigations');
    await page.getByTestId('user-menu-btn').click();
    await page.getByTestId('nav-agents').click();
    await page.waitForURL('**/settings/agents');
    await page.getByTestId('token-scope-case').check();
    await page.getByTestId('token-cases').selectOption('inv-1');
    await page.getByTestId('token-create').click();
    await expect(page.getByTestId('token-command')).toContainText('Bearer glt_secret');
    await expect(page.getByTestId('token-tok-1')).toContainText('Golpe Pix · falsa central');
    expect(tokens[0]).toMatchObject({ scope: 'case', investigation_ids: ['inv-1'] });
  });
});
