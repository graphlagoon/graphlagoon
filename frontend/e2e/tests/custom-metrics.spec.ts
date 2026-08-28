/**
 * Custom (writer-authored) metrics — the only place the real sandbox worker
 * runs in Chromium: scope hardening, evaluation, and the value flow into the
 * Metrics panel, the Data Table and node labels.
 */
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts } from '../helpers/api-mocks';

const DOMAIN_METRIC = {
  auto_run: true,
  id: 'cm-domain',
  name: 'Email domain',
  target: 'node',
  value_type: 'string',
  code: "const m=/@([^@\\s]+)$/.exec(String(item.properties.email??'')); return m?m[1].toLowerCase():item.type.toLowerCase()+'.local';",
  description: 'Domain part of the e-mail (falls back to <type>.local)',
};

const NEIGHBOUR_DEGREE_METRIC = {
  auto_run: true,
  id: 'cm-neighbour-degree',
  name: 'Neighbour mean degree',
  target: 'node',
  value_type: 'number',
  code: 'const ns=ctx.neighbors(item.id); return ns.length?ns.reduce((s,n)=>s+ctx.degreeOf(n),0)/ns.length:0;',
};

/** A definition that tries every escape hatch; each must throw inside the worker. */
const HOSTILE_METRIC = {
  auto_run: true,
  id: 'cm-hostile',
  name: 'Hostile',
  target: 'node',
  value_type: 'string',
  code: [
    'const tried = [];',
    "try { fetch('https://example.com'); tried.push('fetch-ok'); } catch (e) { tried.push('fetch:' + e.name); }",
    "try { importScripts('https://example.com/x.js'); tried.push('import-ok'); } catch (e) { tried.push('import:' + e.name); }",
    "try { new Worker('x'); tried.push('worker-ok'); } catch (e) { tried.push('worker:' + e.name); }",
    "try { self.postMessage({ type: 'RUN_COMPLETE' }); tried.push('post-ok'); } catch (e) { tried.push('post:' + e.name); }",
    "try { indexedDB.open('x'); tried.push('idb-ok'); } catch (e) { tried.push('idb:' + e.name); }",
    "return tried.join(' ');",
  ].join('\n'),
};

/** Not flagged auto_run: must NOT evaluate on load, only after Recompute. */
const MANUAL_METRIC = {
  id: 'cm-manual',
  name: 'Manual only',
  target: 'node',
  value_type: 'number',
  code: 'return ctx.degree * 10;',
};

const WRITER_CONTEXT = {
  ...MOCK_CONTEXT,
  id: 'ctx-custom-metrics',
  metric_definitions: [DOMAIN_METRIC, NEIGHBOUR_DEGREE_METRIC, HOSTILE_METRIC, MANUAL_METRIC],
};

const READER_CONTEXT = {
  ...MOCK_CONTEXT,
  id: 'ctx-custom-metrics-reader',
  has_write_access: false,
  // The backend strips definitions for readers; the mock mirrors that contract.
  metric_definitions: [],
};

test.describe('Custom metrics', () => {
  test('writer: definitions compute in the sandbox, feed the table, and the hostile one is contained', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [WRITER_CONTEXT]);
    await page.goto(`/graph/${WRITER_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    await page.getByTitle('Metrics').click();
    await page.getByTestId('metrics-tab-custom').click();
    await expect(page.getByTestId('custom-metrics-tab')).toBeVisible();
    await expect(page.getByTestId('custom-metrics-readonly')).toHaveCount(0);

    // All three evaluate — the hostile one too, its escapes turned into item values.
    await expect(page.getByTestId(`custom-metric-status-${DOMAIN_METRIC.id}`)).toContainText('done', { timeout: 15_000 });
    await expect(page.getByTestId(`custom-metric-status-${NEIGHBOUR_DEGREE_METRIC.id}`)).toContainText('done', { timeout: 15_000 });
    await expect(page.getByTestId(`custom-metric-status-${HOSTILE_METRIC.id}`)).toContainText('done', { timeout: 15_000 });

    // The manual one waited for a click.
    await expect(page.getByTestId(`custom-metric-status-${MANUAL_METRIC.id}`)).toContainText('not computed');
    await page.getByTestId(`custom-metric-recompute-${MANUAL_METRIC.id}`).click();
    await expect(page.getByTestId(`custom-metric-status-${MANUAL_METRIC.id}`)).toContainText('done', { timeout: 15_000 });

    // Both custom columns land in the Data Table with their value types.
    await page.getByTestId(`metric-table-toggle-custom:${DOMAIN_METRIC.id}`).check();
    await page.getByTestId(`metric-table-toggle-custom:${NEIGHBOUR_DEGREE_METRIC.id}`).check();
    await page.getByTestId(`metric-table-toggle-custom:${HOSTILE_METRIC.id}`).check();
    await page.getByTitle('Data Table').click();
    const drawer = page.locator('.data-table-drawer');
    await expect(drawer.locator('th', { hasText: 'Email domain' })).toBeVisible();
    await expect(drawer.locator('th', { hasText: 'Neighbour mean degree' })).toBeVisible();
    await expect(drawer.locator('th', { hasText: 'Hostile' })).toBeVisible();
    // The mock graph has no e-mail column, so every node falls back to <type>.local
    await expect(drawer.locator('td', { hasText: '.local' }).first()).toBeVisible();

    // Every escape hatch threw inside the worker: no "-ok" marker anywhere.
    const hostileCell = drawer.locator('td', { hasText: 'fetch:' }).first();
    await expect(hostileCell).toBeVisible();
    const text = await hostileCell.textContent();
    expect(text).not.toContain('-ok');
    expect(text).toContain('fetch:');
    expect(text).toContain('import:');
    expect(text).toContain('worker:');
    expect(text).toContain('post:');
    expect(text).toContain('idb:');
  });

  test('writer: the editor tests a draft against the current graph and saves it', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [{ ...WRITER_CONTEXT, metric_definitions: [] }]);
    // Echo the PUT so the store's resync sees a plausible context.
    await page.route(`**/graphlagoon/api/graph-contexts/${WRITER_CONTEXT.id}`, async (route) => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...WRITER_CONTEXT, ...body }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...WRITER_CONTEXT, metric_definitions: [] }),
        });
      }
    });
    await page.goto(`/graph/${WRITER_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    await page.getByTitle('Metrics').click();
    await page.getByTestId('metrics-tab-custom').click();
    await page.getByTestId('custom-metric-new').click();
    await expect(page.getByTestId('custom-metric-editor-modal')).toBeVisible();

    await page.getByTestId('custom-metric-name').fill('Is hub');
    await page.getByTestId('custom-metric-value-type').selectOption('boolean');
    await page.getByTestId('custom-metric-auto-run').check();
    // CodeMirror: select everything in the editor and type the body.
    const editor = page.getByTestId('custom-metric-code').locator('.cm-content');
    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('return ctx.degree > ctx.graph.meanDegree;');

    await page.getByTestId('custom-metric-test').click();
    await expect(page.getByTestId('custom-metric-test-results')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('custom-metric-test-row').first()).toBeVisible();
    await expect(page.getByTestId('custom-metric-test-error')).toHaveCount(0);

    const put = page.waitForRequest((req) =>
      req.url().endsWith(`/graph-contexts/${WRITER_CONTEXT.id}`) && req.method() === 'PUT',
    );
    await page.getByTestId('custom-metric-save').click();
    const req = await put;
    const sent = req.postDataJSON();
    expect(sent.metric_definitions).toHaveLength(1);
    expect(sent.metric_definitions[0]).toMatchObject({ name: 'Is hub', target: 'node', value_type: 'boolean', auto_run: true });

    await expect(page.getByTestId('custom-metric-editor-modal')).toHaveCount(0);
    const status = page.getByTestId(`custom-metric-status-${sent.metric_definitions[0].id}`);
    await expect(status).toContainText('done', { timeout: 15_000 });
  });

  test('reader: no definitions, the read-only note, and no worker is spawned', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [READER_CONTEXT]);
    const workerUrls: string[] = [];
    page.on('worker', (w) => workerUrls.push(w.url()));

    await page.goto(`/graph/${READER_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });

    await page.getByTitle('Metrics').click();
    await page.getByTestId('metrics-tab-custom').click();
    await expect(page.getByTestId('custom-metrics-readonly')).toBeVisible();
    await expect(page.getByTestId('custom-metric-new')).toHaveCount(0);

    // Give any (wrong) recompute a chance to fire before asserting.
    await page.waitForTimeout(1500);
    expect(workerUrls.filter((u) => u.includes('customMetricWorker'))).toEqual([]);
  });
});
