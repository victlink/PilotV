// 探针：手机视口下设备设置悬浮窗是否真的盖在侧栏抽屉之上。
import { createRequire } from 'node:module';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');

const base = process.env.BASE_URL || 'http://127.0.0.1:5186/';
const browser = await chromium.launch({ headless: true, executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome', args: ['--no-sandbox'] });
const out = { base };
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  await page.getByLabel('Show sidebar').click({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(900);
  await page.getByLabel('设备设置').click({ timeout: 15000 });
  await page.waitForTimeout(700);

  out.stack = await page.evaluate(() => {
    const describe = node => {
      const style = getComputedStyle(node);
      return {
        tag: node.tagName,
        cls: (node.className || '').toString().slice(0, 64),
        position: style.position,
        zIndex: style.zIndex,
        transform: style.transform === 'none' ? 'none' : 'set',
        filter: style.filter,
        opacity: style.opacity,
      };
    };
    const chain = selector => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const ancestors = [];
      for (let current = node; current && current !== document.documentElement; current = current.parentElement) ancestors.push(describe(current));
      return ancestors;
    };
    return { backdrop: chain('[data-dialog-backdrop]'), drawer: chain('.mobile-sidebar-drawer') };
  });
  // 悬浮窗所在区域的实际落点：抽屉标题栏正上方那个点被谁挡住
  out.hitTest = await page.evaluate(() => {
    const dialog = document.querySelector('.pd-device-settings');
    const rect = dialog.getBoundingClientRect();
    const point = { x: rect.x + 20, y: Math.max(2, rect.y - 30) };
    const top = document.elementFromPoint(point.x, point.y);
    return { point, top: top ? `${top.tagName}.${(top.className || '').toString().slice(0, 60)}` : null, insideDialog: Boolean(top && dialog.contains(top)) };
  });
} finally {
  await browser.close();
}
console.log(JSON.stringify(out, null, 2).slice(0, 3000));
