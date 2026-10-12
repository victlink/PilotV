// 手机端成果窗口验收：抽屉要能打开、能选中带成果的会话、选完自动收起，
// 成果主窗口要占满宽度、标注栏不能被挤出屏幕。
import { createRequire } from 'node:module';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5186/';
const out = { base: BASE, errors: [], steps: [] };
const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  page.on('pageerror', e => out.errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(4000);

  // 手机真实流程要点两下抽屉：第一次点项目进项目（抽屉会收起），第二次再打开
  // 才能看到项目下的会话列表。
  const openDrawer = async () => { await page.locator('[aria-label="Show sidebar"], [aria-label="Hide sidebar"]').first().click(); await page.waitForTimeout(1500); };
  await openDrawer();
  await page.locator('button.project-expand-button').filter({ hasText: 'PilotV' }).first().click();
  await page.waitForTimeout(2500);
  await openDrawer();
  await page.screenshot({ path: 'pilotdeck-mobile/review/artifacts/phone-drawer.png' });

  // 会话按钮的可访问名是空的（文本在子节点里被截断），只能按可见性挑
  await page.locator('button.project-conversation:visible').first().click();
  await page.waitForTimeout(3000);

  out.headerOverlap = await page.evaluate(() => {
    // 顶栏里不该再有 Files / Explore 压着 对话/成果
    const stray = [...document.querySelectorAll('.workspace-header .file-entry')]
      .filter(el => getComputedStyle(el).display !== 'none');
    return stray.length;
  });
  out.drawerClosed = await page.evaluate(() => {
    const d = document.querySelector('.mobile-sidebar-drawer');
    return d ? getComputedStyle(d).visibility === 'hidden' : false;
  });
  await page.screenshot({ path: 'pilotdeck-mobile/review/artifacts/phone-after-select.png' });

  await page.getByRole('button', { name: '成果', exact: true }).click();
  await page.waitForTimeout(11000);

  out.layout = await page.evaluate(() => {
    const doc = document.querySelector('iframe[title="成果台"]')?.contentDocument;
    if (!doc) return { ok: false, reason: 'no-iframe', text: document.body.innerText.slice(0, 120) };
    const stage = doc.querySelector('#stage')?.getBoundingClientRect();
    const anno = doc.querySelector('.art-anno')?.getBoundingClientRect();
    const tool = doc.querySelector('.art-bar')?.getBoundingClientRect();
    return {
      ok: true,
      innerWidth,
      stage: stage ? { w: Math.round(stage.width), left: Math.round(stage.left) } : null,
      anno: anno ? { w: Math.round(anno.width), left: Math.round(anno.left) } : null,
      toolbarVisible: tool ? getComputedStyle(doc.querySelector('.art-bar')).display !== 'none' : null,
      consoleOverflow: doc.documentElement.scrollWidth > doc.documentElement.clientWidth + 1,
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  await page.screenshot({ path: 'pilotdeck-mobile/review/artifacts/phone-console-standalone.png' });
} catch (err) {
  out.failure = String(err).slice(0, 200);
} finally {
  await browser.close();
}
console.log(JSON.stringify(out, null, 2).slice(0, 1400));