// 侧栏结构探查：打印项目按钮与会话指示器，确认为什么按 sessionId 定位不到。
import { createRequire } from 'node:module';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5186/';
const out = { phases: [] };
const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(4000);
  const snapshot = async label => out.phases.push({
    label,
    ...await page.evaluate(() => ({
      indicators: [...document.querySelectorAll('[data-session-indicator]')].map(e => e.getAttribute('data-session-indicator')).slice(0, 30),
      projectButtons: [...document.querySelectorAll('button.project-expand-button')].map(b => b.textContent.trim().slice(0, 20)),
      convButtons: [...document.querySelectorAll('button.project-conversation, button.chat-row')].map(b => b.textContent.trim().slice(0, 20)).slice(0, 30),
      drawerOpen: !!document.querySelector('button[aria-label="Close sidebar"]'),
    })),
  });
  await page.locator('button[aria-label="Show sidebar"]').click();
  await page.waitForTimeout(1800);
  await snapshot('drawer-open');
  await page.getByRole('button', { name: 'PilotV', exact: true }).first().click();
  await page.waitForTimeout(2000);
  await snapshot('after-project-click');
  const btn = page.locator('button[aria-label="Show sidebar"]');
  if (await btn.isVisible().catch(() => false)) { await btn.click(); await page.waitForTimeout(1800); }
  await snapshot('after-reopen');
} catch (e) { out.failure = String(e).slice(0, 200); }
finally { await browser.close(); }
console.log(JSON.stringify(out, null, 2));