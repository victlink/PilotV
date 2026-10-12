import { createRequire } from 'node:module';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5186/';
const browser = await chromium.launch({ headless: true, executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome', args: ['--no-sandbox'] });
const out = {};
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  out.headerButtons = await page.evaluate(() => [...document.querySelectorAll('header button, .workspace-header button')].map(b => ({ label: b.getAttribute('aria-label'), title: b.getAttribute('title'), text: b.textContent.trim().slice(0, 12), visible: b.offsetParent !== null })));
  out.allToggles = await page.evaluate(() => [...document.querySelectorAll('button[aria-label]')].map(b => b.getAttribute('aria-label')).slice(0, 20));
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /sidebar|侧|菜单|menu/i.test(b.getAttribute('aria-label') || ''));
    if (!btn) return 'no-button';
    btn.click();
    return btn.getAttribute('aria-label');
  });
  out.clicked = clicked;
  await page.waitForTimeout(2000);
  out.afterClickText = (await page.locator('body').innerText()).slice(0, 200);
  await page.screenshot({ path: 'pilotdeck-mobile/review/artifacts/phone-nav.png' });
} finally { await browser.close(); }
console.log(JSON.stringify(out, null, 2).slice(0, 2000));
