/* Throwaway UX probe for the Investigations area. Deleted before the review ends. */
import { mkdirSync, writeFileSync } from 'fs';
import { test, expect, type Page } from '../fixtures/test-fixtures';
import { seedInvestigations } from '../helpers/api-mocks';
import { waitForLayoutDone } from '../helpers/graph-hooks';

const OUT = '/tmp/claude-0/-root-graphlagoon/ac2c0ae9-0e80-40c2-a3b1-79ed559aa5da/scratchpad/ux/case';
mkdirSync(OUT, { recursive: true });
const now = new Date().toISOString();
const shot = (page: Page, w: number, surface: string, state: string, full = false) =>
  page.screenshot({ path: `${OUT}/${w}-${surface}-${state}.png`, fullPage: full }).catch(() => undefined);

const LONG140 = 'Suspected mule network spanning two retail banks, three payment processors and a crypto exchange with layered transfers of small amounts'.padEnd(140, ' x').slice(0, 140);
const EMAIL60 = 'maria.fernanda.albuquerque.dos.santos.oliveira@very-long-bank.com'.slice(0, 60);
const NOSPACE100 = 'statement_2026_q3_consolidated_export_from_core_banking_system_with_all_counterparties_v2'.padEnd(100, '_').slice(0, 100);
const SPACE100 = 'Consolidated statement export from the core banking system with every counterparty for the third quarter of 2026'.slice(0, 100);
const NODE60 = 'Companhia Brasileira de Distribuicao e Logistica Integrada SA'.slice(0, 60);
const TAG30 = 'high-priority-regulatory-review'.slice(0, 30);

const baseCase = (id: string, title: string, extra: Record<string, any> = {}) => ({
  id, title, description: null, status: 'analysis', case_type: 'general', fields: {}, tags: ['MED'],
  owner_email: 'e2e@test.com', assignee_email: 'ana@test.com', settings: {}, state: {}, shared_with: [], decisions: [],
  has_write_access: true, can_manage: true, created_at: now, updated_at: now, item_count: 0, suggested_count: 0,
  deadline: { phase: 'analysis', due_at: new Date(Date.now() + 144 * 36e5).toISOString(), hours_left: 144, days_left: 6, total_hours: 2160, urgent: true, overdue: false },
  ...extra,
});
const base = { tags: [], status: 'confirmed', author_kind: 'human', author_email: 'e2e@test.com', provenance: {}, position: 0, accessible: true, pinned: [], created_at: now };
const ref = (id: string, title: string, ctx: string, exp: string, extra: any = {}) => ({ ...base, id, kind: 'graph', subkind: 'exploration_ref', title, context_id: ctx, exploration_id: exp, current_version: 0, ...extra });
const version = (contentType: string, size = 120) => ({ version: 1, sha256: 'a'.repeat(64), size_bytes: size, content_type: contentType, created_by: 'e2e@test.com', author_kind: 'human', has_text: true });
const NAMES = ['Ana Souza', 'Bia Lima', 'Caio Melo', 'Davi Reis', 'Eva Cruz', 'Fabio Nunes', 'Gil Alves', 'Hugo Dias', 'Iara Pinto', 'Joao Rocha', 'Kaio Sales', 'Lia Moura'];
const snap = (prefix: string, n: number, nameOf: (i: number) => string = (i) => NAMES[i % NAMES.length]) => {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, type: i % 3 === 0 ? 'Person' : 'Account', properties: { name: nameOf(i), amount: 100 * (i + 1) } }));
  const edges = Array.from({ length: n - 1 }, (_, i) => ({ id: `e${i + 1}`, source: `${prefix}${i + 1}`, target: `${prefix}${i + 2}`, type: 'TRANSFER', properties: { amount: 500 + i, at: now } }));
  return { exploration: { id: `exp-${prefix}`, title: `Exp ${prefix}`, state: {} }, snapshot: { nodes, edges } };
};

const VOCAB = (roles: string[], tags: string[]) => ({ vocabularies: { roles, tags, link_attributes: ['phone', 'email', 'device_id'] } });
const DECISION = { id: 'd1', outcome: null, outcome_label: 'Keep monitoring', closes_case: false, targets: ['a1@ctx-a'], task_ids: [], rationale: 'Pattern looks like layering (E1).', evidence: [], reviewer_email: null, review: null, decided_by: 'ana@test.com', decided_at: now, hash: 'f'.repeat(56) + '0001beef', closed_at: null };

function populated(id = 'inv-p', extra: Record<string, any> = {}) {
  const c = baseCase(id, 'Mule network · two banks', { settings: VOCAB(['mule', 'victim', 'beneficiary'], ['MED', 'urgent', 'pix']), decisions: [DECISION], ...extra });
  const items = [
    ref('g-a', 'Bank A transfers', 'ctx-a', 'exp-a'),
    ref('g-b', 'Bank B transfers', 'ctx-b', 'exp-b'),
    { ...base, id: 'n-1', kind: 'note', subkind: 'anchored', title: 'Same phone', description: 'Same **phone** as the mule', anchor: { entity_ids: ['a1@ctx-a'] }, current_version: 1, latest: version('text/markdown') },
    { ...base, id: 'n-2', kind: 'note', subkind: 'free', title: 'Call with compliance', description: 'They confirm the alert', current_version: 1, latest: version('text/markdown') },
    { ...base, id: 'd-1', kind: 'document', subkind: 'markdown', title: 'Ring memo', current_version: 1, latest: version('text/markdown'), _text: '# Findings\n- two banks\n- one phone' },
    { ...base, id: 'd-2', kind: 'document', subkind: 'link', title: 'Bank notice', provenance: { url: 'https://example.com/notice' }, current_version: 1, latest: version('text/plain') },
    { ...base, id: 't-1', kind: 'table', subkind: 'result', title: 'Top counterparties', exploration_id: null, context_id: null, current_version: 1, latest: version('application/json'), _content: { columns: ['cpf', 'nome', 'valor'], rows: [['1', 'Ana', 10], ['2', 'Bia', 20]] } },
    { ...base, id: 'q-1', kind: 'query', subkind: 'cypher', title: 'Accounts above 10k', context_id: 'ctx-a', current_version: 1, latest: version('application/json'), query: { language: 'cypher', output: 'table', text: 'MATCH (a:Account) WHERE a.amount > 10000 RETURN a' } },
  ];
  const snapshots = { 'g-a': snap('a', 10), 'g-b': snap('b', 8) };
  const anns = [
    { id: 'tk-1', kind: 'task', targets: [], reason: null, status: 'confirmed', author_kind: 'human', author_email: 'ana@test.com', created_at: now, value: { title: 'Request KYC file from Bank A', state: 'open', assignee_kind: 'human', assignee: 'e2e@test.com', due_at: new Date(Date.now() + 48 * 36e5).toISOString(), action: null, decision_id: 'd1' } },
    { id: 'tk-2', kind: 'task', targets: ['a1@ctx-a'], reason: null, status: 'confirmed', author_kind: 'agent', author_email: 'agent@test.com', created_at: now, value: { title: 'Check device fingerprint', state: 'open', assignee_kind: 'human', assignee: null, due_at: null, action: null, decision_id: null } },
    { id: 'sg-1', kind: 'role', targets: ['a1@ctx-a'], reason: 'Receives from 6 accounts and forwards within 2 minutes', status: 'suggested', author_kind: 'agent', author_email: 'agent@test.com', created_at: now, value: { role: 'mule' } },
    { id: 'sg-2', kind: 'tag', targets: ['a3@ctx-a'], reason: 'Same phone as a1', status: 'suggested', author_kind: 'agent', author_email: 'agent@test.com', created_at: now, value: { tag: 'pix' } },
  ];
  return { c, items, snapshots, anns };
}

function many(id = 'inv-m') {
  const roles = Array.from({ length: 12 }, (_, i) => `role ${i + 1}`);
  const tags = Array.from({ length: 10 }, (_, i) => `tag-${i + 1}`);
  const c = baseCase(id, 'Many sources · stress', { settings: VOCAB(roles, tags), tags });
  const graphs = Array.from({ length: 8 }, (_, i) => ref(`g-${i}`, `Source graph ${i + 1} · bank ${String.fromCharCode(65 + i)}`, `ctx-${i}`, `exp-${i}`));
  const others = Array.from({ length: 30 }, (_, i) => {
    const k = i % 4;
    if (k === 0) return { ...base, id: `n-${i}`, kind: 'note', subkind: 'free', title: `Note ${i}`, description: `Body of note ${i}`, current_version: 1, latest: version('text/markdown'), tags: [tags[i % 10]] };
    if (k === 1) return { ...base, id: `d-${i}`, kind: 'document', subkind: 'markdown', title: `Memo ${i}`, current_version: 1, latest: version('text/markdown'), _text: `# Memo ${i}` };
    if (k === 2) return { ...base, id: `t-${i}`, kind: 'table', subkind: 'result', title: `Table ${i}`, exploration_id: null, context_id: null, current_version: 1, latest: version('application/json'), _content: { columns: ['a'], rows: [[1]] } };
    return { ...base, id: `q-${i}`, kind: 'query', subkind: 'cypher', title: `Query ${i}`, context_id: 'ctx-0', current_version: 1, latest: version('application/json'), query: { language: 'cypher', output: 'table', text: 'MATCH (n) RETURN n' } };
  });
  const snapshots: Record<string, any> = {};
  graphs.forEach((g, i) => { snapshots[g.id] = snap(`s${i}_`, 6); });
  return { c, items: [...graphs, ...others], snapshots };
}

function longNames(id = 'inv-l') {
  const c = baseCase(id, LONG140, { settings: VOCAB(['mule'], [TAG30]), tags: [TAG30], assignee_email: EMAIL60 });
  const items = [
    ref('g-a', NOSPACE100, 'ctx-a', 'exp-a', { tags: [TAG30] }),
    ref('g-b', SPACE100, 'ctx-b', 'exp-b'),
    { ...base, id: 'n-1', kind: 'note', subkind: 'free', title: NOSPACE100, description: NOSPACE100, current_version: 1, latest: version('text/markdown'), tags: [TAG30] },
    { ...base, id: 'd-1', kind: 'document', subkind: 'markdown', title: SPACE100, current_version: 1, latest: version('text/markdown'), _text: '# x' },
  ];
  const snapshots = { 'g-a': snap('a', 6, () => NODE60), 'g-b': snap('b', 4, () => NODE60) };
  return { c, items, snapshots };
}

const queueCases = (n: number) => Array.from({ length: n }, (_, i) => baseCase(`q-${String(i + 1).padStart(2, '0')}`, `Case ${i + 1} · ${['Pix scam', 'Card testing', 'Mule ring', 'Synthetic IDs'][i % 4]}`, {
  status: ['open', 'analysis'][i % 2], suggested_count: i % 5 === 0 ? 2 : 0, item_count: i % 7,
  deadline: i % 3 === 2 ? null : { phase: 'analysis', due_at: now, hours_left: i % 2 ? 4 : 300, days_left: i % 2 ? 0 : 12, total_hours: 2160, urgent: i % 2 === 1, overdue: i % 4 === 1 },
}));

/* ---------- measurement helpers ---------- */
const rect = (page: Page, sel: string) => page.evaluate((s) => {
  const el = document.querySelector(s) as HTMLElement | null;
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom), right: Math.round(b.right) };
}, sel);
const overflow = (page: Page) => page.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const out: string[] = [];
  document.querySelectorAll('body *').forEach((el) => {
    const b = el.getBoundingClientRect();
    if (b.width > 0 && (b.right > w + 1 || b.left < -1)) {
      const e = el as HTMLElement;
      const cls = typeof e.className === 'string' ? e.className.split(' ')[0] : '';
      out.push(`${e.tagName}.${cls}${e.dataset.testid ? '#' + e.dataset.testid : ''}`);
    }
  });
  return { scrollWidth: document.documentElement.scrollWidth, clientWidth: w, overflows: document.documentElement.scrollWidth > w, offenders: out.slice(0, 8) };
});
const clipped = (page: Page, roots: string[]) => page.evaluate((rs) => {
  const out: any[] = [];
  for (const r of rs) {
    const root = document.querySelector(r);
    if (!root) continue;
    root.querySelectorAll('*').forEach((el) => {
      const e = el as HTMLElement;
      const cs = getComputedStyle(e);
      if (e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0 && cs.overflowX !== 'visible') {
        out.push({ root: r, tag: e.tagName, cls: (typeof e.className === 'string' ? e.className : '').slice(0, 40), testid: e.dataset.testid ?? '', scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, overflowX: cs.overflowX, textOverflow: cs.textOverflow, text: (e.textContent ?? '').trim().slice(0, 50) });
      }
    });
  }
  return out.slice(0, 40);
}, roots);
const smallTargets = (page: Page, roots: string[]) => page.evaluate((rs) => {
  const out: any[] = [];
  const seen = new Set<Element>();
  for (const r of rs) {
    document.querySelectorAll(r).forEach((root) => root.querySelectorAll('button, a[href], input, select, textarea, [role=button], [role=tab], [role=menuitem]').forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const e = el as HTMLElement;
      const b = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      if (b.width === 0 || b.height === 0 || cs.visibility === 'hidden') return;
      if (b.width < 24 || b.height < 24) {
        const label = e.dataset.testid || e.getAttribute('aria-label') || e.getAttribute('title') || (e.textContent ?? '').trim().slice(0, 30) || e.getAttribute('placeholder') || e.tagName;
        out.push({ root: r, tag: e.tagName, type: (e as HTMLInputElement).type ?? '', label, w: Math.round(b.width), h: Math.round(b.height) });
      }
    }));
  }
  return out;
}, roots);
const focusInfo = (page: Page) => page.evaluate(() => {
  const e = document.activeElement as HTMLElement | null;
  if (!e) return null;
  const cs = getComputedStyle(e);
  const b = e.getBoundingClientRect();
  return { tag: e.tagName, testid: e.dataset.testid ?? '', text: (e.textContent ?? '').trim().slice(0, 30), aria: e.getAttribute('aria-label') ?? '', outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, boxShadow: cs.boxShadow, visible: b.width > 0 && b.y >= 0 && b.y < innerHeight };
});
const contrast = (page: Page, sels: string[]) => page.evaluate((ss) => {
  const lum = (r: number, g: number, b: number) => { const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const parse = (s: string) => { const m = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
  const bgOf = (el: HTMLElement) => { let e: HTMLElement | null = el; while (e) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.9) return { c, from: e.tagName + '.' + (typeof e.className === 'string' ? e.className.split(' ')[0] : '') }; e = e.parentElement; } return { c: { r: 255, g: 255, b: 255, a: 1 }, from: 'default-white' }; };
  const out: any[] = [];
  for (const s of ss) {
    const els = Array.from(document.querySelectorAll(s)).filter((e) => (e as HTMLElement).offsetParent !== null && (e.textContent ?? '').trim()).slice(0, 4);
    for (const el of els) {
      const e = el as HTMLElement; const cs = getComputedStyle(e); const fg = parse(cs.color); if (!fg) continue;
      const { c: bg, from } = bgOf(e);
      const l1 = lum(fg.r, fg.g, fg.b), l2 = lum(bg.r, bg.g, bg.b);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      out.push({ sel: s, text: (e.textContent ?? '').trim().slice(0, 40), fg: cs.color, bg: `rgb(${bg.r}, ${bg.g}, ${bg.b})`, bgFrom: from, ratio: +ratio.toFixed(2), fontSize: cs.fontSize, fontWeight: cs.fontWeight, pass: ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA-large-only' : 'fail' });
    }
  }
  return out;
}, sels);

async function selectNode(page: Page, id: string) {
  const canvas = page.locator('.graph3d-container canvas').first();
  await waitForLayoutDone(page);
  await expect(async () => {
    const at = await page.evaluate((i) => (window as any).__GRAPH_NODE_SCREEN_COORDS__?.(i), id);
    const box = await canvas.boundingBox();
    expect(at && box).toBeTruthy();
    await page.mouse.move(box!.x + at.x, box!.y + at.y);
    await expect(canvas).toHaveClass(/clickable/, { timeout: 1_000 });
    await page.mouse.down(); await page.mouse.up();
    await expect(page.getByTestId('inspector-title')).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 20_000 });
}

type Notes = Record<string, any>;
async function safe(notes: Notes, key: string, fn: () => Promise<any>) {
  try { notes[key] = (await fn()) ?? 'ok'; } catch (e: any) { notes[key] = `ERROR: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`; }
}
const dump = (w: number, name: string, data: unknown) => writeFileSync(`${OUT}/${w}-${name}.json`, JSON.stringify(data, null, 2));
const fail = (page: Page, re: RegExp, methods: string[] = ['GET']) => page.route(re, (route) => methods.includes(route.request().method()) ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: { error: { code: 'INTERNAL', message: 'boom' } } }) }) : route.fallback());

const WIDTHS: Array<[number, number]> = [[1440, 900], [1024, 700]];

for (const [w, h] of WIDTHS) {
  test.describe(`probe ${w}`, () => {
    test.use({ viewport: { width: w, height: h } });

    test(`queue ${w}`, async ({ authenticatedPage: page }) => {
      const notes: Notes = {};
      await seedInvestigations(page, []);
      await page.goto('/investigations');
      await safe(notes, 'empty', async () => { await expect(page.getByTestId('investigations-empty')).toBeVisible({ timeout: 15_000 }); await shot(page, w, 'queue', 'empty'); return { text: await page.getByTestId('investigations-empty').innerText(), overflow: await overflow(page) }; });

      await seedInvestigations(page, queueCases(8));
      await page.goto('/investigations');
      await safe(notes, 'populated', async () => {
        await expect(page.locator('[data-testid^="investigation-row-"]').first()).toBeVisible({ timeout: 15_000 });
        await shot(page, w, 'queue', 'populated');
        return { overflow: await overflow(page), small: await smallTargets(page, ['[data-testid=investigations-table]', '.queue-filters', 'main', 'header']), tableRect: await rect(page, '[data-testid=investigations-table]'), headerText: await page.locator('[data-testid=investigations-table] thead').innerText().catch(() => '') };
      });

      await seedInvestigations(page, queueCases(60));
      await page.goto('/investigations');
      await safe(notes, 'many', async () => {
        await expect(page.locator('[data-testid^="investigation-row-"]').first()).toBeVisible({ timeout: 15_000 });
        await page.waitForTimeout(500);
        await shot(page, w, 'queue', 'many');
        const pager = await rect(page, '[data-testid=queue-pager]');
        const range = await page.getByTestId('queue-range').innerText().catch(() => '');
        await page.getByTestId('queue-pager').scrollIntoViewIfNeeded().catch(() => undefined);
        await shot(page, w, 'queue', 'many-pager');
        await page.getByTestId('queue-next').click();
        await page.waitForTimeout(800);
        await shot(page, w, 'queue', 'many-page2');
        return { rowsPage1: await page.locator('[data-testid^="investigation-row-"]').count(), pagerRectBeforeScroll: pager, viewportH: h, range, range2: await page.getByTestId('queue-range').innerText().catch(() => ''), url: page.url(), scrollYAfterNext: await page.evaluate(() => scrollY) };
      });

      await seedInvestigations(page, [baseCase('q-long', LONG140, { assignee_email: EMAIL60, tags: [TAG30, 'x'] }), ...queueCases(3)]);
      await page.goto('/investigations');
      await safe(notes, 'long', async () => {
        await expect(page.getByTestId('investigation-row-q-long')).toBeVisible({ timeout: 15_000 });
        await shot(page, w, 'queue', 'long-names');
        return { overflow: await overflow(page), clipped: await clipped(page, ['[data-testid=investigation-row-q-long]']), rowH: await rect(page, '[data-testid=investigation-row-q-long]') };
      });

      await seedInvestigations(page, queueCases(3));
      await fail(page, /\/graphlagoon\/api\/investigations(\?.*)?$/);
      await page.goto('/investigations');
      await safe(notes, 'error', async () => {
        await expect(page.getByTestId('investigations-error')).toBeVisible({ timeout: 15_000 });
        await shot(page, w, 'queue', 'error');
        return { text: await page.getByTestId('investigations-error').innerText(), countersVisible: await page.getByTestId('counter-open').isVisible().catch(() => false) };
      });
      dump(w, 'queue', notes);
    });

    test(`workspace states ${w}`, async ({ authenticatedPage: page }) => {
      const notes: Notes = {};
      const redo = true; // only the save-error states are missing from run 1
if (!redo) {
      // empty
      await seedInvestigations(page, [baseCase('inv-e', 'Empty case', { deadline: null })], {});
      await page.goto('/investigations/inv-e');
      await safe(notes, 'empty', async () => {
        await expect(page.getByTestId('canvas-empty')).toBeVisible({ timeout: 15_000 });
        await shot(page, w, 'workspace', 'empty');
        return { canvasText: await page.getByTestId('canvas-empty').innerText(), itemsEmpty: await page.getByTestId('items-empty').innerText().catch(() => 'n/a'), inspector: await page.getByTestId('canvas-none-selected').innerText().catch(() => 'n/a'), overflow: await overflow(page) };
      });

}
if (!redo) {
      // populated
      const P0 = populated();
      const P = { c: P0.c, items: P0.items, snapshots: P0.snapshots, anns: P0.anns };
      const fresh = () => structuredClone(P0);
      const F0 = fresh(); const seeded = await seedInvestigations(page, [F0.c], { 'inv-p': F0.items }, [], F0.snapshots);
      seeded.annotations.set('inv-p', F0.anns);
      await page.goto('/investigations/inv-p');
      await safe(notes, 'populated', async () => {
        await expect(page.getByTestId('workspace-status')).toContainText('10 nodes', { timeout: 20_000 });
        await waitForLayoutDone(page);
        await shot(page, w, 'workspace', 'populated');
        const header = await page.getByTestId('case-header').innerText().catch(() => '');
        return {
          header, status: await page.getByTestId('workspace-status').innerText(),
          overflow: await overflow(page), graph: await rect(page, '[data-testid=graph-container]'),
          itemsPanel: await rect(page, '[data-testid=case-items-panel]'), inspector: await rect(page, '[data-testid=workspace-inspector]'),
          strip: await rect(page, '[data-testid=case-timeline]'), chips: await rect(page, '[data-testid=case-filter-chips]'), analysisBar: await rect(page, '[data-testid=analysis-bar]'),
          clipped: await clipped(page, ['[data-testid=case-items-panel]', '[data-testid=workspace-inspector]', '[data-testid=case-header]']),
          small: await smallTargets(page, ['[data-testid=case-header]', '[data-testid=case-items-panel]', '[data-testid=workspace-inspector]', '[data-testid=case-filter-chips]', '[data-testid=analysis-bar]', '[data-testid=case-timeline]', '.graph-toolbar', '[data-testid=workspace-status]']),
          stripCollapsedClass: await page.getByTestId('case-timeline').getAttribute('class'),
        };
      });

}
      const P0 = populated();
      const P = { c: P0.c, items: P0.items, snapshots: P0.snapshots, anns: P0.anns };
      const fresh = () => structuredClone(P0);
if (!redo) {
      // many
      const M = many();
      await seedInvestigations(page, [M.c], { 'inv-m': M.items }, [], M.snapshots);
      await page.goto('/investigations/inv-m');
      await safe(notes, 'many', async () => {
        await expect(page.getByTestId('workspace-status')).toContainText('nodes', { timeout: 20_000 });
        await shot(page, w, 'workspace', 'many');
        await page.getByTestId('canvas-all').click().catch(() => undefined);
        await expect(page.getByTestId('workspace-status')).toContainText('8 sources', { timeout: 20_000 }).catch(() => undefined);
        await shot(page, w, 'workspace', 'many-all');
        const chipsOpen = await page.getByTestId('legend-toggle').isVisible().catch(() => false);
        if (chipsOpen) { await page.getByTestId('legend-toggle').click(); await shot(page, w, 'workspace', 'many-legend-menu'); }
        await page.getByTestId('workspace-filters-btn').click().catch(() => undefined);
        await shot(page, w, 'workspace', 'many-filters');
        return {
          status: await page.getByTestId('workspace-status').innerText(), stripOverCanvas: await rect(page, '[data-testid=case-filter-chips]'), legendStrip: await rect(page, '[data-testid=provenance-legend]'), graph: await rect(page, '[data-testid=graph-container]'),
          legendItems: await page.locator('[data-testid^="legend-item-"]').count(), chipsText: await page.getByTestId('case-filter-chips').innerText().catch(() => ''), overflow: await overflow(page),
          clipped: await clipped(page, ['[data-testid=case-items-panel]', '[data-testid=case-filter-chips]']), panelFilters: await rect(page, '[data-testid=panel-filters]'), itemsPanelScrollH: await page.evaluate(() => { const e = document.querySelector('[data-testid=case-items-panel]') as HTMLElement; return e ? { scrollH: e.scrollHeight, clientH: e.clientHeight } : null; }),
        };
      });

}
if (!redo) {
      // long names
      const L = longNames();
      await seedInvestigations(page, [L.c], { 'inv-l': L.items }, [], L.snapshots);
      await page.goto('/investigations/inv-l');
      await safe(notes, 'long', async () => {
        await expect(page.getByTestId('workspace-status')).toContainText('nodes', { timeout: 20_000 });
        await waitForLayoutDone(page);
        await shot(page, w, 'workspace', 'long-names');
        await page.getByTestId('item-n-1').click().catch(() => undefined);
        await shot(page, w, 'workspace', 'long-names-item-selected');
        return { overflow: await overflow(page), clipped: await clipped(page, ['[data-testid=case-items-panel]', '[data-testid=workspace-inspector]', '[data-testid=case-header]', '[data-testid=case-filter-chips]']), header: await rect(page, '[data-testid=case-header]'), titleRect: await rect(page, '[data-testid=investigation-title]'), graph: await rect(page, '[data-testid=graph-container]') };
      });

}
if (!redo) {
      // case load error
      { const F = fresh(); await seedInvestigations(page, [F.c], { 'inv-p': F.items }, [], F.snapshots); }
      await fail(page, /\/graphlagoon\/api\/investigations\/inv-p(\?.*)?$/);
      await page.goto('/investigations/inv-p');
      await safe(notes, 'error-case', async () => {
        await expect(page.getByTestId('case-error')).toBeVisible({ timeout: 15_000 });
        await shot(page, w, 'workspace', 'error-case');
        return { text: await page.getByTestId('case-error').innerText(), retry: await page.getByTestId('case-retry').isVisible().catch(() => false) };
      });
      await page.unroute(/\/graphlagoon\/api\/investigations\/inv-p(\?.*)?$/);

}
if (!redo) {
      // snapshot error on g-b
      const F2 = fresh(); const s2 = await seedInvestigations(page, [F2.c], { 'inv-p': F2.items }, [], F2.snapshots);
      s2.annotations.set('inv-p', F2.anns);
      await fail(page, /\/items\/g-b\/snapshot(\?.*)?$/);
      await page.goto('/investigations/inv-p');
      await safe(notes, 'error-snapshot', async () => {
        await expect(page.getByTestId('workspace-status')).toContainText('nodes', { timeout: 20_000 });
        await page.getByTestId('legend-item-g-b').click();
        await page.waitForTimeout(1500);
        await shot(page, w, 'workspace', 'error-snapshot');
        const errChip = page.getByTestId('legend-error-g-b');
        const itemErr = page.getByTestId('item-error-g-b');
        return { legendErrorVisible: await errChip.isVisible().catch(() => false), legendErrorTitle: await errChip.getAttribute('title').catch(() => null), legendErrorText: await errChip.innerText().catch(() => ''), itemErrorVisible: await itemErr.isVisible().catch(() => false), itemErrorTitle: await itemErr.getAttribute('title').catch(() => null), itemErrorBox: await itemErr.boundingBox().catch(() => null), legendErrorBox: await errChip.boundingBox().catch(() => null), itemErrorText: await itemErr.innerText().catch(() => ''), canvasError: await page.getByTestId('canvas-error').innerText().catch(() => 'none'), status: await page.getByTestId('workspace-status').innerText() };
      });
      await page.unroute(/\/items\/g-b\/snapshot(\?.*)?$/);

}
      // failed save: title + note
      const F3 = fresh(); const s3 = await seedInvestigations(page, [F3.c], { 'inv-p': F3.items }, [], F3.snapshots);
      s3.annotations.set('inv-p', F3.anns);
      await page.goto('/investigations/inv-p');
      await safe(notes, 'error-save-title', async () => {
        await expect(page.getByTestId('workspace-status')).toContainText('10 nodes', { timeout: 20_000 });
        await fail(page, /\/graphlagoon\/api\/investigations\/inv-p(\?.*)?$/, ['PUT', 'PATCH']);
        await page.getByTestId('investigation-title').click();
        await page.getByTestId('case-title-input').fill('Renamed while the server is down');
        await page.getByTestId('case-title-input').press('Enter');
        await page.waitForTimeout(800);
        await shot(page, w, 'workspace', 'error-save-title');
        return { toast: await page.locator('.toast').allInnerTexts(), titleNow: await page.getByTestId('investigation-title').innerText().catch(() => ''), inputStillOpen: await page.getByTestId('case-title-input').isVisible().catch(() => false) };
      });
      await safe(notes, 'error-save-note', async () => {
        await fail(page, /\/graphlagoon\/api\/investigations\/inv-p\/items(\?.*)?$/, ['POST']);
        await selectNode(page, 'a2@ctx-a');
        await page.getByTestId('inspector-notes-tab').click();
        await page.getByTestId('note-input').fill('A note that will not save');
        await page.getByTestId('note-add').click();
        await page.waitForTimeout(800);
        await shot(page, w, 'workspace', 'error-save-note');
        return { toast: await page.locator('.toast').allInnerTexts(), draftKept: await page.getByTestId('note-input').inputValue().catch(() => 'n/a') };
      });

if (!redo) {
      // read-only closed
      const closedCase = { ...populated('inv-c').c, status: 'closed', deadline: null, decisions: [{ ...DECISION, closes_case: true, closed_at: now, outcome_label: 'Closed as a false positive' }] };
      await seedInvestigations(page, [closedCase], { 'inv-c': populated('inv-c').items }, [], P.snapshots);
      await page.goto('/investigations/inv-c');
      await safe(notes, 'readonly-closed', async () => {
        await expect(page.getByTestId('workspace-status')).toContainText('nodes', { timeout: 20_000 });
        await shot(page, w, 'workspace', 'readonly-closed');
        return { banner: await page.getByTestId('case-readonly-banner').innerText().catch(() => 'NO BANNER'), decideVisible: await page.getByTestId('case-decide').isVisible().catch(() => false), addVisible: await page.getByTestId('items-add').isVisible().catch(() => false), reopen: await page.getByTestId('case-reopen').isVisible().catch(() => false), header: await page.getByTestId('case-header').innerText().catch(() => '') };
      });

      // reader share
      const readerCase = { ...populated('inv-r').c, has_write_access: false, can_manage: false, owner_email: 'owner@test.com' };
      await seedInvestigations(page, [readerCase], { 'inv-r': populated('inv-r').items }, [], P.snapshots);
      await page.goto('/investigations/inv-r');
      await safe(notes, 'readonly-reader', async () => {
        await expect(page.getByTestId('workspace-status')).toContainText('nodes', { timeout: 20_000 });
        await shot(page, w, 'workspace', 'readonly-reader');
        await selectNode(page, 'a2@ctx-a').catch(() => undefined);
        await page.getByTestId('inspector-notes-tab').click().catch(() => undefined);
        await shot(page, w, 'workspace', 'readonly-reader-inspector');
        return { banner: await page.getByTestId('case-readonly-banner').innerText().catch(() => 'NO BANNER'), decideVisible: await page.getByTestId('case-decide').isVisible().catch(() => false), addVisible: await page.getByTestId('items-add').isVisible().catch(() => false), shareVisible: await page.getByTestId('case-share').isVisible().catch(() => false), settingsVisible: await page.getByTestId('case-settings-btn').isVisible().catch(() => false), noteInput: await page.getByTestId('note-input').isVisible().catch(() => false), roleDisabled: await page.getByTestId('inspector-role').isDisabled().catch(() => 'n/a'), header: await page.getByTestId('case-header').innerText().catch(() => '') };
      });
}
      dump(w, 'workspace-states2', notes);
    });

    test(`populated interactions ${w}`, async ({ authenticatedPage: page }) => {
      const notes: Notes = {};
      const lite = w === 1440;
      const P0 = populated();
      const P = { c: P0.c, items: P0.items, snapshots: P0.snapshots, anns: P0.anns };
      const fresh = () => structuredClone(P0);
      const F0 = fresh(); const seeded = await seedInvestigations(page, [F0.c], { 'inv-p': F0.items }, [], F0.snapshots);
      seeded.annotations.set('inv-p', F0.anns);
      await page.goto('/investigations/inv-p');
      await expect(page.getByTestId('workspace-status')).toContainText('10 nodes', { timeout: 20_000 });
      await waitForLayoutDone(page);

      const closePanels = async () => {
        for (const id of ['workspace-filters-btn', 'workspace-look-btn', 'workspace-layout-btn', 'workspace-clusters-btn', 'workspace-table-btn']) {
          const b = page.getByTestId(id);
          if (await b.getAttribute('aria-pressed').catch(() => null) === 'true') await b.click().catch(() => undefined);
        }
        await page.keyboard.press('Escape').catch(() => undefined);
      };

      // T1 first screen
      await safe(notes, 'T1', async () => page.evaluate((h) => {
        const ids = ['case-status','case-stage','deadline','workspace-deadline','case-assignee','suggested-badge','case-decide','dossier-link','case-share','case-settings-btn','case-menu','case-brief','brief-text','workspace-status','case-filter-chips','case-timeline','canvas-none-selected','analysis-bar','provenance-legend','canvas-all','investigation-title','case-description'];
        const out: any = {};
        for (const id of ids) {
          const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
          if (!el) { out[id] = 'absent'; continue; }
          const b = el.getBoundingClientRect();
          out[id] = { inViewport: b.width > 0 && b.bottom <= h && b.top >= 0, rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }, text: (el.innerText ?? '').trim().slice(0, 90), title: el.getAttribute('title'), aria: el.getAttribute('aria-label') };
        }
        out.stripTabs = Array.from(document.querySelectorAll('[data-testid^="timeline-tab-"]')).map((e) => (e as HTMLElement).innerText.trim());
        out.header = (document.querySelector('[data-testid=case-header]') as HTMLElement)?.innerText.slice(0, 400);
        return out;
      }, h));

      // panels and canvas rects
      const PANELS = [['workspace-filters-btn', 'panel-filters', 'filters'], ['workspace-look-btn', 'panel-look', 'look'], ['workspace-layout-btn', null, 'layout'], ['workspace-clusters-btn', 'panel-clusters', 'clusters'], ['workspace-table-btn', 'panel-table', 'table']] as const;
      for (const [btn, panel, name] of lite ? PANELS.filter((p) => p[2] === 'layout') : PANELS) {
        await safe(notes, `panel-${name}`, async () => {
          await closePanels();
          const b = page.getByTestId(btn);
          const bb = await b.boundingBox();
          await b.click();
          await page.waitForTimeout(500);
          await shot(page, w, 'workspace', `panel-${name}`);
          const sel = panel ? `[data-testid=${panel}]` : '.layout-panel';
          const pr = await rect(page, sel);
          const ab = await rect(page, '[data-testid=analysis-bar]');
          const titleEl = panel ? page.getByTestId(panel).locator('h3, h2, .panel-title').first() : page.locator('.layout-panel h3, .floating-panel h3').first();
          const closeBtn = panel ? page.getByTestId(panel).locator('button[aria-label*="lose" i], button[title*="lose" i], .close, .panel-close').first() : page.locator('.layout-panel button[aria-label*="lose" i], .layout-panel .close').first();
          const nav = await rect(page, 'nav, header.top-nav, .top-nav, .navbar'); const hdr = await rect(page, '[data-testid=case-header]');
          return { navRect: nav, headerRect: hdr, overlapsHeader: pr && hdr ? pr.y < hdr.bottom : null, btnLabel: await b.innerText().catch(() => ''), btnTitle: await b.getAttribute('title'), btnPressed: await b.getAttribute('aria-pressed'), btnRect: bb, panelRect: pr, graph: await rect(page, '[data-testid=graph-container]'), analysisBar: ab, overlapsAnalysisBar: pr && ab ? pr.bottom > ab.y && pr.y < ab.bottom && pr.x < ab.right && pr.right > ab.x : null, panelTitle: await titleEl.innerText().catch(() => 'NO TITLE'), hasClose: (await closeBtn.count()) > 0, overflow: await overflow(page), small: panel ? await smallTargets(page, [`[data-testid=${panel}]`]) : [] };
        });
      }
      await closePanels();

      // strip tabs
      for (const tab of lite ? [] : ['activity', 'tasks', 'suggestions', 'timeline']) {
        await safe(notes, `strip-${tab}`, async () => {
          await page.getByTestId(`timeline-tab-${tab}`).click();
          await page.waitForTimeout(400);
          await shot(page, w, 'workspace', `strip-${tab}`);
          return { label: await page.getByTestId(`timeline-tab-${tab}`).innerText(), strip: await rect(page, '[data-testid=case-timeline]'), graph: await rect(page, '[data-testid=graph-container]'), body: (await page.locator('[data-testid=case-timeline] .body').innerText().catch(() => '')).slice(0, 400), small: await smallTargets(page, ['[data-testid=case-timeline]']) };
        });
      }
      await safe(notes, 'strip-collapse-persist', async () => {
        await page.getByTestId('timeline-collapse').click();
        const before = await page.getByTestId('case-timeline').getAttribute('class');
        await page.getByTestId('journal-toggle').click().catch(() => undefined);
        await page.waitForTimeout(300);
        await shot(page, w, 'workspace', 'journal-toggle');
        const afterJournal = await page.getByTestId('case-timeline').getAttribute('class');
        await page.getByTestId('timeline-collapse').click();
        const collapsedAgain = await page.getByTestId('case-timeline').getAttribute('class');
        await page.reload();
        await expect(page.getByTestId('workspace-status')).toContainText('10 nodes', { timeout: 20_000 });
        await waitForLayoutDone(page);
        const afterReloadFromCollapsed = await page.getByTestId('case-timeline').getAttribute('class');
        await page.getByTestId('timeline-tab-tasks').click();
        const expanded = await page.getByTestId('case-timeline').getAttribute('class');
        await page.reload();
        await expect(page.getByTestId('workspace-status')).toContainText('10 nodes', { timeout: 20_000 });
        await waitForLayoutDone(page);
        return { afterCollapseClick: before, afterJournalToggle: afterJournal, collapsedAgain, afterReloadFromCollapsed, expandedBeforeReload: expanded, afterReloadFromExpanded: await page.getByTestId('case-timeline').getAttribute('class'), tabAfterReload: await page.locator('[data-testid=case-timeline] .tabs .active, [data-testid=case-timeline] button.active').allInnerTexts().catch(() => []) };
      });

      // node selected + tabs
      if (!lite) await safe(notes, 'node-selected', async () => {
        await selectNode(page, 'a1@ctx-a');
        await page.waitForTimeout(400);
        await shot(page, w, 'workspace', 'node-selected');
        const out: any = { title: await page.getByTestId('inspector-title').innerText(), inspectorText: (await page.getByTestId('workspace-inspector').innerText()).slice(0, 600), small: await smallTargets(page, ['[data-testid=workspace-inspector]']), clipped: await clipped(page, ['[data-testid=workspace-inspector]']) };
        for (const t of ['items', 'enrichment', 'notes', 'origin']) {
          await page.getByTestId(`inspector-${t}-tab`).click();
          await page.waitForTimeout(250);
          await shot(page, w, 'workspace', `node-tab-${t}`);
          out[`tab-${t}`] = (await page.getByTestId('workspace-inspector').innerText()).slice(0, 300);
        }
        return out;
      });

      // T3: note anchored, pin
      if (!lite) await safe(notes, 'T3', async () => {
        await page.getByTestId('inspector-notes-tab').click();
        await shot(page, w, 'workspace', 'notes-add-form');
        const noteBtn = page.getByTestId('note-add');
        const out: any = { addLabel: await noteBtn.innerText(), addDisabledEmpty: await noteBtn.isDisabled(), placeholder: await page.getByTestId('note-input').getAttribute('placeholder'), noteInputRect: await page.getByTestId('note-input').boundingBox(), inViewport: null as any };
        out.inViewport = out.noteInputRect ? out.noteInputRect.y + out.noteInputRect.height <= h : null;
        await page.getByTestId('note-input').fill('Evidence: receives from six accounts within two minutes');
        await noteBtn.click();
        await page.waitForTimeout(700);
        await shot(page, w, 'workspace', 'T3-note-added');
        out.toastAfterAdd = await page.locator('.toast').allInnerTexts();
        out.notesTabLabel = await page.getByTestId('inspector-notes-tab').innerText();
        out.inspectorNotes = (await page.getByTestId('inspector-notes').innerText().catch(() => '')).slice(0, 400);
        out.noteInputAfter = await page.getByTestId('note-input').inputValue();
        // find the new note in material list and pin it
        const noteItems = page.locator('[data-testid^="item-"][data-testid*="item-"]').filter({ hasText: 'Evidence: receives' });
        out.noteItemsInList = await noteItems.count();
        const pinInInspector = page.getByTestId('workspace-inspector').getByTestId('item-pin');
        out.pinInInspectorVisible = await pinInInspector.isVisible().catch(() => false);
        const row = page.locator('[data-testid=case-items-panel] [data-testid^="item-"]').filter({ hasText: 'Evidence: receives' }).first();
        if (await row.count()) {
          await row.click();
          await page.waitForTimeout(400);
          await shot(page, w, 'workspace', 'T3-note-item-selected');
          out.itemDetails = (await page.getByTestId('workspace-inspector').innerText()).slice(0, 500);
          const pin = page.getByTestId('item-pin');
          out.pinVisible = await pin.isVisible().catch(() => false);
          out.pinLabel = await pin.innerText().catch(() => '');
          out.pinTitle = await pin.getAttribute('title').catch(() => null);
          out.pinDisabled = await pin.isDisabled().catch(() => 'n/a');
          out.pinRect = await pin.boundingBox().catch(() => null);
          if (out.pinVisible && !out.pinDisabled) { await pin.click(); await page.waitForTimeout(600); out.toastAfterPin = await page.locator('.toast').allInnerTexts(); await shot(page, w, 'workspace', 'T3-pinned'); out.afterPin = (await page.getByTestId('workspace-inspector').innerText()).slice(0, 400); }
          out.linkControls = await page.getByTestId('workspace-inspector').locator('button, a').allInnerTexts();
        }
        return out;
      });

      // edge selected
      if (!lite) await safe(notes, 'edge-selected', async () => {
        await page.evaluate(() => (window as any).__GRAPH_SELECT_EDGE__('g-a:e1'));
        await page.waitForTimeout(500);
        await shot(page, w, 'workspace', 'edge-selected');
        const out: any = { title: await page.getByTestId('inspector-edge-title').innerText().catch(() => 'NO EDGE TITLE'), text: (await page.getByTestId('workspace-inspector').innerText()).slice(0, 500), small: await smallTargets(page, ['[data-testid=workspace-inspector]']) };
        await page.getByTestId('inspector-edge-notes-tab').click().catch(() => undefined);
        await shot(page, w, 'workspace', 'edge-tab-notes');
        return out;
      });

      // T4: filter and return
      if (!lite) await safe(notes, 'T4', async () => {
        await page.keyboard.press('Escape');
        const chips = page.getByTestId('case-filter-chips');
        const out: any = { chipsText: await chips.innerText().catch(() => ''), chipIds: await page.locator('[data-testid^="chip-"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid)), clearVisibleBefore: await page.getByTestId('chips-clear').isVisible().catch(() => false) };
        // first try a role chip
        const roleChip = page.getByTestId('chip-roles');
        if (await roleChip.count()) {
          await roleChip.click();
          await shot(page, w, 'workspace', 'T4-role-menu');
          out.roleMenu = await page.getByTestId('chip-menu-roles').innerText().catch(() => '');
          const opt = page.locator('[data-testid^="chip-opt-roles-"]').first();
          out.firstOpt = await opt.getAttribute('data-testid');
          if (await opt.count()) { await opt.check(); await page.waitForTimeout(500); }
          await page.keyboard.press('Escape');
          await shot(page, w, 'workspace', 'T4-filtered');
          out.statusFiltered = await page.getByTestId('workspace-status').innerText();
          out.chipsAfter = await chips.innerText();
          out.clearVisibleAfter = await page.getByTestId('chips-clear').isVisible().catch(() => false);
          out.clearLabel = await page.getByTestId('chips-clear').innerText().catch(() => '');
          out.showingOnlyText = await page.locator('text=/Showing only|showing/i').allInnerTexts().catch(() => []);
        }
        // show only on an item
        const only = page.locator('[data-testid^="item-only-"]').first();
        out.showOnlyCount = await page.locator('[data-testid^="item-only-"]').count();
        if (await only.count()) {
          await page.getByTestId('item-g-a').hover().catch(() => undefined);
          out.onlyVisibleOnHover = await only.isVisible().catch(() => false);
          out.onlyTitle = await only.getAttribute('title');
          out.onlyRect = await only.boundingBox();
        }
        if (out.clearVisibleAfter) { await page.getByTestId('chips-clear').click(); await page.waitForTimeout(400); out.statusAfterClear = await page.getByTestId('workspace-status').innerText(); await shot(page, w, 'workspace', 'T4-cleared'); }
        out.viewsChip = await page.getByTestId('chip-views').innerText().catch(() => 'absent');
        return out;
      });

      // Decide mode
      if (!lite) await safe(notes, 'T5-decide', async () => {
        const decide = page.getByTestId('case-decide');
        const out: any = { decideRect: await decide.boundingBox(), decideLabel: await decide.innerText() };
        await decide.click();
        await page.waitForTimeout(500);
        await shot(page, w, 'workspace', 'decide-mode');
        const panel = page.getByTestId('decision-panel');
        out.panelVisible = await panel.isVisible().catch(() => false);
        out.panelText = (await panel.innerText().catch(() => '')).slice(0, 900);
        out.panelRect = await rect(page, '[data-testid=decision-panel]');
        out.formRect = await rect(page, '[data-testid=decision-form]');
        out.recordRect = await page.getByTestId('decision-record').boundingBox();
        out.recordInViewport = out.recordRect ? out.recordRect.y + out.recordRect.height <= h : null;
        out.recordDisabledEmpty = await page.getByTestId('decision-record').isDisabled();
        out.fieldsSmall = await smallTargets(page, ['[data-testid=decision-panel]']);
        out.labels = await panel.locator('label').allInnerTexts().catch(() => []);
        out.escapeCloses = null;
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        out.escapeCloses = !(await panel.isVisible().catch(() => false));
        if (out.escapeCloses) { await decide.click(); await page.waitForTimeout(300); }
        await page.getByTestId('decision-outcome-label').fill('Close as a false positive');
        await page.getByTestId('decision-rationale').fill('Account is a passthrough for payroll, confirmed by the bank (E1).');
        out.recordDisabledAfterFill = await page.getByTestId('decision-record').isDisabled();
        out.ownWordsHint = await page.getByTestId('decision-own-words').innerText().catch(() => 'none');
        out.effectText = await page.getByTestId('decision-effect').innerText().catch(() => '');
        await shot(page, w, 'workspace', 'decide-filled');
        await page.getByTestId('decision-record').click();
        await page.waitForTimeout(400);
        const confirm = page.getByTestId('confirm-dialog-accept');
        out.confirmAsked = await confirm.isVisible().catch(() => false);
        if (out.confirmAsked) { await shot(page, w, 'workspace', 'decide-confirm'); await confirm.click(); }
        await page.waitForTimeout(800);
        await shot(page, w, 'workspace', 'decide-recorded');
        out.toast = await page.locator('.toast').allInnerTexts();
        out.panelAfter = await panel.isVisible().catch(() => false);
        out.inspectorAfter = (await page.getByTestId('workspace-inspector').innerText()).slice(0, 400);
        out.stripJournalLabel = await page.getByTestId('timeline-tab-activity').innerText().catch(() => '');
        out.headerAfter = await page.getByTestId('case-header').innerText();
        return out;
      });

      // settings drawer + add popover + escape
      if (!lite) await safe(notes, 'settings-drawer', async () => {
        await page.getByTestId('case-settings-btn').click();
        await expect(page.getByTestId('case-settings')).toBeVisible();
        await page.waitForTimeout(300);
        await shot(page, w, 'workspace', 'settings-drawer');
        const out: any = { rect: await rect(page, '[data-testid=case-settings]'), title: await page.getByTestId('case-settings').locator('h2, h3').first().innerText().catch(() => 'NO TITLE'), text: (await page.getByTestId('case-settings').innerText()).slice(0, 700), small: await smallTargets(page, ['[data-testid=case-settings]']), focusOnOpen: await focusInfo(page), saveRect: await page.getByTestId('settings-save').boundingBox().catch(() => null) };
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        out.escapeCloses = (await page.getByTestId('case-settings').count()) === 0;
        return out;
      });
      if (!lite) await safe(notes, 'add-popover', async () => {
        await page.getByTestId('items-add').click();
        await expect(page.getByTestId('add-items-popover')).toBeVisible();
        await page.waitForTimeout(400);
        await shot(page, w, 'workspace', 'add-popover');
        const out: any = { rect: await rect(page, '[data-testid=add-items-popover]'), tabs: await page.locator('[data-testid^="add-tab-"]:not([data-testid^="add-tab-panel"])').allInnerTexts(), text: (await page.getByTestId('add-items-popover').innerText()).slice(0, 600), focusOnOpen: await focusInfo(page), small: await smallTargets(page, ['[data-testid=add-items-popover]']) };
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        out.escapeCloses = (await page.getByTestId('add-items-popover').count()) === 0;
        if (!out.escapeCloses) await page.mouse.click(5, h - 5);
        return out;
      });

      dump(w, lite ? 'interactions-lite' : 'interactions', notes);
    });

    test(`dossier ${w}`, async ({ authenticatedPage: page }) => {
      const notes: Notes = {};
      const F = structuredClone(populated());
      const seeded = await seedInvestigations(page, [F.c], { 'inv-p': F.items }, [], F.snapshots);
      seeded.annotations.set('inv-p', F.anns);
      await page.goto('/investigations/inv-p');
      await expect(page.getByTestId('workspace-status')).toContainText('10 nodes', { timeout: 20_000 });
      // dossier
      await safe(notes, 'dossier', async () => {
        await page.getByTestId('dossier-link').click();
        await expect(page.getByTestId('dossier')).toBeVisible({ timeout: 15_000 });
        await page.waitForTimeout(600);
        await shot(page, w, 'dossier', 'top');
        const out: any = { url: page.url(), sections: await page.locator('[data-testid^="dossier-"] h2, [data-testid^="dossier-"] h3').allInnerTexts().catch(() => []), overflow: await overflow(page), toggleLabel: await page.getByTestId('dossier-link').innerText() };
        await page.getByTestId('dossier-exports').scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await shot(page, w, 'dossier', 'decisions-exports');
        out.exports = await page.getByTestId('dossier-exports').locator('button').allInnerTexts();
        out.exportsSmall = await smallTargets(page, ['[data-testid=dossier-exports]', '[data-testid=dossier-decision]']);
        out.decisionText = (await page.getByTestId('dossier-decision').innerText()).slice(0, 800);
        out.reportTemplate = await page.getByTestId('report-template').isVisible().catch(() => false);
        out.draftLabel = await page.getByTestId('report-draft').innerText().catch(() => 'absent');
        const dl = page.waitForEvent('download', { timeout: 5_000 }).catch(() => null);
        await page.getByTestId('export-json').click();
        const d = await dl;
        out.jsonDownload = d ? await d.suggestedFilename() : 'no download event';
        out.toastAfterExport = await page.locator('.toast').allInnerTexts();
        await page.waitForTimeout(400);
        await shot(page, w, 'dossier', 'after-export-json');
        const csv = page.getByTestId('export-csv');
        if (await csv.count()) { const dl2 = page.waitForEvent('download', { timeout: 5_000 }).catch(() => null); await csv.click(); const d2 = await dl2; out.csvDownload = d2 ? await d2.suggestedFilename() : 'no download event'; }
        out.printIntercepted = await page.evaluate(() => { let called = false; (window as any).print = () => { called = true; }; return new Promise<boolean>((r) => { (document.querySelector('[data-testid=export-laudo]') as HTMLElement)?.click(); setTimeout(() => r(called), 500); }); });
        out.toastAfterPrint = await page.locator('.toast').allInnerTexts();
        if (await page.getByTestId('report-draft').count()) {
          await page.getByTestId('report-draft').click();
          await page.waitForTimeout(800);
          out.drafted = await page.getByTestId('report-drafted').innerText().catch(() => 'no report-drafted');
          out.toastAfterDraft = await page.locator('.toast').allInnerTexts();
          await shot(page, w, 'dossier', 'after-draft');
        }
        out.fullPageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        await shot(page, w, 'dossier', 'full', true);
        return out;
      });
      dump(w, 'dossier', notes);
    });
  });
}

test.describe('probe 1440 keyboard, contrast, drag', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('keyboard contrast drag', async ({ authenticatedPage: page }) => {
    const notes: Notes = {};
    const P0 = populated();
      const P = { c: P0.c, items: P0.items, snapshots: P0.snapshots, anns: P0.anns };
      const fresh = () => structuredClone(P0);
    const seeded = await seedInvestigations(page, [P.c], { 'inv-p': P.items }, [], P.snapshots);
    seeded.annotations.set('inv-p', P.anns);
    await page.goto('/investigations/inv-p');
    await expect(page.getByTestId('workspace-status')).toContainText('10 nodes', { timeout: 20_000 });
    await waitForLayoutDone(page);

    await safe(notes, 'tab-walk', async () => {
      const steps: any[] = [];
      await page.mouse.click(2, 2);
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.());
      for (let i = 1; i <= 40; i++) {
        await page.keyboard.press('Tab');
        const f = await focusInfo(page);
        steps.push({ i, ...f });
        if (i === 15) await shot(page, 1440, 'workspace', 'keyboard-tab15');
      }
      const ring = steps.filter((s) => (s.outlineStyle && s.outlineStyle !== 'none' && s.outlineWidth !== '0px') || (s.boxShadow && s.boxShadow !== 'none'));
      return { steps, withVisibleRing: ring.length, total: steps.length, inspectorTabsReached: steps.some((s) => /inspector-.*-tab/.test(s.testid)), stripTabsReached: steps.some((s) => /timeline-tab/.test(s.testid)), focusVisibleRule: await page.evaluate(() => { let n = 0; for (const ss of Array.from(document.styleSheets)) { try { for (const r of Array.from(ss.cssRules)) if ((r as CSSStyleRule).selectorText?.includes('focus-visible')) n++; } catch {} } return n; }) };
    });
    await safe(notes, 'focus-visible-keyboard', async () => {
      // :focus-visible shows only for keyboard focus: check the actual outline right after a Tab onto a header button
      await page.getByTestId('dossier-link').focus();
      await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
      return await focusInfo(page);
    });
    await safe(notes, 'inspector-tabs-keyboard', async () => {
      await selectNode(page, 'a1@ctx-a');
      await page.getByTestId('inspector-title').focus().catch(() => undefined);
      const reached: string[] = [];
      for (let i = 0; i < 25; i++) { await page.keyboard.press('Tab'); const f = await focusInfo(page); if (f?.testid) reached.push(f.testid); if (f?.testid === 'inspector-origin-tab') break; }
      return { reached, tabsHaveRole: await page.getByTestId('inspector-notes-tab').getAttribute('role'), tabsAriaSelected: await page.getByTestId('inspector-notes-tab').getAttribute('aria-selected') };
    });
    await safe(notes, 'escape', async () => {
      const out: any = {};
      await page.getByTestId('case-settings-btn').click(); await expect(page.getByTestId('case-settings')).toBeVisible(); await page.keyboard.press('Escape'); await page.waitForTimeout(200); out.settings = (await page.getByTestId('case-settings').count()) === 0;
      await page.getByTestId('items-add').click(); await expect(page.getByTestId('add-items-popover')).toBeVisible(); await page.keyboard.press('Escape'); await page.waitForTimeout(200); out.addPopover = (await page.getByTestId('add-items-popover').count()) === 0; if (!out.addPopover) await page.mouse.click(5, 895);
      await page.getByTestId('case-decide').click(); await expect(page.getByTestId('decision-panel')).toBeVisible(); await page.keyboard.press('Escape'); await page.waitForTimeout(200); out.decisionPanel = (await page.getByTestId('decision-panel').count()) === 0; if (!out.decisionPanel) await page.getByTestId('decision-cancel').click();
      return out;
    });
    await safe(notes, 'contrast', async () => {
      await selectNode(page, 'a1@ctx-a');
      await page.getByTestId('timeline-tab-tasks').click();
      await page.getByTestId('case-decide').click();
      await page.waitForTimeout(300);
      const res = await contrast(page, ['.muted', '.text-muted', '[data-testid=workspace-status]', '[data-testid=workspace-status] *', '.hint', '.caption', '.meta', 'small', '.deadline', '[data-testid=deadline]', '[data-testid=workspace-deadline]', '.badge', '[data-testid=case-timeline] button', '[data-testid=case-items-panel] .meta', '[data-testid=case-items-panel] .kind', '.group-head', '[data-testid=analysis-bar] button', '.chip', '[data-testid=canvas-none-selected]', '[data-testid=decision-effect]', '[data-testid=case-assignee]', '.panel-caption', '[data-testid=look-caption]']);
      await shot(page, 1440, 'workspace', 'contrast-state');
      await page.getByTestId('decision-cancel').click().catch(() => undefined);
      const ph = await page.evaluate(() => { const out: any[] = []; document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach((e) => { const el = e as HTMLElement; if (el.offsetParent === null) return; const cs = getComputedStyle(el, '::placeholder'); out.push({ ph: el.getAttribute('placeholder'), color: cs.color, bg: getComputedStyle(el).backgroundColor }); }); return out.slice(0, 8); });
      return { text: res, placeholders: ph, tokens: await page.evaluate(() => { const cs = getComputedStyle(document.documentElement); return { muted: cs.getPropertyValue('--color-text-muted'), text: cs.getPropertyValue('--color-text'), surface: cs.getPropertyValue('--color-surface'), bg: cs.getPropertyValue('--color-bg'), secondary: cs.getPropertyValue('--color-text-secondary') }; }) };
    });
    await safe(notes, 'drag', async () => {
      const g0 = await rect(page, '[data-testid=graph-container]');
      const ip0 = await rect(page, '[data-testid=case-items-panel]');
      const cur = async (x: number, y: number) => { await page.mouse.move(x, y); return page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y) as HTMLElement | null; return e ? { tag: e.tagName, cls: (typeof e.className === 'string' ? e.className : '').slice(0, 40), cursor: getComputedStyle(e).cursor, resize: getComputedStyle(e).resize } : null; }, [x, y] as const); };
      const leftBorder = await cur(ip0!.right, ip0!.y + 200);
      await page.mouse.down(); await page.mouse.move(ip0!.right + 80, ip0!.y + 200, { steps: 5 }); await page.mouse.up();
      const ip1 = await rect(page, '[data-testid=case-items-panel]');
      const insp0 = await rect(page, '[data-testid=workspace-inspector]');
      const rightBorder = await cur(insp0!.x, insp0!.y + 200);
      await page.mouse.down(); await page.mouse.move(insp0!.x - 80, insp0!.y + 200, { steps: 5 }); await page.mouse.up();
      const insp1 = await rect(page, '[data-testid=workspace-inspector]');
      await page.getByTestId('workspace-filters-btn').click();
      await page.waitForTimeout(300);
      const p0 = await rect(page, '[data-testid=panel-filters]');
      const panelEdge = await cur(p0!.right, p0!.y + 100);
      await page.mouse.down(); await page.mouse.move(p0!.right + 80, p0!.y + 100, { steps: 5 }); await page.mouse.up();
      const p1 = await rect(page, '[data-testid=panel-filters]');
      const panelHead = await cur(p0!.x + 40, p0!.y + 10);
      await page.mouse.down(); await page.mouse.move(p0!.x + 240, p0!.y + 210, { steps: 5 }); await page.mouse.up();
      const p2 = await rect(page, '[data-testid=panel-filters]');
      const strip = await rect(page, '[data-testid=case-timeline]');
      const stripEdge = await cur(strip!.x + 300, strip!.y);
      await page.mouse.down(); await page.mouse.move(strip!.x + 300, strip!.y - 120, { steps: 5 }); await page.mouse.up();
      const strip1 = await rect(page, '[data-testid=case-timeline]');
      await page.getByTestId('workspace-filters-btn').click();
      const resizables = await page.evaluate(() => Array.from(document.querySelectorAll('*')).filter((e) => { const cs = getComputedStyle(e); return (cs.resize !== 'none' && cs.resize !== '') || (e as HTMLElement).draggable; }).map((e) => `${e.tagName}.${(typeof (e as HTMLElement).className === 'string' ? (e as HTMLElement).className : '').split(' ')[0]}`).slice(0, 12));
      return { graph: g0, leftBorder, itemsBefore: ip0, itemsAfter: ip1, rightBorder, inspBefore: insp0, inspAfter: insp1, panelEdge, panelBefore: p0, panelAfterEdgeDrag: p1, panelHead, panelAfterHeadDrag: p2, stripEdge, stripBefore: strip, stripAfter: strip1, resizables };
    });
    dump(1440, 'keyboard-contrast-drag', notes);
  });
});
