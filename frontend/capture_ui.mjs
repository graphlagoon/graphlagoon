import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

await page.goto('http://localhost:3000');
await page.waitForTimeout(1500);

const emailInput = await page.$('input');
if (emailInput) {
  await emailInput.fill('dev@test.com');
  await page.click('button');
}
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/ss_main.png' });

const buttons = await page.$$('button');
for (const btn of buttons) {
  const text = (await btn.innerText().catch(() => '')).trim().replace(/\n/g,' ');
  const title = await btn.getAttribute('title').catch(() => '');
  const aria = await btn.getAttribute('aria-label').catch(() => '');
  if (text || title || aria) console.log(`btn: "${text}" title="${title}" aria="${aria}"`);
}

await browser.close();
