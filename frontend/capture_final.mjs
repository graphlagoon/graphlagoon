import { chromium } from '@playwright/test';

const CTX_ID = "74081681-fa59-4d26-9bff-a558ac097da5";
const EXP_ID = "da3aa51f-90e7-4501-8527-a6fbf1a7954a";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

// Login page
await page.goto('http://localhost:3000');
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/final_login.png' });

// Login
await page.fill('input', 'dev@test.com');
await page.click('button:has-text("Login")');
await page.waitForTimeout(2000);

// Graph viz empty state
await page.goto(`http://localhost:3000/graph/${CTX_ID}?exploration=${EXP_ID}`);
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/final_viz_empty.png' });

// Bottom bar crop
await page.screenshot({ path: '/tmp/final_bottombar.png', clip: { x: 0, y: 740, width: 600, height: 110 } });

// Dev generator
await page.goto('http://localhost:3000/dev/generator');
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/final_devgen.png', clip: { x: 0, y: 350, width: 800, height: 300 } });

// Style panel
await page.goto(`http://localhost:3000/graph/${CTX_ID}?exploration=${EXP_ID}`);
await page.waitForTimeout(2000);
await page.click('button:has-text("Style")');
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/final_style.png', clip: { x: 530, y: 50, width: 280, height: 500 } });

await browser.close();
