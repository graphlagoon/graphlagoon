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
});
