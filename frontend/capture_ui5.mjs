import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

// Login
await page.goto('http://localhost:3000');
await page.waitForTimeout(1000);
await page.fill('input', 'dev@test.com');
await page.click('button:has-text("Login")');
await page.waitForTimeout(2000);

// Go to DEV generator
await page.goto('http://localhost:3000/dev/generator');
await page.waitForTimeout(1500);

// Generate (keep defaults - 500 nodes, just click generate)
await page.click('button:has-text("Generate")');
await page.waitForSelector('text=Graph Generated Successfully', { timeout: 20000 });
await page.waitForTimeout(500);

// Click Create Graph Context
await page.click('button:has-text("Create Graph Context from this Graph")');
await page.waitForTimeout(3000);

console.log('URL after create ctx:', page.url());

// Navigate to contexts
await page.goto('http://localhost:3000/contexts');
await page.waitForTimeout(2000);
await page.screenshot({ path: '/tmp/ss_contexts_filled.png' });

const allBtns = await page.$$eval('button', els => els.map(e => e.textContent.trim()));
console.log('Buttons:', JSON.stringify(allBtns));

// Try clicking on first non-empty button that's not "Create New"
const allLinks = await page.$$eval('a', els => els.map(e => ({ href: e.href, text: e.textContent.trim() })));
console.log('All links:', JSON.stringify(allLinks));

// Look for exploration/view links  
const exploreButtons = await page.$$('button:has-text("Explore"), button:has-text("View"), button:has-text("Open")');
if (exploreButtons.length > 0) {
  await exploreButtons[0].click();
  await page.waitForTimeout(3000);
  console.log('After explore click URL:', page.url());
}

await page.screenshot({ path: '/tmp/ss_contexts_filled2.png' });

await browser.close();
