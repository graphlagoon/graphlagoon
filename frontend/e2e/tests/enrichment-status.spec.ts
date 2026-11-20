/**
 * The enrichment chip under the graph: running, failed with the reason, Retry; and a
 * cluster program that waits for enrichment runs only once it succeeded.
 * The chip's rules are unit tested in src/utils/__tests__/enrichmentStatus.test.ts.
 */
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts, seedEnrichmentRun } from '../helpers/api-mocks';

const PROGRAM = {
  program_id: 'by-kyc',
  program_name: 'By KYC tier',
  code: `const g = {};
for (const n of nodes) { const t = n.properties?.kyc_tier; if (t) (g[t] ??= []).push(n.node_id); }
return Object.entries(g).map(([t, ids]) => ({ cluster_name: t, node_ids: ids }));`,
  wait_for_enrichment: true,
  scope: 'context',
  created_at: '2026-11-20T00:00:00Z',
  updated_at: '2026-11-20T00:00:00Z',
};

test('a failed provider enrichment is shown with its reason; Retry fixes it and the waiting program runs', async ({
  authenticatedPage: page,
}) => {
  await seedContexts(page, [{
    ...MOCK_CONTEXT,
    enrichment_tables: [{ name: 'kyc', label: 'KYC profile', provider: { name: 'kyc-demo', target: 'nodes', run: 'auto' } }],
    cluster_programs: [PROGRAM],
    default_behaviors: { ...MOCK_CONTEXT.default_behaviors, afterQueryClusterProgram: PROGRAM.program_id },
  }]);
  // The run after the query fails once; every later one answers.
  const calls = await seedEnrichmentRun(
    page,
    (id) => ({ kyc_tier: id.charCodeAt(id.length - 1) % 2 ? 'high' : 'low' }),
    [],
    { nodes: ['kyc'], fail: (_name, attempt) => attempt === 2 },
  );

  await page.goto(`/graph/${MOCK_CONTEXT.id}`);
  await expect(page.getByTestId('graph-status-bar')).toContainText('5 nodes', { timeout: 15_000 });
  const chip = page.getByTestId('enrichment-status-chip');
  await expect(chip).toContainText('Enriched · 1');

  await page.getByTestId('toolbar-query').click();
  await page.getByTestId('graph-query-mode-sql').click();
  await page.getByTestId('graph-query-sql').fill('SELECT * FROM edges');
  await page.getByTestId('graph-query-run').click();

  await expect(chip).toContainText('Enrichment: 1 failed', { timeout: 15_000 });
  await expect(page.getByTestId('graph-status-clusters')).toHaveCount(0);
  await chip.click();
  await expect(page.getByTestId('enrichment-status-detail')).toContainText('ENRICHMENT_PROVIDER_FAILED: Lakebase is down');
  await expect(page.getByTestId('enrichment-status-waiting')).toContainText('By KYC tier');

  await page.getByTestId('enrichment-status-retry').click();
  await expect.poll(() => calls.length).toBe(3);
  await expect(chip).toContainText('Enriched · 1');
  await expect(page.getByTestId('graph-status-clusters')).toHaveText('2 clusters', { timeout: 15_000 });
});
