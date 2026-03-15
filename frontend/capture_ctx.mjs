import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

// Login
await page.goto('http://localhost:3000');
await page.fill('input', 'dev@test.com');
await page.click('button:has-text("Login")');
await page.waitForTimeout(2000);

// Contexts page
await page.goto('http://localhost:3000/contexts');
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/ss_contexts_data.png' });

// Explorations page
await page.goto('http://localhost:3000/explorations');
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/ss_explorations.png' });

// Back to graph viz - screenshot login page
await page.goto('http://localhost:3000');
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/ss_login.png' });

await browser.close();
