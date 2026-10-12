// 预置设备验收：全新浏览器档案打开普通首页（不带任何导入链接），
// 确认 devices.json 的设备自动出现；再确认删掉后刷新不会复活。
import { createRequire } from 'node:module';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');

const base = process.env.BASE_URL || 'http://127.0.0.1:5186/';
const out = { base, steps: {}, errors: [] };
const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', e => out.errors.push(e.message));

  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const select = page.getByLabel('选择设备');
  out.steps.options = await select.locator('option').allInnerTexts();

  // 删掉一个预置设备，刷新后应保持删除状态
  await page.evaluate(() => {
    const list = JSON.parse(localStorage.getItem('pilotdeck-device-directory-v1') || '[]');
    localStorage.setItem('pilotdeck-device-directory-v1', JSON.stringify(list.slice(0, 1)));
    localStorage.setItem('pilotdeck-device-directory-hidden-v1', JSON.stringify(['http://100.108.86.109:3001']));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  out.steps.optionsAfterDelete = await page.getByLabel('选择设备').locator('option').allInnerTexts();

  // 手动新增一台，刷新后应保留
  await page.evaluate(() => {
    const list = JSON.parse(localStorage.getItem('pilotdeck-device-directory-v1') || '[]');
    list.push({ name: '手动设备', origin: 'http://10.0.0.9:3001' });
    localStorage.setItem('pilotdeck-device-directory-v1', JSON.stringify(list));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  out.steps.optionsAfterManualAdd = await page.getByLabel('选择设备').locator('option').allInnerTexts();
} finally {
  await browser.close();
}

console.log(JSON.stringify(out, null, 2).slice(0, 1600));