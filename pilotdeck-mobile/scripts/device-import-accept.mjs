// 一次性设备导入验收：在全新浏览器档案里打开带 addDevice 的地址，
// 确认条目落进本浏览器 localStorage、地址栏参数被抹掉、刷新后仍在。
import { createRequire } from 'node:module';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');

const base = process.env.BASE_URL || 'http://127.0.0.1:5186/';
const payload = 'marc-linux-pc|http://100.72.0.111:3001;jx88|http://100.108.86.109:3001';
const url = `${base}?addDevice=${encodeURIComponent(payload)}`;

const out = { url, steps: {}, errors: [] };
const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', e => out.errors.push(e.message));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  out.steps.searchAfterImport = await page.evaluate(() => window.location.search);
  out.steps.stored = await page.evaluate(() => localStorage.getItem('pilotdeck-device-directory-v1'));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  out.steps.storedAfterReload = await page.evaluate(() => localStorage.getItem('pilotdeck-device-directory-v1'));

  // 切换器面板里应能看到两个新设备
  await page.getByText('当前设备', { exact: false }).first().click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200);
  out.steps.panelText = (await page.locator('body').innerText()).slice(0, 200);

  // 再次导入同一批不应产生重复
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  out.steps.storedAfterSecondImport = await page.evaluate(() => localStorage.getItem('pilotdeck-device-directory-v1'));
} finally {
  await browser.close();
}

const parsed = (raw) => (raw ? JSON.parse(raw) : null);
out.steps.count = (parsed(out.steps.storedAfterSecondImport) || []).length;
out.steps.duplicates = (parsed(out.steps.storedAfterSecondImport) || []).map(d => d.origin).filter((o, i, a) => a.indexOf(o) !== i);
console.log(JSON.stringify(out, null, 2).slice(0, 1800));