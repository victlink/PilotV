import { createRequire } from 'node:module';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true, executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome', args: ['--no-sandbox'] });
const out = { errors: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => out.errors.push(e.message));
  await page.goto('http://127.0.0.1:5186/', { waitUntil: 'networkidle', timeout: 60000 });
  // 项目行是 button，左上角 Logo 是 span；改名后两者文本都是 PilotV，必须按角色区分。
  await page.getByRole('button', { name: 'PilotV', exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.getByText('新建 PilotDeck 移动端 PWA 项目', { exact: false }).first().click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '成果', exact: true }).click();
  await page.waitForTimeout(9000);
  out.console = await page.evaluate(() => {
    const doc = document.querySelector('iframe[title="成果台"]')?.contentDocument;
    if (!doc) return { ok: false };
    const vis = sel => { const el = doc.querySelector(sel); if (!el) return null; const s = getComputedStyle(el); return { display: s.display, w: Math.round(el.getBoundingClientRect().width) }; };
    return {
      topbar: vis('.art-topbar'), side: vis('.art-side'), stage: vis('#stage'), anno: vis('.art-anno'),
      toolbarButtons: [...doc.querySelectorAll('.art-toolbar button')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.textContent.trim()),
    };
  });
  out.pane = (await page.locator('[aria-label="当前会话成果"]').innerText()).slice(0, 160);
  out.composer = await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    return ta ? ta.value.slice(0, 120) : 'no-composer';
  });
  await page.screenshot({ path: 'pilotdeck-mobile/review/artifacts/desktop-console.png' });
} finally { await browser.close(); }
console.log(JSON.stringify(out, null, 2).slice(0, 1800));