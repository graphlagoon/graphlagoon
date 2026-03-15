import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

// Login
await page.goto('http://localhost:3000');
await page.waitForTimeout(1000);
const emailInput = await page.$('input');
await emailInput.fill('dev@test.com');
await page.click('button:has-text("Login")');
await page.waitForTimeout(2000);

// Go to DEV generator, generate a small graph
await page.goto('http://localhost:3000/dev/generator');
await page.waitForTimeout(1500);

// Set smaller graph for faster generation
await page.fill('input[type="number"]', '80');
await page.waitForTimeout(300);

// Click generate
const genBtn = await page.$('button:has-text("Generate")');
if (genBtn) await genBtn.click();
await page.waitForTimeout(5000);
await page.screenshot({ path: '/tmp/ss_generated.png' });

// Click "Create Graph Context from this Graph"
const createCtxBtn = await page.$('button:has-text("Create Graph Context")');
if (createCtxBtn) {
  await createCtxBtn.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/ss_after_create_ctx.png' });
}

// Navigate to contexts page
await page.goto('http://localhost:3000/contexts');
await page.waitForTimeout(2000);
await page.screenshot({ path: '/tmp/ss_contexts_with_data.png' });

// Click on the first context
const contextCard = await page.$('.context-card, [class*="card"], a[href*="/graph/"]');
if (contextCard) {
  await contextCard.click();
  await page.waitForTimeout(3000);
}

// Try to find an exploration link
const explLinks = await page.$$eval('a[href*="graph"]', els => els.map(e => e.href));
console.log('Graph links:', explLinks);

await page.screenshot({ path: '/tmp/ss_after_ctx_click.png' });
console.log('Current URL:', page.url());

await browser.close();
