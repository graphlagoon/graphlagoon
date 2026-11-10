/* Throwaway UX probe for the graph page. Not committed; deleted after the review. */
import { mkdirSync, appendFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/test-fixtures';
import { SCREENSHOT_CONTEXT, SCREENSHOT_GRAPH_RESPONSE } from '../fixtures/screenshot-graph';
import {
  seedContexts, seedGraphResponse, seedInvestigations, seedStylePresets, seedQueryTemplates,
} from '../helpers/api-mocks';
import { waitForLayoutDone } from '../helpers/graph-hooks';

const OUT = '/tmp/claude-0/-root-graphlagoon/ac2c0ae9-0e80-40c2-a3b1-79ed559aa5da/scratchpad/ux/graph';
mkdirSync(OUT, { recursive: true });
const LOG = `${OUT}/measurements.jsonl`;
const CANVAS = '.graph3d-container canvas';
const now = new Date().toISOString();

const CASE = {
  id: 'inv-1', title: 'Golpe Pix · falsa central', status: 'analysis', case_type: 'general', fields: {}, tags: ['MED'],
  owner_email: 'e2e@test.com', assignee_email: 'ana@test.com', settings: {}, state: {}, shared_with: [],
  has_write_access: true, can_manage: true, created_at: now, updated_at: now, item_count: 2, suggested_count: 1, deadline: null,
};
const TEMPLATE = (i: number, name: string) => ({
  id: `tpl-${i}`, graph_context_id: SCREENSHOT_CONTEXT.id, owner_email: 'e2e@test.com', name, query_type: 'cypher',
  description: `Template ${i}`,
  query: 'MATCH (n {node_id: "$node_id"})-[r]-() RETURN r LIMIT $limit',
  parameters: [{ id: 'node_id', type: 'input', label: 'node_id', required: true }],
  options: {}, created_at: now, updated_at: now,
});
const PRESET = { aesthetics: { nodeSize: 9 }, nodeTypeColors: { Person: '#ff0000' }, edgeTypeColors: {}, textFormat: { rules: [], defaults: {} }, layout_algorithm: 'force3d', layout_mode_config: { ego: {}, hive: {}, hierarchical: {} }, force3d_settings: {} };

function log(entry: Record<string, unknown>) {
  appendFileSync(LOG, JSON.stringify(entry) + '\n');
}
async function shot(page: Page, name: string) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  return `${name}.png`;
}

/** Rects, overflow, clipping, small targets, overlaps: one evaluate, logged with a label. */
async function measure(page: Page, label: string, extra: Record<string, unknown> = {}) {
  const data = await page.evaluate(() => {
    const r = (el: Element | null) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const vis = (el: Element) => { const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const panelSel = ['.side-panel', '.filter-panel', '[data-testid=look-panel]', '.panel-wrapper', '.context-info-panel', '.graph-query-panel', '.query-templates-panel', '.templates-panel', '.metrics-panel', '.cluster-program-panel', '.data-table-drawer', '.query-console-drawer', '[data-testid=graph-context-menu]', '.panel-dock', '.docked-panel', '.left-panels', '.panels-dock'];
    const panels: any[] = [];
    const seen = new Set<Element>();
    for (const sel of panelSel) document.querySelectorAll(sel).forEach((el) => {
      if (seen.has(el) || !vis(el)) return; seen.add(el);
      const s = getComputedStyle(el);
      // deepest scroller inside: find the element that actually clips
      let clip: any = null;
      const walk = (n: Element, depth: number) => {
        if (depth > 6) return;
        const cs = getComputedStyle(n);
        if (n.scrollHeight > n.clientHeight + 2 && !/auto|scroll/.test(cs.overflowY)) {
          clip = clip ?? { tag: n.tagName + '.' + (n.className as string).toString().split(' ')[0], scrollH: n.scrollHeight, clientH: n.clientHeight, overflowY: cs.overflowY };
        }
        Array.from(n.children).forEach((c) => walk(c, depth + 1));
      };
      walk(el, 0);
      panels.push({ sel, cls: (el.className as string).toString().slice(0, 60), rect: r(el), scrollH: el.scrollHeight, clientH: el.clientHeight, overflowY: s.overflowY, tallerThanViewport: el.getBoundingClientRect().height > innerHeight, clips: clip });
    });
    const overflow: string[] = [];
    document.querySelectorAll('body *').forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.width > 0 && (b.right > innerWidth + 1 || b.left < -1)) {
        const e = el as HTMLElement; const cls = typeof e.className === 'string' ? e.className.split(' ')[0] : '';
        overflow.push(`${e.tagName}.${cls}`);
      }
    });
    const small: any[] = [];
    const scope = [...panelSel, '[data-testid=graph-toolbar]', '[data-testid=graph-status-bar]'].join(',');
    document.querySelectorAll(scope).forEach((root) => {
      root.querySelectorAll('button, a, input, select, [role=button], [role=tab], summary').forEach((el) => {
        if (!vis(el)) return;
        const b = el.getBoundingClientRect();
        if (b.width < 24 || b.height < 24) {
          const e = el as HTMLElement;
          const label = e.dataset.testid || e.getAttribute('aria-label') || e.getAttribute('title') || (e as HTMLInputElement).type || e.textContent?.trim().slice(0, 30) || e.className.toString().slice(0, 30);
          small.push({ label, w: Math.round(b.width), h: Math.round(b.height), tag: e.tagName.toLowerCase(), type: (e as HTMLInputElement).type });
        }
      });
    });
    const inter = (a: any, b: any) => a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const canvas = r(document.querySelector('[data-testid=graph-container]'));
    const toolbar = r(document.querySelector('[data-testid=graph-toolbar]'));
    const status = r(document.querySelector('[data-testid=graph-status-bar]'));
    const floats = Array.from(document.querySelectorAll('.panel-wrapper, .context-info-panel, .group-legend, .side-panel--floating')).filter(vis).map((el) => ({ cls: (el.className as string).toString().slice(0, 40), rect: r(el) }));
    const overlaps: string[] = [];
    for (let i = 0; i < floats.length; i++) {
      for (let j = i + 1; j < floats.length; j++) if (inter(floats[i].rect, floats[j].rect)) overlaps.push(`${floats[i].cls} x ${floats[j].cls}`);
      if (inter(floats[i].rect, toolbar)) overlaps.push(`${floats[i].cls} x graph-toolbar`);
      if (inter(floats[i].rect, status)) overlaps.push(`${floats[i].cls} x status-bar`);
    }
    return {
      viewport: { w: innerWidth, h: innerHeight }, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      hOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, overflowOffenders: overflow.slice(0, 8),
      canvas, toolbar, status, panels, floats, overlaps, small: small.slice(0, 60),
    };
  });
  log({ label, ...extra, ...data });
  return data;
}

/** Contrast of muted text against its real background. */
async function contrast(page: Page, label: string) {
  const data = await page.evaluate(() => {
    const lum = (c: string) => {
      const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
      const [r, g, b] = m.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      return { l: 0.2126 * r + 0.7152 * g + 0.0722 * b, a: m[3] ?? 1 };
    };
    const bgOf = (el: Element) => {
      let n: Element | null = el;
      while (n) { const bg = getComputedStyle(n).backgroundColor; if (bg && lum(bg).a > 0.5) return bg; n = n.parentElement; }
      return 'rgb(255,255,255)';
    };
    const ratio = (fg: string, bg: string) => { const a = lum(fg).l, b = lum(bg).l; return +(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2)); };
    const sels = ['.hint', '.muted', '.caption', '[data-testid=look-caption]', '.status-item', '.status-stats', '.status-chip', '.panel-header .btn-outline', '.text-muted', '.help-text', '.form-hint', '.field-hint', '.section-hint', '.panel-hint', 'small', '.checkbox-item', '.props-table td', '.prop-key', '.prop-label', '.label', '.empty-state-message', '.panel-header h3', '.tabs [role=tab]', '.tab', '.filter-section h4', 'h4'];
    const out: any[] = [];
    const seen = new Set<string>();
    for (const sel of sels) document.querySelectorAll(sel).forEach((el) => {
      const b = el.getBoundingClientRect(); if (b.width === 0 || b.height === 0) return;
      const cs = getComputedStyle(el); const fg = cs.color; const bg = bgOf(el);
      const text = (el.textContent || '').trim().slice(0, 40); if (!text) return;
      const key = sel + fg + bg; if (seen.has(key)) return; seen.add(key);
      out.push({ sel, text, fg, bg, ratio: ratio(fg, bg), fontPx: parseFloat(cs.fontSize), weight: cs.fontWeight });
    });
    return out;
  });
  log({ label: `contrast:${label}`, contrast: data });
  return data;
}

async function focusInfo(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { tag: el.tagName, testid: el.dataset?.testid, text: (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().slice(0, 40), outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, boxShadow: cs.boxShadow, inPanel: !!el.closest('.filter-panel,[data-testid=look-panel],.side-panel') };
  });
}

type BootOpts = { ctx?: any; graph?: any; cases?: any[]; presets?: Record<string, any>; templates?: any[]; initCase?: boolean; before?: (page: Page) => Promise<void> };
async function boot(page: Page, w: number, h: number, o: BootOpts = {}) {
  const ctx = o.ctx ?? SCREENSHOT_CONTEXT;
  await page.setViewportSize({ width: w, height: h });
  if (o.initCase) await page.addInitScript(() => localStorage.setItem('graphlagoon.currentCase', JSON.stringify({ id: 'inv-1', title: 'Golpe Pix · falsa central' })));
  await seedContexts(page, [ctx]);
  await seedGraphResponse(page, o.graph ?? SCREENSHOT_GRAPH_RESPONSE);
  let inv: any = null;
  if (o.cases) inv = await seedInvestigations(page, o.cases);
  if (o.presets) await seedStylePresets(page, ctx.id, o.presets);
  if (o.templates) await seedQueryTemplates(page, ctx.id, o.templates);
  if (o.before) await o.before(page);
  await page.goto(`/graph/${ctx.id}`);
  await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 20_000 });
  return inv;
}
async function settle(page: Page) {
  await waitForLayoutDone(page);
  await page.waitForTimeout(800);
}

async function nodeXY(page: Page, nodeId: string) {
  const canvas = page.locator(CANVAS);
  for (let attempt = 0; attempt < 40; attempt++) {
    const coords = await page.evaluate((id) => (window as any).__GRAPH_NODE_SCREEN_COORDS__?.(id) as { x: number; y: number } | null, nodeId);
    if (coords) {
      const box = await canvas.boundingBox();
      if (box) {
        const x = box.x + coords.x, y = box.y + coords.y;
        await page.mouse.move(x, y);
        try { await expect(canvas).toHaveClass(/clickable/, { timeout: 1500 }); return { x, y }; } catch { /* retry */ }
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`could not hover node ${nodeId}`);
}
async function clickNode(page: Page, id: string, ctrl = false) {
  const p = await nodeXY(page, id);
  await page.mouse.click(p.x, p.y, { modifiers: ctrl ? ['Control'] : [] });
  await page.waitForTimeout(300);
}
async function rightClickNode(page: Page, id: string) {
  const p = await nodeXY(page, id);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await expect(page.getByTestId('graph-context-menu')).toBeVisible({ timeout: 5000 });
}
async function openTop(page: Page, title: string) {
  await page.getByTitle(title, { exact: true }).first().click();
  await page.waitForTimeout(400);
}
async function openLook(page: Page, tab: string) {
  if (!(await page.getByTestId('look-panel').isVisible().catch(() => false))) await page.getByTestId('toolbar-look').click();
  await page.getByTestId(`look-tab-${tab}`).click();
  await page.waitForTimeout(400);
}
async function runClusters(page: Page) {
  await openTop(page, 'Clusters');
  await page.getByTestId('community-algorithm-select').selectOption('cluster-program:default-group-by-node-type');
  await page.getByTestId('cluster-run').click();
  await page.getByTestId('cluster-run-summary').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
}
const statusText = (page: Page) => page.getByTestId('graph-status-bar').innerText();

for (const [w, h] of [[1440, 900], [1024, 700]] as const) {
  test.describe(`graph ${w}`, () => {
    test(`A ${w}: base, details, filters, look`, async ({ authenticatedPage: page }) => {
      await boot(page, w, h);
      await settle(page);
      await measure(page, `${w}-no-panel`, { png: await shot(page, `${w}-no-panel-populated`) });
      if (w === 1440) await contrast(page, 'no-panel');
      await clickNode(page, 'person-0');
      await expect(page.locator('.side-panel')).toBeVisible();
      await measure(page, `${w}-node-details`, { png: await shot(page, `${w}-node-details-populated`) });
      const sp = page.locator('.side-panel');
      const sh = await sp.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
      if (sh.sh > sh.ch + 4) { await sp.evaluate((el) => el.scrollTo(0, el.scrollHeight)); await shot(page, `${w}-node-details-populated-scrolled`); }
      log({ label: `${w}-node-details-scroll`, ...sh, headings: await sp.locator('h3,h4,summary').allInnerTexts(), buttons: await sp.locator('button').evaluateAll((b) => b.map((x) => (x.getAttribute('aria-label') || x.textContent || '').trim())) });
      if (w === 1440) await contrast(page, 'node-details');
      // edge details
      await page.evaluate(() => (window as any).__GRAPH_SELECT_EDGE__?.('e0'));
      await page.waitForTimeout(500);
      await measure(page, `${w}-edge-details`, { png: await shot(page, `${w}-edge-details-populated`), heading: await page.locator('.side-panel h3').first().innerText().catch(() => null) });
      await page.getByLabel('Clear selection').click().catch(() => {});
      // Filters
      await openTop(page, 'Filters');
      await measure(page, `${w}-filters`, { png: await shot(page, `${w}-filters-populated`) });
      if (w === 1440) await contrast(page, 'filters');
      for (const tab of ['style', 'labels', 'behaviors', 'presets']) {
        await openLook(page, tab);
        await measure(page, `${w}-look-${tab}`, { png: await shot(page, `${w}-look-${tab}-populated`) });
        if (w === 1440) await contrast(page, `look-${tab}`);
        const lp = page.getByTestId('look-panel');
        const s = await lp.evaluate((el) => { const body = el.querySelector('.tab-body, .look-body, .panel-body') ?? el; return { sh: body.scrollHeight, ch: body.clientHeight }; });
        if (s.sh > s.ch + 4) { await lp.evaluate((el) => { const body = el.querySelector('.tab-body, .look-body, .panel-body') ?? el; body.scrollTo(0, body.scrollHeight); }); await shot(page, `${w}-look-${tab}-populated-scrolled`); }
      }
    });

    test(`B ${w}: layout, info, query, templates, metrics`, async ({ authenticatedPage: page }) => {
      await boot(page, w, h, { templates: [TEMPLATE(1, 'Neighbors'), TEMPLATE(2, 'Company network')] });
      await settle(page);
      await page.getByTestId('graph-toolbar-layout').click(); await page.waitForTimeout(400);
      await measure(page, `${w}-layout`, { png: await shot(page, `${w}-layout-populated`) });
      if (w === 1440) await contrast(page, 'layout');
      await openTop(page, 'Context Info').catch(async () => { await page.getByTestId('graph-toolbar').getByText('Info', { exact: true }).click(); });
      await measure(page, `${w}-layout+info`, { png: await shot(page, `${w}-layout+info-populated`) });
      await page.getByTestId('layout-panel-close').click().catch(() => {});
      await page.waitForTimeout(300);
      await measure(page, `${w}-info`, { png: await shot(page, `${w}-info-populated`) });
      if (w === 1440) await contrast(page, 'info');
      await page.locator('.context-info-panel').getByLabel('Close').click().catch(() => {});
      await openTop(page, 'Query');
      await measure(page, `${w}-query`, { png: await shot(page, `${w}-query-populated`) });
      if (w === 1440) await contrast(page, 'query');
      await openTop(page, 'Query Templates');
      await measure(page, `${w}-templates`, { png: await shot(page, `${w}-templates-populated`) });
      if (w === 1440) await contrast(page, 'templates');
      await openTop(page, 'Metrics');
      await measure(page, `${w}-metrics`, { png: await shot(page, `${w}-metrics-populated`) });
      if (w === 1440) await contrast(page, 'metrics');
      await page.getByTestId('metrics-tab-custom').click().catch(() => {});
      await shot(page, `${w}-metrics-custom-populated`);
    });

    test(`C ${w}: clusters, table, console, context menu`, async ({ authenticatedPage: page }) => {
      await boot(page, w, h);
      await settle(page);
      await openTop(page, 'Clusters');
      await measure(page, `${w}-clusters-initial`, { png: await shot(page, `${w}-clusters-initial-populated`) });
      await page.getByTestId('community-algorithm-select').selectOption('cluster-program:default-group-by-node-type');
      await page.getByTestId('cluster-run').click();
      await page.getByTestId('cluster-run-summary').waitFor({ timeout: 15_000 });
      await page.waitForTimeout(600);
      await page.getByTestId('clusters-tab-groups').click().catch(() => {});
      await measure(page, `${w}-clusters-results`, { png: await shot(page, `${w}-clusters-results-populated`) });
      if (w === 1440) await contrast(page, 'clusters');
      await page.getByTestId('clusters-tab-similarity').click().catch(() => {});
      await shot(page, `${w}-clusters-similarity-populated`);
      await page.getByTestId('clusters-tab-groups').click().catch(() => {});
      await page.getByTestId('cluster-manage-programs').click();
      await page.getByTestId('cluster-program-library').waitFor({ timeout: 5000 });
      await measure(page, `${w}-clusters-programs`, { png: await shot(page, `${w}-clusters-programs-populated`) });
      await page.keyboard.press('Escape'); await page.waitForTimeout(300);
      // close clusters dock
      await openTop(page, 'Clusters');
      await page.getByTitle('Data Table', { exact: true }).click(); await page.waitForTimeout(600);
      await measure(page, `${w}-table`, { png: await shot(page, `${w}-table-populated`) });
      if (w === 1440) await contrast(page, 'table');
      await page.getByTestId('query-console-toggle').click(); await page.waitForTimeout(600);
      await measure(page, `${w}-console`, { png: await shot(page, `${w}-console-populated`) });
      if (w === 1440) await contrast(page, 'console');
      await page.getByTestId('query-console-toggle').click(); await page.waitForTimeout(300);
      await rightClickNode(page, 'person-1');
      const items = await page.getByTestId('graph-context-menu').locator('button, [role=menuitem]').allInnerTexts();
      await measure(page, `${w}-context-menu`, { png: await shot(page, `${w}-context-menu-populated`), items });
    });
  });
}

test.describe('states 1440', () => {
  const W = 1440, H = 900;
  test('empty graph', async ({ authenticatedPage: page }) => {
    await boot(page, W, H, { graph: { nodes: [], edges: [], truncated: false, metadata: { node_count: 0, edge_count: 0 } } });
    await page.waitForTimeout(1200);
    await measure(page, '1440-empty', { png: await shot(page, '1440-no-panel-empty'), status: await statusText(page), overlay: await page.locator('.empty-overlay').innerText().catch(() => null) });
    await contrast(page, 'empty');
    await openTop(page, 'Filters');
    await shot(page, '1440-filters-empty');
    await clickNodeSafe(page);
    await page.setViewportSize({ width: 1024, height: 700 }); await page.waitForTimeout(500);
    await measure(page, '1024-empty', { png: await shot(page, '1024-filters-empty') });
  });

  test('loading and errors', async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width: W, height: H });
    await seedContexts(page, [SCREENSHOT_CONTEXT]);
    await seedGraphResponse(page, SCREENSHOT_GRAPH_RESPONSE);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/graphlagoon/api/graph-contexts/*/subgraph', async (route) => { await gate; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SCREENSHOT_GRAPH_RESPONSE) }); });
    await page.goto(`/graph/${SCREENSHOT_CONTEXT.id}`);
    await page.getByTestId('graph-loading').waitFor({ timeout: 15_000 });
    await measure(page, '1440-loading', { png: await shot(page, '1440-no-panel-loading'), text: await page.getByTestId('graph-loading').innerText() });
    release();
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 20_000 });
    await settle(page);
    // query error
    await page.route('**/graphlagoon/api/graph-contexts/*/cypher', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Query failed: Table edges not found (SQLSTATE 42P01)', error_code: 'TABLE_NOT_FOUND' }) }));
    await page.route('**/graphlagoon/api/graph-contexts/*/query', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Query failed: Table edges not found (SQLSTATE 42P01)' }) }));
    await openTop(page, 'Query');
    await page.getByTestId('graph-query-run').click();
    const modal = page.locator('.modal-overlay').last();
    await modal.waitFor({ timeout: 10_000 }).catch(() => {});
    await measure(page, '1440-query-error', { png: await shot(page, '1440-query-error-modal'), modalText: await modal.innerText().catch(() => null), focus: await focusInfo(page) });
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    // context load error
    await page.route(`**/graphlagoon/api/graph-contexts/${SCREENSHOT_CONTEXT.id}`, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Internal server error' }) }));
    await page.goto(`/graph/${SCREENSHOT_CONTEXT.id}`);
    await page.waitForTimeout(2500);
    await measure(page, '1440-context-error', { png: await shot(page, '1440-no-panel-context-error'), body: (await page.locator('body').innerText()).slice(0, 600) });
    // 404 context
    await page.goto('/graph/does-not-exist');
    await page.waitForTimeout(2500);
    await measure(page, '1440-context-404', { png: await shot(page, '1440-no-panel-context-404'), body: (await page.locator('body').innerText()).slice(0, 600) });
  });

  test('long names', async ({ authenticatedPage: page }) => {
    const LONG80 = 'Maria Aparecida de Oliveira Nascimento Ferreira dos Santos Albuquerque Lima Jr';
    const LONG200 = 'x'.repeat(50) + 'Q'.repeat(50) + '9'.repeat(50) + 'z'.repeat(50);
    const ctx = { ...SCREENSHOT_CONTEXT, title: 'Rede social de pessoas, empresas e produtos — fraude cartões 2024 investigação regional sul e sudeste x', node_types: ['Person', 'Company', 'Product', 'AVeryLongNodeTypeNameThatKeepsGoingAndGoingWithoutAnySpaceAtAll'] };
    const graph = JSON.parse(JSON.stringify(SCREENSHOT_GRAPH_RESPONSE));
    graph.nodes[0].properties.name = LONG80;
    graph.nodes[0].properties.notes = LONG200;
    graph.nodes[0].properties.description = 'A long human sentence with spaces that should wrap normally without breaking words mid token when the panel is narrow enough to need it.';
    graph.nodes[1].node_type = 'AVeryLongNodeTypeNameThatKeepsGoingAndGoingWithoutAnySpaceAtAll';
    const tpl = TEMPLATE(1, 'Neighbours of a node within two hops including the companies they work at and the products bought');
    await boot(page, W, H, { ctx, graph, templates: [tpl], presets: { 'a-very-long-style-preset-name-that-describes-everything-it-does-in-detail-2024': PRESET } });
    await settle(page);
    await measure(page, '1440-long-no-panel', { png: await shot(page, '1440-no-panel-long'), title: await page.getByTestId('toolbar-context-title').evaluate((el) => ({ text: el.textContent, w: el.getBoundingClientRect().width, overflow: getComputedStyle(el).textOverflow, sw: el.scrollWidth, cw: el.clientWidth })) });
    await clickNode(page, 'person-0');
    await expect(page.locator('.side-panel')).toBeVisible();
    await measure(page, '1440-long-node-details', { png: await shot(page, '1440-node-details-long') });
    await openTop(page, 'Filters');
    await measure(page, '1440-long-filters', { png: await shot(page, '1440-filters-long') });
    await openTop(page, 'Query Templates');
    await measure(page, '1440-long-templates', { png: await shot(page, '1440-templates-long') });
    await openLook(page, 'presets');
    await measure(page, '1440-long-presets', { png: await shot(page, '1440-look-presets-long') });
    await page.getByTitle('Data Table', { exact: true }).click(); await page.waitForTimeout(600);
    await measure(page, '1440-long-table', { png: await shot(page, '1440-table-long') });
    await page.setViewportSize({ width: 1024, height: 700 }); await page.waitForTimeout(500);
    await measure(page, '1024-long-node-details', { png: await shot(page, '1024-node-details-long') });
  });

  test('many items', async ({ authenticatedPage: page }) => {
    const nodeTypes = Array.from({ length: 15 }, (_, i) => `Type${String.fromCharCode(65 + i)}`);
    const edgeTypes = Array.from({ length: 15 }, (_, i) => `REL_${String.fromCharCode(65 + i)}`);
    const graph = JSON.parse(JSON.stringify(SCREENSHOT_GRAPH_RESPONSE));
    graph.nodes.forEach((n: any, i: number) => (n.node_type = nodeTypes[i % 15]));
    graph.edges.forEach((e: any, i: number) => (e.relationship_type = edgeTypes[i % 15]));
    const ctx = { ...SCREENSHOT_CONTEXT, node_types: nodeTypes, relationship_types: edgeTypes };
    const presets: Record<string, any> = {};
    for (let i = 1; i <= 12; i++) presets[`preset-${String(i).padStart(2, '0')}`] = PRESET;
    const templates = Array.from({ length: 20 }, (_, i) => TEMPLATE(i, `Template ${String(i + 1).padStart(2, '0')}`));
    await boot(page, W, H, { ctx, graph, presets, templates });
    await settle(page);
    await openTop(page, 'Filters');
    await measure(page, '1440-many-filters', { png: await shot(page, '1440-filters-many') });
    await openLook(page, 'presets');
    await measure(page, '1440-many-presets', { png: await shot(page, '1440-look-presets-many') });
    await openTop(page, 'Query Templates');
    await measure(page, '1440-many-templates', { png: await shot(page, '1440-templates-many') });
    await page.setViewportSize({ width: 1024, height: 700 }); await page.waitForTimeout(500);
    await measure(page, '1024-many-templates', { png: await shot(page, '1024-templates-many') });
    await openTop(page, 'Filters');
    await measure(page, '1024-many-filters', { png: await shot(page, '1024-filters-many') });
    await openLook(page, 'presets');
    await measure(page, '1024-many-presets', { png: await shot(page, '1024-look-presets-many') });
  });
});

async function clickNodeSafe(page: Page) { /* nothing to click on an empty graph */ void page; }

for (const [w, h] of [[1440, 900], [1024, 700]] as const) {
  test(`T2 add to case ${w}`, async ({ authenticatedPage: page }) => {
    const inv = await boot(page, w, h, { cases: [CASE] });
    await settle(page);
    const steps: any[] = [];
    const chip = page.getByTestId('current-case-chip');
    const chipBox = await chip.boundingBox();
    steps.push({ step: '1 fresh page', chipVisible: await chip.isVisible(), chipText: await page.getByTestId('current-case-label').innerText(), chipBox, addBtn: await page.getByTestId('toolbar-add-to-investigation').evaluate((b: HTMLButtonElement) => ({ disabled: b.disabled, title: b.title, text: b.textContent?.trim(), visible: b.getBoundingClientRect().width > 0 })).catch(() => null) });
    await shot(page, `${w}-case-step1-no-case`);
    // 2 right-click with no case
    await rightClickNode(page, 'person-2');
    const menuNoCase = await page.getByTestId('graph-context-menu').locator('button, [role=menuitem]').allInnerTexts();
    steps.push({ step: '2 right-click without case', menu: menuNoCase, hasAdd: menuNoCase.some((t) => /case/i.test(t)) });
    await shot(page, `${w}-case-step2-menu-no-case`);
    await page.keyboard.press('Escape');
    // node details without case: any add control?
    await clickNode(page, 'person-2');
    const spButtons = await page.locator('.side-panel button').evaluateAll((b) => b.map((x) => (x.getAttribute('aria-label') || x.textContent || '').trim()));
    steps.push({ step: '2b side panel controls (no case)', spButtons });
    // 3 open chip
    await chip.click();
    await page.getByTestId('current-case-menu').waitFor();
    steps.push({ step: '3 chip menu', menuText: await page.getByTestId('current-case-menu').innerText() });
    await measure(page, `${w}-case-menu`, { png: await shot(page, `${w}-case-step3-chip-menu`) });
    await page.getByTestId('current-case-search').fill('Pix');
    await page.getByTestId('current-case-pick-inv-1').click();
    await page.waitForTimeout(300);
    steps.push({ step: '4 picked', chipText: await page.getByTestId('current-case-label').innerText(), addBtn: await page.getByTestId('toolbar-add-to-investigation').evaluate((b: HTMLButtonElement) => ({ disabled: b.disabled, title: b.title, text: b.textContent?.trim() })).catch(() => null), ls: await page.evaluate(() => localStorage.getItem('graphlagoon.currentCase')) });
    await shot(page, `${w}-case-step4-picked`);
    // 5 side panel after picking
    const spButtons2 = await page.locator('.side-panel button').evaluateAll((b) => b.map((x) => (x.getAttribute('aria-label') || x.textContent || '').trim()));
    steps.push({ step: '5 side panel controls (with case)', spButtons2 });
    // 6 right-click single
    await rightClickNode(page, 'person-2');
    const menuCase = await page.getByTestId('graph-context-menu').locator('button, [role=menuitem]').allInnerTexts();
    steps.push({ step: '6 right-click with case', menu: menuCase });
    await shot(page, `${w}-case-step6-menu-with-case`);
    await page.getByTestId('context-menu-action-add-selection-to-case').click();
    const toast = page.locator('.toast, [class*=toast]').filter({ hasText: /case|Select/i }).first();
    await toast.waitFor({ timeout: 8000 }).catch(() => {});
    steps.push({ step: '7 toast single', toast: await toast.innerText().catch(() => null), toastActions: await page.locator('[data-testid^=toast-action-]').allInnerTexts(), added: inv?.added });
    await measure(page, `${w}-case-toast`, { png: await shot(page, `${w}-case-step7-toast-single`) });
    await page.waitForTimeout(6500);
    // 8 multi-selection
    await clickNode(page, 'person-3');
    await clickNode(page, 'person-4', true);
    await clickNode(page, 'company-0', true);
    const selCount = await page.evaluate(() => (window as any).__GRAPH_SELECTED_COUNT__?.() ?? null);
    const spHeading = await page.locator('.side-panel h3').first().innerText().catch(() => null);
    await shot(page, `${w}-case-step8-multi-selected`);
    await rightClickNode(page, 'company-0');
    await page.getByTestId('context-menu-action-add-selection-to-case').click();
    const toast2 = page.locator('.toast, [class*=toast]').filter({ hasText: /case|Select/i }).first();
    await toast2.waitFor({ timeout: 8000 }).catch(() => {});
    steps.push({ step: '8 multi add', selCount, spHeading, toast: await toast2.innerText().catch(() => null), addedPayloads: (inv?.added ?? []).map((a: any) => ({ kind: a.kind, subkind: a.subkind, title: a.title, nodes: a.content_json?.nodes?.length, edges: a.content_json?.edges?.length })) });
    await shot(page, `${w}-case-step8-toast-multi`);
    // 9 top-bar Add to case
    await page.waitForTimeout(6500);
    await page.getByTestId('toolbar-add-to-investigation').click().catch(() => {});
    await page.waitForTimeout(800);
    const t3 = page.locator('.toast, [class*=toast]').first();
    steps.push({ step: '9 top-bar add', toast: await t3.innerText().catch(() => null), bodyModal: await page.locator('.modal-overlay').last().innerText().catch(() => null) });
    await shot(page, `${w}-case-step9-topbar-add`);
    await page.keyboard.press('Escape');
    // 10 clear case
    await chip.click(); await page.getByTestId('current-case-clear').click().catch(() => {});
    steps.push({ step: '10 clear', chipText: await page.getByTestId('current-case-label').innerText() });
    log({ label: `${w}-T2`, steps });
  });
}

test('T2 no permission / read-only case 1440', async ({ authenticatedPage: page }) => {
  await page.addInitScript(() => {
    (window as any).__GRAPHLAGOON_CONFIG__ = { ...((window as any).__GRAPHLAGOON_CONFIG__ ?? {}), permissions: [] };
  });
  const inv = await boot(page, 1440, 900, { cases: [{ ...CASE, has_write_access: false, can_manage: false }], initCase: true });
  await settle(page);
  const steps: any[] = [];
  await page.getByTestId('current-case-chip').click();
  await page.getByTestId('current-case-menu').waitFor();
  steps.push({ step: 'chip menu no perm', text: await page.getByTestId('current-case-menu').innerText() });
  await shot(page, '1440-case-noperm-chip-menu');
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 700, y: 60 } }).catch(() => {});
  await rightClickNode(page, 'person-5');
  const menu = await page.getByTestId('graph-context-menu').locator('button, [role=menuitem]').allInnerTexts();
  const addBtn = page.getByTestId('context-menu-action-add-selection-to-case');
  steps.push({ step: 'menu', menu, addEnabled: await addBtn.isEnabled().catch(() => null), addTitle: await addBtn.getAttribute('title').catch(() => null) });
  await addBtn.click().catch(() => {});
  await page.waitForTimeout(1500);
  steps.push({ step: 'after click', toasts: await page.locator('.toast, [class*=toast]').allInnerTexts(), added: inv?.added, topbar: await page.getByTestId('toolbar-add-to-investigation').evaluate((b: HTMLButtonElement) => ({ disabled: b.disabled, title: b.title })).catch(() => null) });
  await shot(page, '1440-case-noperm-after-add');
  log({ label: '1440-T2-noperm', steps });
});

test('T4 filter and go back 1440', async ({ authenticatedPage: page }) => {
  await boot(page, 1440, 900);
  await settle(page);
  const steps: any[] = [];
  const counts = () => page.evaluate(() => { const t = document.querySelector('[data-testid=graph-status-bar]')?.textContent ?? ''; return t.replace(/\s+/g, ' ').trim(); });
  steps.push({ step: '0 start', status: await counts() });
  await openTop(page, 'Filters');
  const companyCb = page.locator('.filter-panel .checkbox-item').filter({ hasText: 'Company' }).locator('input');
  const cbBox = await companyCb.boundingBox();
  await companyCb.click();
  await page.waitForTimeout(700);
  steps.push({ step: '1 hide Company', cbBox, status: await counts(), chips: await page.locator('[data-testid=graph-status-bar] button').allInnerTexts(), filtersBtnState: await page.getByTitle('Filters', { exact: true }).evaluate((b) => ({ pressed: b.getAttribute('aria-pressed'), cls: b.className })) });
  await measure(page, '1440-T4-hidden', { png: await shot(page, '1440-filters-task-company-hidden') });
  // close panel: does anything say it's filtered?
  await openTop(page, 'Filters');
  steps.push({ step: '2 panel closed, still filtered', status: await counts(), filtersBtn: await page.getByTitle('Filters', { exact: true }).evaluate((b) => ({ pressed: b.getAttribute('aria-pressed'), cls: b.className, badge: b.textContent?.trim() })) });
  await shot(page, '1440-filters-task-closed-filtered');
  await openTop(page, 'Filters');
  // also uncheck an edge type and type a search, then Reset
  await page.locator('.filter-panel .checkbox-item').filter({ hasText: 'KNOWS' }).locator('input').click();
  await page.locator('.filter-panel input.form-control').fill('person');
  await page.waitForTimeout(900);
  steps.push({ step: '3 edge hidden + search', status: await counts() });
  await shot(page, '1440-filters-task-search');
  await page.locator('.filter-panel').getByRole('button', { name: 'Reset' }).click();
  await page.waitForTimeout(700);
  steps.push({ step: '4 Reset', status: await counts(), checked: await page.locator('.filter-panel input[type=checkbox]').evaluateAll((l) => l.map((c) => (c as HTMLInputElement).checked)), search: await page.locator('.filter-panel input.form-control').inputValue(), toasts: await page.locator('.toast, [class*=toast]').allInnerTexts(), undoBtn: await page.locator('[data-testid=toast-action-undo]').count() });
  await shot(page, '1440-filters-task-reset');
  // Show only via context menu (needs clusters)
  await runClusters(page);
  await rightClickNode(page, 'person-6');
  const menu = await page.getByTestId('graph-context-menu').locator('button, [role=menuitem]').allInnerTexts();
  steps.push({ step: '5 menu after clustering', menu });
  await shot(page, '1440-filters-task-menu-showonly');
  await page.getByTestId('context-menu-action-isolate-community').click();
  await page.waitForTimeout(700);
  const iso = page.getByTestId('status-isolation');
  steps.push({ step: '6 show only', status: await counts(), isolation: await iso.innerText().catch(() => null), isoTitle: await iso.getAttribute('title').catch(() => null), clearBox: await page.getByTestId('status-isolation-clear').boundingBox().catch(() => null) });
  await measure(page, '1440-T4-showonly', { png: await shot(page, '1440-filters-task-showonly') });
  // Filters panel while isolated: do the checkboxes reflect it?
  await openTop(page, 'Filters');
  steps.push({ step: '7 filters panel while show-only', checked: await page.locator('.filter-panel input[type=checkbox]').evaluateAll((l) => l.map((c) => (c as HTMLInputElement).checked)) });
  await shot(page, '1440-filters-task-showonly-filters-panel');
  await page.locator('.filter-panel').getByRole('button', { name: 'Reset' }).click();
  await page.waitForTimeout(700);
  steps.push({ step: '8 Filters Reset during show-only', status: await counts(), isolationStill: await iso.isVisible().catch(() => false) });
  await shot(page, '1440-filters-task-showonly-after-filters-reset');
  await page.getByTestId('status-isolation-clear').click().catch(() => {});
  await page.waitForTimeout(700);
  steps.push({ step: '9 clear isolation', status: await counts(), isolationStill: await iso.isVisible().catch(() => false) });
  await shot(page, '1440-filters-task-cleared');
  // right-click menu Show all
  await rightClickNode(page, 'person-6');
  steps.push({ step: '10 menu after clear', menu: await page.getByTestId('graph-context-menu').locator('button, [role=menuitem]').allInnerTexts() });
  await page.keyboard.press('Escape');
  log({ label: '1440-T4', steps });
});

test('keyboard 1440', async ({ authenticatedPage: page }) => {
  await boot(page, 1440, 900);
  await settle(page);
  await openTop(page, 'Filters');
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  const trail: any[] = [];
  for (let i = 1; i <= 25; i++) {
    await page.keyboard.press('Tab');
    const f = await focusInfo(page);
    trail.push({ i, ...f });
    if (i === 5 || i === 15 || i === 25) await shot(page, `1440-keyboard-tab${i}-filters`);
  }
  const filtersOpenBefore = await page.locator('.filter-panel').isVisible();
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  const filtersOpenAfterEsc = await page.locator('.filter-panel').isVisible();
  // focus inside the panel then Escape
  await page.locator('.filter-panel input.form-control').focus();
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  const filtersOpenAfterEscInside = await page.locator('.filter-panel').isVisible();
  // Look tabs
  await openLook(page, 'style');
  await page.getByTestId('look-tab-style').focus();
  const tabFocus0 = await focusInfo(page);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(200);
  const afterArrow = { focus: await focusInfo(page), active: await page.locator('[data-testid^=look-tab-][aria-selected=true]').getAttribute('data-testid') };
  await page.keyboard.press('Tab'); await page.waitForTimeout(200);
  const afterTab = { focus: await focusInfo(page) };
  await page.getByTestId('look-tab-labels').focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  const afterEnter = { active: await page.locator('[data-testid^=look-tab-][aria-selected=true]').getAttribute('data-testid'), focus: await focusInfo(page) };
  await shot(page, '1440-keyboard-look-tabs');
  // Tab into Look panel from toolbar: count presses from toolbar-look to first tab
  await page.getByTestId('toolbar-look').focus();
  let presses = 0; let reached: any = null;
  for (let i = 0; i < 40; i++) { await page.keyboard.press('Tab'); presses++; const f = await focusInfo(page); if (f?.testid?.startsWith('look-tab-')) { reached = f; break; } }
  const lookOpen = await page.getByTestId('look-panel').isVisible();
  await page.getByTestId('look-tab-style').focus();
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  const lookAfterEsc = await page.getByTestId('look-panel').isVisible();
  // canvas toolbar aria
  const tbAria = await page.getByTestId('graph-toolbar').locator('button').evaluateAll((bs) => bs.map((b) => ({ text: b.textContent?.trim(), title: b.getAttribute('title'), ariaLabel: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed') })));
  const topAria = await page.locator('.toolbar-center button, nav button').evaluateAll((bs) => bs.map((b) => ({ text: b.textContent?.trim().slice(0, 20), title: b.getAttribute('title'), ariaLabel: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed') })));
  log({ label: '1440-keyboard', trail, filtersOpenBefore, filtersOpenAfterEsc, filtersOpenAfterEscInside, tabFocus0, afterArrow, afterTab, afterEnter, pressesFromLookBtnToTab: presses, reached, lookOpen, lookAfterEsc, tbAria, topAria });
});

test('direct manipulation 1440', async ({ authenticatedPage: page }) => {
  await boot(page, 1440, 900);
  await settle(page);
  const lsBefore = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, (localStorage.getItem(k) ?? '').slice(0, 80)])));
  const out: any = { lsBefore };
  // docked panel edge drag
  await openTop(page, 'Filters');
  const fp = page.locator('.filter-panel');
  const r0 = await fp.boundingBox();
  const cur = await page.evaluate(() => { const el = document.querySelector('.filter-panel') as HTMLElement; const p = el.parentElement as HTMLElement; return { panelCursor: getComputedStyle(el).cursor, resize: getComputedStyle(el).resize, parentResize: getComputedStyle(p).resize, parentCls: p.className }; });
  if (r0) { await page.mouse.move(r0.x + r0.width - 2, r0.y + r0.height / 2); await page.mouse.down(); await page.mouse.move(r0.x + r0.width + 150, r0.y + r0.height / 2, { steps: 8 }); await page.mouse.up(); }
  const r1 = await fp.boundingBox();
  out.dockedResize = { before: r0, after: r1, cur };
  // header drag of docked panel
  const hdr = fp.locator('.panel-header h3');
  const hb = await hdr.boundingBox();
  if (hb) { await page.mouse.move(hb.x + 5, hb.y + 5); await page.mouse.down(); await page.mouse.move(hb.x + 300, hb.y + 200, { steps: 8 }); await page.mouse.up(); }
  out.dockedDrag = { after: await fp.boundingBox() };
  await openTop(page, 'Filters');
  // floating Layout panel drag + resize
  await page.getByTestId('graph-toolbar-layout').click(); await page.waitForTimeout(400);
  const lp = page.locator('.panel-wrapper.panel-left');
  const l0 = await lp.boundingBox();
  const lh = await lp.locator('h3').first().boundingBox();
  if (lh) { await page.mouse.move(lh.x + 5, lh.y + 5); await page.mouse.down(); await page.mouse.move(lh.x + 300, lh.y - 150, { steps: 8 }); await page.mouse.up(); }
  const l1 = await lp.boundingBox();
  if (l0) { await page.mouse.move(l0.x + l0.width - 2, l0.y + 40); await page.mouse.down(); await page.mouse.move(l0.x + l0.width + 150, l0.y + 40, { steps: 8 }); await page.mouse.up(); }
  const l2 = await lp.boundingBox();
  out.floatingLayout = { before: l0, afterDrag: l1, afterResize: l2, collapse: await lp.locator('button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent?.trim())) };
  await shot(page, '1440-manip-layout-after-drag');
  await page.getByTestId('layout-panel-close').click().catch(() => {});
  // Table drawer resize
  await page.getByTitle('Data Table', { exact: true }).click(); await page.waitForTimeout(600);
  const dr = page.locator('.data-table-drawer');
  const d0 = await dr.boundingBox();
  const handle = dr.locator('.drawer-handle');
  const hbox = await handle.boundingBox();
  if (hbox) { await page.mouse.move(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2); await page.mouse.down(); await page.mouse.move(hbox.x + hbox.width / 2, hbox.y - 200, { steps: 10 }); await page.mouse.up(); }
  const d1 = await dr.boundingBox();
  // try going beyond max
  const hbox2 = await handle.boundingBox();
  if (hbox2) { await page.mouse.move(hbox2.x + 50, hbox2.y + hbox2.height / 2); await page.mouse.down(); await page.mouse.move(hbox2.x + 50, 20, { steps: 10 }); await page.mouse.up(); }
  const d2 = await dr.boundingBox();
  out.tableDrawer = { before: d0, afterDrag200: d1, afterDragMax: d2, handle: hbox, handleCursor: await handle.evaluate((el) => getComputedStyle(el).cursor), handleBg: await handle.evaluate((el) => getComputedStyle(el).backgroundColor), canvasAfter: await page.getByTestId('graph-container').boundingBox() };
  await measure(page, '1440-manip-table-resized', { png: await shot(page, '1440-manip-table-resized') });
  const lsAfterTable = await page.evaluate(() => Object.keys(localStorage));
  // Console drawer resize
  await page.getByTestId('query-console-toggle').click(); await page.waitForTimeout(600);
  const qc = page.getByTestId('query-console');
  const q0 = await qc.boundingBox();
  const qh = await qc.locator('.drawer-handle').boundingBox();
  if (qh) { await page.mouse.move(qh.x + qh.width / 2, qh.y + qh.height / 2); await page.mouse.down(); await page.mouse.move(qh.x + qh.width / 2, qh.y - 150, { steps: 10 }); await page.mouse.up(); }
  const q1 = await qc.boundingBox();
  out.consoleDrawer = { before: q0, afterDrag150: q1, tableStillOpen: await dr.isVisible().catch(() => false) };
  await shot(page, '1440-manip-console-resized');
  const lsAfter = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, (localStorage.getItem(k) ?? '').slice(0, 80)])));
  await page.reload();
  await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  const afterReload = { consoleOpen: await qc.isVisible().catch(() => false), tableOpen: await dr.isVisible().catch(() => false), consoleBox: await qc.boundingBox().catch(() => null), tableBox: await dr.boundingBox().catch(() => null), lookOpen: await page.getByTestId('look-panel').isVisible().catch(() => false), filtersOpen: await page.locator('.filter-panel').isVisible().catch(() => false), ls: await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, (localStorage.getItem(k) ?? '').slice(0, 80)]))) };
  await shot(page, '1440-manip-after-reload');
  out.lsAfterTable = lsAfterTable; out.lsAfter = lsAfter; out.afterReload = afterReload;
  log({ label: '1440-direct-manipulation', ...out });
});
