import { chromium } from '@playwright/test';

const CTX_ID = "62d558eb-0d21-4069-9d06-d84f9e406183";
const EXP_ID = "e8bc4f6f-5477-4c2d-b993-b891d470fef6";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

// Login
await page.goto('http://localhost:3000');
await page.waitForTimeout(1000);
await page.fill('input', 'dev@test.com');
await page.click('button:has-text("Login")');
await page.waitForTimeout(2000);

// Navigate directly to graph visualization
await page.goto(`http://localhost:3000/graph/${CTX_ID}?exploration=${EXP_ID}`);
await page.waitForTimeout(4000);
await page.screenshot({ path: '/tmp/ss_viz_empty.png' });
console.log('Graph page URL:', page.url());

// Inspect what's on the page
const toolbarBtns = await page.$$eval('button', els => 
  els.map(e => ({
    text: e.textContent.trim().replace(/\s+/g,' ').slice(0,40),
    title: e.getAttribute('title') || '',
    aria: e.getAttribute('aria-label') || '',
    cls: (e.getAttribute('class') || '').slice(0, 60)
  })).filter(b => b.text || b.title || b.aria)
);
console.log('Buttons:', JSON.stringify(toolbarBtns, null, 2));

await browser.close();
