// 确认中文界面下：侧栏探索里的条目显示「定时」，主内容区页面标题仍是「定时任务」。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(path.resolve(here, '../pilotdeck-mobile/upstream-official/ui/package.json'))('playwright');

const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:5186/', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => window.localStorage.setItem('userLanguage', 'zh-CN'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.locator('.explore-section .tree-heading button').first().click();
await page.waitForTimeout(400);

console.log(JSON.stringify(await page.evaluate(() => ({
  sidebarRows: [...document.querySelectorAll('.explore-row')].map(r => r.textContent.trim()),
  mainAreaTitle: document.querySelector('main h1, main h2, .main-area-title')?.textContent?.trim() ?? null,
})), null, 2));
await page.screenshot({ path: `${here}/explore-label-zh.png`, clip: { x: 0, y: 400, width: 230, height: 480 } });
await browser.close();
