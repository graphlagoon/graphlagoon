import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

await page.goto('http://localhost:3000');
await page.waitForTimeout(1000);

// Login
const emailInput = await page.$('input');
await emailInput.fill('dev@test.com');
await page.click('button:has-text("Login")');
await page.waitForTimeout(2000);

// Screenshot contexts page  
await page.screenshot({ path: '/tmp/ss_contexts.png' });

// Find and navigate to graph viz (try DEV mode link or create a context)
// Check current URL
console.log('URL after login:', page.url());

// Try to navigate directly to the graph view 
await page.goto('http://localhost:3000/graph');
await page.waitForTimeout(3000);
console.log('URL after nav:', page.url());
await page.screenshot({ path: '/tmp/ss_graph_empty.png' });

// Try clicking "Create Context" 
await page.goto('http://localhost:3000');
await page.waitForTimeout(1000);
await page.click('button:has-text("Create Context")').catch(async () => {
  await page.click('button:has-text("Create New")').catch(() => {});
});
await page.waitForTimeout(1000);
await page.screenshot({ path: '/tmp/ss_create_context.png' });

// List all links on the page
const links = await page.$$eval('a', els => els.map(e => ({ href: e.href, text: e.textContent.trim() })));
console.log('Links:', JSON.stringify(links));

await browser.close();
