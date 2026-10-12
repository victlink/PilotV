import { createRequire } from 'node:module';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5186/';
const browser = await chromium.launch({ headless: true, executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome', args: ['--no-sandbox'] });
const out = {};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => out.errors = [...(out.errors || []), e.message]);
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  // 项目行是 button，左上角 Logo 是 span；改名后两者文本都是 PilotV，必须按角色区分。
  await page.getByRole('button', { name: 'PilotV', exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.getByText('新建 PilotDeck 移动端 PWA 项目', { exact: false }).first().click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '成果', exact: true }).click();
  await page.waitForTimeout(6000);
  const select = page.locator('#artifacts-header-controls select');
  const options = await select.locator('option').allInnerTexts();

  const pick = async needle => {
    const idx = options.findIndex(t => t.includes(needle));
    await select.selectOption({ index: idx });
    await page.waitForTimeout(7000);
  };

  await pick('HTML 页面');
  out.page = await page.evaluate(() => {
    const doc = document.querySelector('iframe[title="成果台"]').contentDocument;
    const stage = doc.querySelector('#stage');
    return {
      html: stage.innerHTML.slice(0, 400),
      nodes: [...stage.querySelectorAll('*')].slice(0, 8).map(n => n.tagName.toLowerCase() + (n.getAttribute('src') ? ` src=${n.getAttribute('src').slice(0, 90)}` : '')),
    };
  });

  await pick('文本清单');
  out.doc = await page.evaluate(() => {
    const doc = document.querySelector('iframe[title="成果台"]').contentDocument;
    const stage = doc.querySelector('#stage');
    return { html: stage.innerHTML.slice(0, 300), objectCount: stage.querySelectorAll('object').length };
  });

  await pick('三维模型');
  out.model = await page.evaluate(() => {
    const doc = document.querySelector('iframe[title="成果台"]').contentDocument;
    const mv = doc.querySelector('model-viewer');
    const modes = doc.querySelector('#annoModes');
    return {
      cameraControls: mv ? mv.hasAttribute('camera-controls') : null,
      overlayClass: doc.querySelector('.art-overlay')?.className || null,
      annoModes: modes ? [...modes.querySelectorAll('button,[role=radio]')].map(b => `${b.textContent.trim()}:${b.getAttribute('data-mode') || b.dataset.act || ''}${b.className}`) : null,
      stageModes: doc.querySelector('#stageModes') ? [...doc.querySelectorAll('#stageModes button')].map(b => `${b.textContent.trim()}:${b.className}`) : null,
    };
  });
} finally { await browser.close(); }
console.log(JSON.stringify(out, null, 2).slice(0, 2600));