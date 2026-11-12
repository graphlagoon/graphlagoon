import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT, MOCK_EXPLORATION, MOCK_GRAPH_RESPONSE } from '../fixtures/mock-data';
import { seedContexts, seedExplorations, seedGraphResponse } from '../helpers/api-mocks';

/**
 * "Your data" on an exploration (BYOD-2): enrich the nodes on the canvas from a CSV and
 * draw a node by hand. Both go to the exploration's layer (PUT …/overlay), never to the
 * context or the snapshot.
 */
/** The mock graph with its fields as node properties, as the API sends them. */
const WITH_PROPS = {
  ...MOCK_GRAPH_RESPONSE,
  nodes: MOCK_GRAPH_RESPONSE.nodes.map(({ node_id, node_type, ...properties }) => ({ node_id, node_type, properties })),
};

test.describe('Your data on an exploration', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedGraphResponse(page, MOCK_GRAPH_RESPONSE);
  });

  test('a CSV enriches the canvas and a drawn node joins the layer', async ({ authenticatedPage: page }) => {
    await seedExplorations(page, [MOCK_EXPLORATION]);
    const puts: any[] = [];
    await page.route(`**/graphlagoon/api/explorations/${MOCK_EXPLORATION.id}/overlay`, (route) => {
      if (route.request().method() === 'PUT') {
        puts.push(route.request().postDataJSON());
        route.fulfill({ status: 200, json: { ...MOCK_EXPLORATION, state: { ...MOCK_EXPLORATION.state, has_overlay: true } } });
      } else {
        route.fulfill({ status: 404, json: { detail: 'This exploration has no layer of its own' } });
      }
    });

    await page.goto(`/graph/${MOCK_CONTEXT.id}?exploration=${MOCK_EXPLORATION.id}`);
    await expect(page.getByTestId('toolbar-exploration-name')).toContainText('Test Exploration', { timeout: 15_000 });

    await page.getByTestId('toolbar-your-data').click();
    await expect(page.getByTestId('your-data-modal')).toBeVisible();
    await expect(page.getByTestId('your-data-guide')).toHaveAttribute('href', /\/guide\/bring-your-own-data$/);
    await page.getByTestId('your-data-enrich-file').setInputFiles({
      name: 'risk.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('id,risk\nn1,high\nn4,low\nzz,none\n'),
    });
    // The join is found from the ids on the canvas; two rows match, and the line says how.
    await expect(page.getByTestId('your-data-enrich-preview')).toContainText('column id = the node id');
    await expect(page.getByTestId('your-data-enrich-sample')).toContainText('high');
    await page.getByTestId('your-data-enrich-adjust').click();
    await expect(page.getByTestId('wizard-key-column')).toHaveValue('id');
    // Every setting explains itself in a popover.
    await page.getByTestId('help-enrich-normalize').click();
    await expect(page.getByTestId('help-enrich-normalize-text')).toContainText('Digits only');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('your-data-enrich-preview')).toContainText(/2 of \d+ nodes/);
    await page.getByTestId('your-data-enrich-apply').click();

    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0].enrichments[0]).toMatchObject({
      filename: 'risk.csv',
      spec: { key_column: 'id', columns: ['risk'], target: 'nodes' },
      rows: { n1: [{ risk: 'high' }], n4: [{ risk: 'low' }], zz: [{ risk: 'none' }] },
    });
    await expect(page.getByTestId('your-data-layer-enrichment')).toContainText('risk');

    // Draw a node by hand: the dialog writes the same layer.
    await page.getByTestId('your-data-tab-draw').click();
    await page.getByTestId('your-data-draw-node').click();
    await expect(page.getByTestId('sketch-dialog')).toBeVisible();
    await page.getByTestId('sketch-type').fill('Phone');
    await page.getByTestId('sketch-label').fill('+1 415 555 0100');
    await page.getByTestId('sketch-props').fill('carrier = Acme');
    await page.getByTestId('sketch-submit').click();

    await expect.poll(() => puts.length).toBe(2);
    expect(puts[1].nodes[0]).toMatchObject({ type: 'Phone', properties: { label: '+1 415 555 0100', carrier: 'Acme' } });
    expect(puts[1].nodes[0].id).toMatch(/^sketch:/);
    expect(puts[1].enrichments).toHaveLength(1);
  });

  test('pasted rows join by a property, ignoring case, without touching a setting', async ({ authenticatedPage: page }) => {
    await seedGraphResponse(page, WITH_PROPS);
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('toolbar-your-data').click();
    await page.getByTestId('your-data-enrich-paste-toggle').click();
    await page.getByTestId('your-data-enrich-paste').fill('company\tsector\nACME CORP\tRetail\nglobex\tBanking\n');
    await page.getByTestId('your-data-enrich-paste-use').click();
    const preview = page.getByTestId('your-data-enrich-preview');
    await expect(preview).toContainText('2 of 2 Company nodes');
    await expect(preview).toContainText('column company = property name, lowercase');
    await expect(page.getByTestId('your-data-enrich-apply')).toBeEnabled();
    await expect(page.getByTestId('your-data-enrich-apply')).toBeInViewport();
  });

  test('an AI fills in data for the nodes, and its CSV joins by node_id', async ({ authenticatedPage: page }) => {
    await seedGraphResponse(page, WITH_PROPS);
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('toolbar-your-data').click();
    await page.getByTestId('your-data-enrich-ask-fill').click();
    await expect(page.getByTestId('enrichment-skill-notice')).toContainText('ids and names of 5 nodes');
    await expect(page.getByTestId('enrichment-skill-notice')).toContainText('outside Graph Lagoon');
    await expect(page.getByTestId('enrichment-skill-text')).toContainText('n4,Company,Acme Corp');
    await page.getByTestId('enrichment-skill-answer').fill('```csv\nnode_id,sector\nn4,Retail\nn5,Banking\n```');
    await page.getByTestId('enrichment-skill-use').click();
    await expect(page.getByTestId('enrichment-skill-modal')).toBeHidden();
    await expect(page.getByTestId('your-data-enrich-preview')).toContainText('2 of 2 Company nodes');
    await expect(page.getByTestId('your-data-enrich-preview')).toContainText('column node_id = the node id');
  });

  test('rows that meet nothing say so and offer to clean the file with an AI', async ({ authenticatedPage: page }) => {
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('toolbar-your-data').click();
    await page.getByTestId('your-data-enrich-file').setInputFiles({
      name: 'messy.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Customer report\nwho;amount\nAlice Smith (ID 7);1.234,56\n'),
    });
    await expect(page.getByTestId('your-data-enrich-nomatch')).toBeVisible();
    await expect(page.getByTestId('your-data-enrich-apply')).toBeDisabled();
    await page.getByTestId('your-data-enrich-ask-clean').click();
    await expect(page.getByTestId('enrichment-skill-text')).toContainText('Alice Smith (ID 7);1.234,56');
    await expect(page.getByTestId('enrichment-skill-text')).toContainText('- node ids: `n1`');
    await expect(page.getByTestId('enrichment-skill-notice')).toContainText('first 3 lines of the file');
  });

  test('an exploration shared read-only offers no "Your data"', async ({ authenticatedPage: page }) => {
    const shared = { ...MOCK_EXPLORATION, id: 'exp-shared-ro', owner_email: 'someone@test.com', has_write_access: false };
    await seedExplorations(page, [shared]);
    await page.goto(`/graph/${MOCK_CONTEXT.id}?exploration=${shared.id}`);
    await expect(page.getByTestId('toolbar-exploration-name')).toContainText('Test Exploration', { timeout: 15_000 });
    await expect(page.getByTestId('toolbar-your-data')).toHaveCount(0);
  });
});
