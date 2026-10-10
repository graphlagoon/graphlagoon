import { readFileSync } from 'fs';
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

  test('case space: upload an artifact, send a new version and approve it', async ({ authenticatedPage: page }) => {
    await seedInvestigations(page, [CASE]);
    await page.goto('/investigations/inv-1');
    await page.getByTestId('tab-space').click();
    await expect(page.getByTestId('tab-space')).toContainText('0');

    const upload = async (button: string, text: string) => {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId(button).click()]);
      await chooser.setFiles({ name: 'Resumo do caso.md', mimeType: 'text/markdown', buffer: Buffer.from(text) });
    };
    await upload('artifact-upload', '# v1');
    await expect(page.getByTestId('artifact-preview')).toContainText('# v1');
    await expect(page.getByTestId('tab-space')).toContainText('1');

    await upload('artifact-new-version', '# v2');
    await expect(page.getByTestId('artifact-preview')).toContainText('# v2');
    await expect(page.getByTestId('artifact-version-1')).toContainText('draft');
    await expect(page.getByTestId('tab-space')).toContainText('1');

    await page.getByTestId('artifact-approve').click();
    await expect(page.getByTestId('artifact-version-2')).toContainText('approved');
    await expect(page.getByTestId('artifact-approve')).toHaveCount(0);
  });

  // shortcut: the agent's side (MCP upload_artifact + propose) is seeded as the API
  // state it produces instead of driving a real MCP client from Playwright; the MCP
  // path itself is covered by api/tests/test_mcp_server.py and test_cli.py.
  test('agent artifact and proposal: the person accepts on T11 and sees the artifact on T10', async ({
    authenticatedPage: page,
  }) => {
    const { artifacts } = await seedInvestigations(page, [CASE]);
    const agent = { kind: 'agent', email: 'e2e@test.com', agent_name: 'Claude Code', token_id: 'tok-1' };
    artifacts.set('inv-1', [
      {
        id: 'art-agent',
        name: 'Rastro do dinheiro.md',
        kind: 'doc',
        current_version: 1,
        download_only: false,
        versions: [
          { version: 1, sha256: 'a'.repeat(64), size_bytes: 20, content_type: 'text/markdown', status: 'draft', actor: agent, source_evidence_ids: [], created_at: now },
        ],
        contents: { 1: '# Rastro: 3 saltos' },
      },
    ]);
    const proposal = { id: 'prop-1', kind: 'role', payload: { entity: 'p:123', role: 'mule' }, rationale: 'Recebe e repassa em minutos', actor: agent, status: 'pending', created_at: now };
    const accepted: string[] = [];
    await page.route(/\/graphlagoon\/api\/investigations\/inv-1\/proposals(\/.*)?(\?.*)?$/, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/accept')) {
        accepted.push(path);
        proposal.status = 'accepted';
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...proposal, decided_by: 'e2e@test.com' }) });
      }
      const pending = proposal.status === 'pending' ? [proposal] : [];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pending) });
    });

    await page.goto('/investigations/inv-1/agents');
    const card = page.getByTestId('proposal-prop-1');
    await expect(card).toContainText('Claude Code');
    await expect(card).toContainText('Recebe e repassa em minutos');
    await card.getByTestId('proposal-accept').click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId('proposals')).toContainText('Nothing to decide');
    expect(accepted).toEqual(['/graphlagoon/api/investigations/inv-1/proposals/prop-1/accept']);

    await page.goto('/investigations/inv-1');
    await page.getByTestId('tab-space').click();
    const artifact = page.getByTestId('artifact-art-agent');
    await expect(artifact).toContainText('agent · Claude Code, for e2e@test.com');
    await artifact.click();
    await expect(page.getByTestId('artifact-preview')).toContainText('# Rastro: 3 saltos');
  });

  test('dossier (T7): evidence, a hypothesis with evidence for it, its status and the journal', async ({
    authenticatedPage: page,
  }) => {
    await seedInvestigations(page, [{ ...CASE, description: 'Pix de R$ 4.870 saiu da vítima', state: {} }]);
    await page.goto('/investigations/inv-1');
    await expect(page.getByTestId('investigation-title')).toBeVisible();
    // An evidence frozen earlier (the trace screen posts the same body).
    await page.evaluate(() =>
      fetch('/graphlagoon/api/investigations/inv-1/evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Rastreio FIFO', kind: 'table', params: { rows: 3 }, snapshot: [] }),
      }),
    );
    await page.getByTestId('dossier-link').click();

    await expect(page.getByTestId('dossier-summary')).toContainText('Pix de R$ 4.870');
    await expect(page.getByTestId('evidence-evi-1')).toContainText('E1 · Rastreio FIFO');
    await page.getByTestId('hypothesis-input').fill('4471-0 é conta de passagem');
    await page.getByTestId('hypothesis-add').click();
    await expect(page.getByTestId('hypothesis-H1')).toContainText('4471-0 é conta de passagem');
    await page.getByTestId('hypothesis-link-evidence_for-H1').selectOption('evi-1');
    await expect(page.getByTestId('hypothesis-evidence_for-H1')).toContainText('E1 Rastreio FIFO');
    await page.getByTestId('hypothesis-status-H1').selectOption('sustentada');
    await expect(page.getByTestId('dossier-indicators')).toContainText('1 supported');
    await expect(page.getByTestId('dossier-journal')).toContainText('updated hypothesis H1: open → supported');
  });

  test('follow the money: right-click the victim, trace forward, see the exits and the Sankey', async ({
    authenticatedPage: page,
  }) => {
    const pix = JSON.parse(readFileSync(new URL('../../src/__tests__/fixtures/trace/golpe-pix.json', import.meta.url), 'utf8'));
    await seedContexts(page, [{ ...MOCK_CONTEXT, id: 'ctx-pix', title: 'Pix', edge_semantics: pix.edge_semantics }]);
    await seedInvestigations(page, [CASE], {
      'inv-1': [{ id: 'src-1', kind: 'exploration', position: 0, title_snapshot: 'Pix', accessible: true, exploration_id: 'exp-1', context_id: 'ctx-pix', mode: 'frozen' }],
    });
    const snapshot = {
      exploration: { id: 'exp-1', title: 'Pix', graph_context_id: 'ctx-pix', owner_email: 'e2e@test.com', state: {} },
      snapshot: {
        nodes: pix.nodes.map((n: any) => ({ id: n.node_id, type: n.node_type, properties: n.properties ?? {} })),
        edges: pix.edges.map((e: any) => ({ id: e.edge_id, source: e.src, target: e.dst, type: e.relationship_type, properties: e.properties })),
      },
    };
    await page.route('**/graphlagoon/api/investigations/inv-1/sources/*/snapshot', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }),
    );

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
});
