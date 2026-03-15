import { chromium } from '@playwright/test';

const CTX_ID = "74081681-fa59-4d26-9bff-a558ac097da5";
const EXP_ID = "da3aa51f-90e7-4501-8527-a6fbf1a7954a";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

// Login
await page.goto('http://localhost:3000');
await page.waitForTimeout(1000);
await page.fill('input', 'dev@test.com');
await page.click('button:has-text("Login")');
await page.waitForTimeout(2000);

// Navigate to graph visualization
await page.goto(`http://localhost:3000/graph/${CTX_ID}?exploration=${EXP_ID}`);
await page.waitForTimeout(3000);

// Screenshot the empty viz state
await page.screenshot({ path: '/tmp/ss_viz1_empty.png' });

// Click Query button to open query panel
await page.click('button:has-text("Query")');
await page.waitForTimeout(800);
await page.screenshot({ path: '/tmp/ss_viz2_query.png' });

// Close query panel, open Filters
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.click('button:has-text("Filters")');
await page.waitForTimeout(800);
await page.screenshot({ path: '/tmp/ss_viz3_filters.png' });

// Close, open Style 
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.click('button:has-text("Style")');
await page.waitForTimeout(800);
await page.screenshot({ path: '/tmp/ss_viz4_style.png' });

// Close, click Layout bottom button
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.click('button:has-text("Layout")');
await page.waitForTimeout(800);
await page.screenshot({ path: '/tmp/ss_viz5_layout.png' });

// Check bottom bar area
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// Screenshot at 2x zoom of bottom bar
await page.screenshot({ path: '/tmp/ss_viz6_bottombar.png', clip: { x: 0, y: 750, width: 600, height: 150 } });

// Screenshot at 2x zoom of top toolbar
await page.screenshot({ path: '/tmp/ss_viz7_toolbar.png', clip: { x: 0, y: 0, width: 1440, height: 60 } });

await browser.close();
