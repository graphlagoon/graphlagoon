/**
 * Live refresh: what an agent does through MCP shows up on the open page within
 * seconds, without a reload (GET /api/live polled while the tab is visible).
 */
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT, MOCK_EXPLORATION } from '../fixtures/mock-data';
import { seedContexts, seedExplorations, seedInvestigations } from '../helpers/api-mocks';

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const node = (id: string, props: Record<string, unknown> = {}) => ({ id, type: 'Conta', properties: { titular: id, ...props } });

test.beforeEach(async ({ authenticatedPage: page }) => {
  await page.addInitScript(() => {
    (window as any).__GRAPH_LAGOON_CONFIG__ = { ...(window as any).__GRAPH_LAGOON_CONFIG__, live_refresh_seconds: 1 };
  });
});

test('an agent edit lands in the open exploration in place, with a toast', async ({ authenticatedPage: page }) => {
  await seedContexts(page, [MOCK_CONTEXT]);
  const exp = { ...MOCK_EXPLORATION, id: 'exp-live', state: { ...MOCK_EXPLORATION.state, has_snapshot: true, revision: 0 } };
  await seedExplorations(page, [exp]);
  let revision = 0;
  const lastChange = { by: 'e2e@test.com', author_kind: 'agent', tool: 'edit_exploration', summary: { added_nodes: 1, removed_nodes: 1 } };
  await page.route('**/graphlagoon/api/explorations/exp-live', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill(json({ ...exp, state: { ...exp.state, revision, last_change: revision ? lastChange : null } }))
      : route.fallback(),
  );
  await page.route('**/graphlagoon/api/explorations/exp-live/snapshot', (route) =>
    route.fulfill(json(revision
      ? { nodes: [node('a', { risco: 'alto' }), node('c')], edges: [{ id: 'e2', source: 'a', target: 'c', type: 'PIX', properties: {} }] }
      : { nodes: [node('a'), node('b')], edges: [{ id: 'e1', source: 'a', target: 'b', type: 'PIX', properties: {} }] })),
  );
  const polls: string[] = [];
  await page.route(/\/graphlagoon\/api\/live(\?.*)?$/, (route) => {
    polls.push(route.request().url());
    return route.fulfill(json({ refresh_seconds: 1, explorations: { 'exp-live': { revision, last_change: null } }, cases: {} }));
  });

  await page.goto(`/graph/${MOCK_CONTEXT.id}?exploration=exp-live`);
  const status = page.getByTestId('graph-status-bar');
  await expect(status).toContainText('2 nodes', { timeout: 15_000 });
  await expect.poll(() => polls.length, { timeout: 5_000 }).toBeGreaterThan(0);
  expect(polls[0]).toContain('exploration=exp-live');

  revision = 1; // the agent saved: b removed, c added, a enriched
  await expect(page.locator('.toast')).toContainText('An agent', { timeout: 5_000 });
  await expect(page.locator('.toast')).toContainText('+1 node, −1 node');
  await expect(status).toContainText('2 nodes');
  await expect(status).toContainText('1 edges');
  expect(page.url()).toContain('exploration=exp-live'); // no navigation
  await expect(page.getByTestId('toolbar-exploration-dirty')).toHaveCount(0);
});

test('the case page shows what an agent added and the new graph of its exploration', async ({ authenticatedPage: page }) => {
  const now = new Date().toISOString();
  const CASE = {
    id: 'inv-l', title: 'Golpe Pix', status: 'analysis', case_type: 'general', fields: {}, tags: [], owner_email: 'e2e@test.com',
    settings: {}, state: {}, shared_with: [], has_write_access: true, can_manage: true, created_at: now, updated_at: now, deadline: null,
  };
  const ITEM = {
    id: 'src-1', kind: 'graph', subkind: 'exploration_ref', title: 'Contas', tags: [], status: 'confirmed', author_kind: 'human',
    author_email: 'e2e@test.com', provenance: {}, exploration_id: 'exp-1', context_id: 'ctx-l', current_version: 0, position: 0,
    accessible: true, pinned: [], created_at: now,
  };
  const snapshots: Record<string, any> = {
    'src-1': { exploration: { id: 'exp-1', title: 'Contas', state: { revision: 1 } }, snapshot: { nodes: [node('a'), node('b')], edges: [] } },
  };
  await seedContexts(page, [{ ...MOCK_CONTEXT, id: 'ctx-l', title: 'Pix' }]);
  const { events, material } = await seedInvestigations(page, [CASE], { 'inv-l': [ITEM] }, [], snapshots);
  let revision = 1;
  await page.route(/\/graphlagoon\/api\/live(\?.*)?$/, (route) => {
    const list = events.get('inv-l') ?? [];
    return route.fulfill(json({
      refresh_seconds: 1,
      explorations: {},
      cases: { 'inv-l': { last_event_id: list.at(-1)?.id ?? null, last_event_at: null, explorations: { 'exp-1': revision } } },
    }));
  });

  await page.goto('/investigations/inv-l');
  await expect(page.getByTestId('workspace-status')).toContainText('2 nodes', { timeout: 15_000 });

  // The agent adds a note and grows the exploration (journalled as an agent).
  material.get('inv-l')!.push({
    ...ITEM, id: 'note-1', kind: 'note', subkind: 'free', title: 'Nota do agente', exploration_id: null, context_id: null,
    author_kind: 'agent', current_version: 1,
  });
  snapshots['src-1'] = { exploration: { id: 'exp-1', title: 'Contas', state: { revision: 2 } }, snapshot: { nodes: [node('a'), node('b'), node('c')], edges: [] } };
  revision = 2;
  const list = events.get('inv-l') ?? [];
  list.push({ id: 'ev-agent', at: new Date().toISOString(), actor_email: 'e2e@test.com', actor_kind: 'agent', agent_name: 'claude', kind: 'exploration.changed', payload: { title: 'Contas', added_nodes: 1 } });
  events.set('inv-l', list);

  await expect(page.getByTestId('workspace-status')).toContainText('3 nodes', { timeout: 6_000 });
  await expect(page.getByTestId('case-items-panel')).toContainText('Nota do agente');
  await expect(page.locator('.toast')).toContainText('claude updated the case');
});
