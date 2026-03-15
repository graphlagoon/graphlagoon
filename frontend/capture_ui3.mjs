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

// Go to DEV generator
await page.goto('http://localhost:3000/dev/generator');
await page.waitForTimeout(2000);
await page.screenshot({ path: '/tmp/ss_dev_generator.png' });

// Try clicking the generate button
const genBtn = await page.$('button:has-text("Generate")');
if (genBtn) {
  await genBtn.click();
  await page.waitForTimeout(3000);
}
await page.screenshot({ path: '/tmp/ss_after_generate.png' });
console.log('URL:', page.url());

// Check if we're directed somewhere
const links = await page.$$eval('a', els => els.map(e => ({ href: e.href, text: e.textContent.trim() })));
console.log('Links:', JSON.stringify(links));

// Check for graph visualization links
const btns = await page.$$('button');
for (const btn of btns) {
  const text = (await btn.innerText().catch(() => '')).trim();
  if (text) console.log('btn:', text);
}

await browser.close();
